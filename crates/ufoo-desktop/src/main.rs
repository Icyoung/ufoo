#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::time::{sleep, timeout, Duration, Instant};

struct RuntimePaths {
    node_bin: PathBuf,
    host_script: PathBuf,
    tui_bin: Option<PathBuf>,
}

struct BridgeState {
    tx: AsyncMutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    child: Mutex<Option<Child>>,
    client_ready: AtomicBool,
    exiting: AtomicBool,
}

fn generate_auth_token() -> String {
    let mut bytes = [0u8; 32];
    if let Ok(mut f) = fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut bytes);
    } else {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(1);
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((nanos >> ((i % 16) * 8)) & 0xff) as u8 ^ (i as u8 * 31);
        }
    }
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn find_system_node() -> PathBuf {
    if let Ok(explicit) = std::env::var("UFOO_NODE_EXECUTABLE") {
        let p = PathBuf::from(explicit.trim());
        if p.exists() {
            return p;
        }
    }
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for c in candidates {
        let p = Path::new(c);
        if p.exists() {
            return p.to_path_buf();
        }
    }
    PathBuf::from("node")
}

fn resolve_runtime_paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    if let Ok(res_dir) = app.path().resource_dir() {
        for sub in ["resources/runtime", "runtime"] {
            let rt = res_dir.join(sub);
            let bundled_node = rt.join("bin/node");
            let bundled_script = rt.join("ufoo-core/src/ui/desktopUiHostCli.js");
            if bundled_node.exists() && bundled_script.exists() {
                let bundled_tui = rt.join("bin/ufoo-tui");
                return Ok(RuntimePaths {
                    node_bin: bundled_node,
                    host_script: bundled_script,
                    tui_bin: bundled_tui.exists().then_some(bundled_tui),
                });
            }
        }
    }

    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| "Cannot resolve workspace root".to_string())?;

    let dev_script = workspace_root.join("src/ui/desktopUiHostCli.js");
    if !dev_script.exists() {
        return Err(format!(
            "desktopUiHostCli.js not found at {}",
            dev_script.display()
        ));
    }

    let tui_release = workspace_root.join("target/release/ufoo-tui");
    let tui_dist = workspace_root.join(format!(
        "dist/tui/{}-{}/ufoo-tui",
        std::env::consts::OS,
        match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            other => other,
        }
    ));
    let tui_bin = if tui_release.exists() {
        Some(tui_release)
    } else if tui_dist.exists() {
        Some(tui_dist)
    } else {
        None
    };

    Ok(RuntimePaths {
        node_bin: find_system_node(),
        host_script: dev_script,
        tui_bin,
    })
}

fn emit_connection_event(app: &AppHandle, connected: bool, state: &str, detail: Option<&str>) {
    let mut payload = json!({
        "source": "sidecar",
        "connected": connected,
        "state": state,
    });
    if let Some(msg) = detail {
        if !msg.is_empty() {
            payload["detail"] = json!(msg);
        }
    }
    let _ = app.emit(
        "ufoo://ui-event",
        json!({
            "protocol": "ufoo-ui/1",
            "kind": "event",
            "name": "host.connection",
            "payload": payload,
        }),
    );
}

fn send_resync_request(tx: &mpsc::UnboundedSender<String>) {
    let resync = json!({
        "protocol": "ufoo-ui/1",
        "kind": "command",
        "name": "ui.resync.request",
        "request_id": "webview-ready-resync",
        "payload": {}
    });
    let _ = tx.send(format!("{resync}\n"));
}

async fn cleanup_session(state: &Arc<BridgeState>, sock_path: &Path) {
    {
        let mut tx_guard = state.tx.lock().await;
        *tx_guard = None;
    }
    {
        let mut pending = state.pending.lock().unwrap();
        for (_id, sender) in pending.drain() {
            let _ = sender.send(Err("Desktop UI host reconnecting".to_string()));
        }
    }
    let child_opt = {
        let mut guard = state.child.lock().unwrap();
        guard.take()
    };
    if let Some(mut child) = child_opt {
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
    }
    let _ = fs::remove_file(sock_path);
}

async fn run_ui_host_session(
    app: &AppHandle,
    state: &Arc<BridgeState>,
    generation: u64,
) -> Result<(), String> {
    let paths = resolve_runtime_paths(app)?;
    let token = generate_auth_token();
    let sock_dir = if Path::new("/tmp").exists() {
        PathBuf::from("/tmp")
    } else {
        std::env::temp_dir()
    };
    let sock_path = sock_dir.join(format!("ufoo-dt-{}-{}.sock", std::process::id(), generation));
    let _ = fs::remove_file(&sock_path);

    let mut cmd = TokioCommand::new(&paths.node_bin);
    cmd.arg(&paths.host_script)
        .arg("--ui-socket")
        .arg(&sock_path)
        .env("UFOO_UI_TOKEN", &token)
        .env("UFOO_NODE_EXECUTABLE", &paths.node_bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::inherit());

    if let Some(tui) = &paths.tui_bin {
        cmd.env("UFOO_TUI_BIN", tui);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn desktopUiHost: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing desktopUiHost stdout".to_string())?;

    {
        let mut guard = state.child.lock().unwrap();
        *guard = Some(child);
    }

    let mut stdout_lines = BufReader::new(stdout).lines();
    let ready_line = match timeout(Duration::from_secs(15), stdout_lines.next_line()).await {
        Ok(Ok(Some(line))) => line,
        Ok(Ok(None)) => {
            cleanup_session(state, &sock_path).await;
            return Err("desktopUiHost exited before readiness".to_string());
        }
        Ok(Err(e)) => {
            cleanup_session(state, &sock_path).await;
            return Err(format!("Readiness read error: {e}"));
        }
        Err(_) => {
            cleanup_session(state, &sock_path).await;
            return Err("Timed out waiting for desktopUiHost readiness".to_string());
        }
    };

    let ready_json: Value = match serde_json::from_str(&ready_line) {
        Ok(val) => val,
        Err(e) => {
            cleanup_session(state, &sock_path).await;
            return Err(format!("Invalid readiness JSON ({ready_line}): {e}"));
        }
    };
    let actual_sock = ready_json
        .get("socketPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| sock_path.clone());

    // Keep draining child stdout so pipe never blocks
    tokio::spawn(async move {
        while let Ok(Some(_)) = stdout_lines.next_line().await {}
    });

    let stream = match UnixStream::connect(&actual_sock).await {
        Ok(s) => s,
        Err(e) => {
            cleanup_session(state, &actual_sock).await;
            return Err(format!(
                "Failed to connect UI socket {}: {e}",
                actual_sock.display()
            ));
        }
    };
    let (read_half, mut write_half) = stream.into_split();

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Writer loop
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    // Send ufoo-ui/1 hello handshake BEFORE publishing tx so all commands are strictly ordered after hello.
    let hello = json!({
        "protocol": "ufoo-ui/1",
        "kind": "hello",
        "payload": {
            "auth_token": token,
            "capabilities": [
                "chat",
                "scrollback",
                "prompt",
                "multi-frames-v1",
                "window-modes-v1",
                "markdown-raw-v1",
                "desktop-host-v1"
            ]
        }
    });
    let _ = tx.send(format!("{hello}\n"));

    {
        let mut tx_guard = state.tx.lock().await;
        *tx_guard = Some(tx.clone());
    }

    // If webview already mounted before sidecar connected (or after a sidecar restart),
    // trigger an immediate resync so the UI snaps straight back to Online.
    if state.client_ready.load(Ordering::SeqCst) {
        send_resync_request(&tx);
    }

    emit_connection_event(app, true, "connected", None);

    // Reader loop runs inline until the sidecar closes or crashes.
    let mut reader = BufReader::new(read_half).lines();
    let mut read_err: Option<String> = None;
    loop {
        match reader.next_line().await {
            Ok(Some(line)) => {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(env) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let kind = env.get("kind").and_then(Value::as_str).unwrap_or("");
                let name = env.get("name").and_then(Value::as_str).unwrap_or("");

                if kind == "result" || kind == "error" {
                    if let Some(req_id) = env.get("request_id").and_then(Value::as_str) {
                        let sender = state.pending.lock().unwrap().remove(req_id);
                        if let Some(tx_done) = sender {
                            let payload = env.get("payload").cloned().unwrap_or_else(|| json!({}));
                            if kind == "error" {
                                let msg = payload
                                    .get("error")
                                    .and_then(Value::as_str)
                                    .unwrap_or("UI command failed")
                                    .to_string();
                                let _ = tx_done.send(Err(msg));
                            } else {
                                let _ = tx_done.send(Ok(payload));
                            }
                            continue;
                        }
                    }
                }

                // Bring macOS window forward on incoming CLI -> App handoff
                if name == "handoff.state" {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }

                let _ = app.emit("ufoo://ui-event", env);
            }
            Ok(None) => break,
            Err(err) => {
                read_err = Some(format!("UI host socket read error: {err}"));
                break;
            }
        }
    }

    cleanup_session(state, &actual_sock).await;
    if let Some(err) = read_err {
        return Err(err);
    }
    Ok(())
}

async fn supervise_ui_host_bridge(app: AppHandle, state: Arc<BridgeState>) {
    const BACKOFF_MS: [u64; 4] = [500, 1000, 2000, 5000];
    let mut failure_streak: usize = 0;
    let mut generation: u64 = 0;

    while !state.exiting.load(Ordering::SeqCst) {
        generation = generation.saturating_add(1);
        let started = Instant::now();
        let outcome = run_ui_host_session(&app, &state, generation).await;

        if state.exiting.load(Ordering::SeqCst) {
            break;
        }

        let detail = match &outcome {
            Ok(()) => "Desktop UI host exited unexpectedly; restarting".to_string(),
            Err(err) => err.clone(),
        };
        eprintln!("[Ufoo] sidecar supervisor (gen {generation}): {detail}");

        if started.elapsed() >= Duration::from_secs(5) {
            failure_streak = 0;
        } else {
            failure_streak = (failure_streak + 1).min(BACKOFF_MS.len() - 1);
        }
        let delay_ms = BACKOFF_MS[failure_streak];
        emit_connection_event(&app, false, "reconnecting", Some(&detail));
        sleep(Duration::from_millis(delay_ms)).await;
    }
}

#[tauri::command]
async fn ufoo_send_command(
    state: State<'_, Arc<BridgeState>>,
    name: String,
    request_id: String,
    payload: Value,
) -> Result<Value, String> {
    let tx = {
        let guard = state.tx.lock().await;
        guard
            .clone()
            .ok_or_else(|| "Desktop UI host is reconnecting".to_string())?
    };

    let (done_tx, done_rx) = oneshot::channel();
    {
        state
            .pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), done_tx);
    }

    let envelope = json!({
        "protocol": "ufoo-ui/1",
        "kind": "command",
        "name": name,
        "request_id": request_id,
        "payload": payload,
    });

    if tx.send(format!("{envelope}\n")).is_err() {
        state.pending.lock().unwrap().remove(&request_id);
        return Err("Desktop UI host socket disconnected".to_string());
    }

    match timeout(Duration::from_secs(20), done_rx).await {
        Ok(Ok(res)) => res,
        Ok(Err(_)) => Err("Command response channel closed".to_string()),
        Err(_) => {
            state.pending.lock().unwrap().remove(&request_id);
            Err("Command timed out".to_string())
        }
    }
}

#[tauri::command]
async fn ufoo_client_ready(state: State<'_, Arc<BridgeState>>) -> Result<Value, String> {
    state.client_ready.store(true, Ordering::SeqCst);
    let tx_opt = state.tx.lock().await.clone();
    if let Some(tx) = tx_opt {
        send_resync_request(&tx);
        return Ok(json!({ "ok": true, "connected": true }));
    }
    Ok(json!({ "ok": true, "connected": false }))
}

#[tauri::command]
async fn ufoo_pick_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let output = TokioCommand::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"Select a workspace folder for Ufoo:\")")
            .output()
            .await
            .map_err(|e| format!("Failed to open folder picker: {e}"))?;

        if !output.status.success() {
            return Ok(None);
        }
        let chosen = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if chosen.is_empty() {
            return Ok(None);
        }
        return Ok(Some(chosen));
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[tauri::command]
async fn ufoo_open_project_in_finder(root: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let folder = Path::new(&root);
        if !folder.is_absolute() || !folder.is_dir() {
            return Err("Project folder is unavailable.".to_string());
        }

        let status = TokioCommand::new("/usr/bin/open")
            .args(["-b", "com.apple.finder", "--"])
            .arg(folder)
            .status()
            .await
            .map_err(|error| format!("Could not open project in Finder: {error}"))?;
        if status.success() {
            return Ok(());
        }
        Err("Could not open project in Finder.".to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        Err("Open in Finder is available only on macOS.".to_string())
    }
}

fn build_app_menu(app_handle: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let config = app_handle.config();
    let app_name = config
        .product_name
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Ufoo".to_string());
    let about_metadata = AboutMetadata {
        name: Some(app_name.clone()),
        version: config
            .version
            .clone()
            .or_else(|| Some(app_handle.package_info().version.to_string())),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let window_menu = Submenu::with_id_and_items(
        app_handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app_handle, None)?,
            &PredefinedMenuItem::maximize(app_handle, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app_handle)?,
            &PredefinedMenuItem::close_window(app_handle, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app_handle,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(
                app_handle,
                Some(&format!("About {app_name}")),
                Some(about_metadata.clone()),
            )?,
        ],
    )?;

    Menu::with_items(
        app_handle,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app_handle,
                &app_name,
                true,
                &[
                    &PredefinedMenuItem::about(
                        app_handle,
                        Some(&format!("About {app_name}")),
                        Some(about_metadata),
                    )?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::services(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::hide(app_handle, Some(&format!("Hide {app_name}")))?,
                    &PredefinedMenuItem::hide_others(app_handle, None)?,
                    &PredefinedMenuItem::show_all(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::quit(app_handle, Some(&format!("Quit {app_name}")))?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app_handle,
                "File",
                true,
                &[
                    &PredefinedMenuItem::close_window(app_handle, None)?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app_handle, Some(&format!("Quit {app_name}")))?,
                ],
            )?,
            &Submenu::with_items(
                app_handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app_handle, None)?,
                    &PredefinedMenuItem::redo(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::cut(app_handle, None)?,
                    &PredefinedMenuItem::copy(app_handle, None)?,
                    &PredefinedMenuItem::paste(app_handle, None)?,
                    &PredefinedMenuItem::select_all(app_handle, None)?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app_handle,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app_handle, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

fn main() {
    let bridge_state = Arc::new(BridgeState {
        tx: AsyncMutex::new(None),
        pending: Arc::new(Mutex::new(HashMap::new())),
        child: Mutex::new(None),
        client_ready: AtomicBool::new(false),
        exiting: AtomicBool::new(false),
    });

    let state_for_setup = bridge_state.clone();
    let state_for_exit = bridge_state.clone();

    let app = tauri::Builder::default()
        .menu(build_app_menu)
        .manage(bridge_state)
        .invoke_handler(tauri::generate_handler![
            ufoo_send_command,
            ufoo_client_ready,
            ufoo_pick_folder,
            ufoo_open_project_in_finder,
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                let _ = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::UnderWindowBackground,
                    Some(NSVisualEffectState::Active),
                    Some(12.0),
                );
                let _ = window.show();
                let _ = window.set_focus();
            }

            let handle = app.handle().clone();
            let st = state_for_setup.clone();
            tauri::async_runtime::spawn(async move {
                supervise_ui_host_bridge(handle, st).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ufoo desktop application");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            state_for_exit.exiting.store(true, Ordering::SeqCst);
            let mut guard = state_for_exit.child.lock().unwrap();
            if let Some(mut child) = guard.take() {
                let _ = child.start_kill();
            }
        }
    });
}

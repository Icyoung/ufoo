#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, Command as TokioCommand};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::time::{timeout, Duration};

struct RuntimePaths {
    node_bin: PathBuf,
    host_script: PathBuf,
    tui_bin: Option<PathBuf>,
}

struct BridgeState {
    tx: AsyncMutex<Option<mpsc::UnboundedSender<String>>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
    child: Mutex<Option<Child>>,
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

async fn start_ui_host_bridge(app: AppHandle, state: Arc<BridgeState>) -> Result<(), String> {
    let paths = resolve_runtime_paths(&app)?;
    let token = generate_auth_token();
    let sock_dir = if Path::new("/tmp").exists() {
        PathBuf::from("/tmp")
    } else {
        std::env::temp_dir()
    };
    let sock_path = sock_dir.join(format!("ufoo-dt-{}.sock", std::process::id()));
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
    let ready_line = timeout(Duration::from_secs(15), stdout_lines.next_line())
        .await
        .map_err(|_| "Timed out waiting for desktopUiHost readiness".to_string())?
        .map_err(|e| format!("Readiness read error: {e}"))?
        .ok_or_else(|| "desktopUiHost exited before readiness".to_string())?;

    let ready_json: Value = serde_json::from_str(&ready_line)
        .map_err(|e| format!("Invalid readiness JSON ({ready_line}): {e}"))?;
    let actual_sock = ready_json
        .get("socketPath")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or(sock_path);

    // Keep draining child stdout so pipe never blocks
    tokio::spawn(async move {
        while let Ok(Some(_)) = stdout_lines.next_line().await {}
    });

    let stream = UnixStream::connect(&actual_sock)
        .await
        .map_err(|e| format!("Failed to connect UI socket {}: {e}", actual_sock.display()))?;
    let (read_half, mut write_half) = stream.into_split();

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    {
        let mut tx_guard = state.tx.lock().await;
        *tx_guard = Some(tx.clone());
    }

    // Writer loop
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(line.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    // Send ufoo-ui/1 hello handshake
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

    // Reader loop
    let pending_map = state.pending.clone();
    let app_for_reader = app.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(read_half).lines();
        while let Ok(Some(line)) = reader.next_line().await {
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
                    let sender = pending_map.lock().unwrap().remove(req_id);
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
                if let Some(win) = app_for_reader.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }

            let _ = app_for_reader.emit("ufoo://ui-event", env);
        }
    });

    Ok(())
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
            .ok_or_else(|| "Desktop UI host is still starting".to_string())?
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
    let tx_opt = state.tx.lock().await.clone();
    if let Some(tx) = tx_opt {
        let resync = json!({
            "protocol": "ufoo-ui/1",
            "kind": "command",
            "name": "ui.resync.request",
            "request_id": "webview-ready-resync",
            "payload": {}
        });
        let _ = tx.send(format!("{resync}\n"));
    }
    Ok(json!({ "ok": true }))
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

fn main() {
    let bridge_state = Arc::new(BridgeState {
        tx: AsyncMutex::new(None),
        pending: Arc::new(Mutex::new(HashMap::new())),
        child: Mutex::new(None),
    });

    let state_for_setup = bridge_state.clone();
    let state_for_exit = bridge_state.clone();

    let app = tauri::Builder::default()
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
                if let Err(err) = start_ui_host_bridge(handle.clone(), st).await {
                    eprintln!("[ufoo-desktop] bridge startup error: {err}");
                    let _ = handle.emit(
                        "ufoo://ui-event",
                        json!({
                            "protocol": "ufoo-ui/1",
                            "kind": "event",
                            "name": "status.set",
                            "payload": { "text": err, "busy": false }
                        }),
                    );
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Ufoo desktop application");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            let mut guard = state_for_exit.child.lock().unwrap();
            if let Some(mut child) = guard.take() {
                let _ = child.start_kill();
            }
        }
    });
}

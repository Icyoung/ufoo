//! Pure dispatch: Action → mutate state → Effects (ActionRegistry-style).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;
use std::time::{Duration, Instant};

use crate::action::{Action, Effect};
use crate::model::{
    AgentItem, AppState, CompletionItem, FocusPane, InteractionPrompt, MultiFocus, MultiPaneDesc,
    MultiPaneFrame, ScrollbackEntry,
};
use crate::protocol::Envelope;

/// Exit code: leave alt-screen for Node PTY mirror; host may respawn.
pub const EXIT_SUSPEND: i32 = 75;

pub fn dispatch(state: &mut AppState, action: Action) -> Vec<Effect> {
    let effects = match action {
        Action::Tick => {
            if let Some(pending) = state.pending_delta.as_ref() {
                if !pending.text.is_empty() {
                    state.flush_pending_delta();
                    state.mark_dirty();
                }
            }
            if state.busy {
                state.spinner_ticks = state.spinner_ticks.wrapping_add(1);
                state.mark_dirty();
            }
            if let Some(clear_at) = state.status_clear_at {
                if Instant::now() >= clear_at {
                    state.status = "ready".into();
                    state.busy = false;
                    state.status_started = None;
                    state.status_clear_at = None;
                    state.mark_dirty();
                }
            }
            Vec::new()
        }
        Action::HostDisconnected => {
            state.connected = false;
            state.status = "host disconnected".into();
            state.busy = false;
            state.mark_dirty();
            Vec::new()
        }
        Action::Host(env) => {
            let mut effects = check_seq_gap(state, &env);
            effects.extend(dispatch_host(state, env));
            state.mark_dirty();
            effects
        }
        Action::Key(key) => {
            let effects = dispatch_key(state, key);
            state.mark_dirty();
            effects
        }
        Action::Paste(text) => {
            // Multi-window agent focus: paste raw text into targeted pane.
            if state.multi.active
                && matches!(state.multi.focus, MultiFocus::Agent)
                && !state.multi.focus_agent_id.is_empty()
            {
                let session_id = state.multi.session_id.clone();
                let agent_id = state.multi.focus_agent_id.clone();
                state.mark_dirty();
                return vec![Effect::SendCommand {
                    name: "multi.raw".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({
                        "session_id": session_id,
                        "agent_id": agent_id,
                        "data": text,
                    }),
                }];
            }
            // Ucode: let Node ingest image paths / clipboard, then apply cleaned text.
            if state.surface == "ucode" {
                state.mark_dirty();
                return vec![Effect::SendCommand {
                    name: "input.paste".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "text": text }),
                }];
            }
            for ch in text.chars() {
                if ch == '\r' {
                    continue;
                }
                if ch == '\n' {
                    state.prompt.insert_newline();
                } else {
                    state.prompt.insert_char(ch);
                }
            }
            state.completion_suppressed = None;
            state.mark_dirty();
            maybe_request_completions(state)
        }
        Action::MouseClick { column, row } => {
            // Top project bar: click a chip to switch (global mode).
            if state.show_project_bar() {
                // Project bar is always row 0 of the frame.
                if let Some(index) = crate::draw::project_index_at(
                    state,
                    ratatui::layout::Rect {
                        x: 0,
                        y: 0,
                        width: 200,
                        height: 1,
                    },
                    column,
                    row,
                ) {
                    if let Some(project) = state.projects.get(index).cloned() {
                        state.selected_project = index as isize;
                        state.focus = FocusPane::Input;
                        state.mark_dirty();
                        return vec![Effect::SendCommand {
                            name: "project.switch".into(),
                            request_id: state.alloc_request_id(),
                            payload: json!({
                                "root": project.root,
                                "label": project.label,
                            }),
                        }];
                    }
                }
            }
            Vec::new()
        }
        Action::MouseScroll { lines } => {
            scroll_by(state, lines as isize);
            state.mark_dirty();
            Vec::new()
        }
    };
    effects
}

fn check_seq_gap(state: &mut AppState, env: &Envelope) -> Vec<Effect> {
    let Some(seq) = env.seq else {
        return Vec::new();
    };
    if let Some(last) = state.last_seq {
        if seq > last + 1 {
            state.last_seq = Some(seq);
            return vec![Effect::SendCommand {
                name: "ui.resync.request".into(),
                request_id: state.alloc_request_id(),
                payload: json!({ "reason": "seq_gap", "last_seq": last, "got_seq": seq }),
            }];
        }
    }
    state.last_seq = Some(seq);
    Vec::new()
}

fn dispatch_host(state: &mut AppState, env: Envelope) -> Vec<Effect> {
    match env.kind.as_str() {
        "welcome" => {
            state.connected = true;
            state.status = "ready".into();
            if let Some(version) = env
                .payload
                .get("package_version")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
            {
                state.package_version = version.trim().to_string();
            }
            Vec::new()
        }
        "snapshot" | "event" => apply_named_payload(state, &env.name, &env.payload),
        "result" => {
            if env.name == "input.submit" || env.name == "task.cancel" {
                if env.payload.get("ok") == Some(&json!(false)) {
                    let err = env
                        .payload
                        .get("error")
                        .and_then(|v| v.as_str())
                        .unwrap_or("request failed");
                    state.status = err.to_string();
                    state.busy = false;
                }
            }
            Vec::new()
        }
        "error" => {
            let err = env
                .payload
                .get("error")
                .or_else(|| env.payload.get("errors"))
                .map(|v| v.to_string())
                .unwrap_or_else(|| "host error".into());
            state.status = err;
            state.busy = false;
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn apply_named_payload(
    state: &mut AppState,
    name: &str,
    payload: &serde_json::Value,
) -> Vec<Effect> {
    match name {
        "app.snapshot" => {
            if let Some(status) = payload.get("status").and_then(|v| v.as_str()) {
                state.status = status.to_string();
            }
            if let Some(footer) = payload.get("footer").and_then(|v| v.as_str()) {
                state.footer = footer.to_string();
            }
            if let Some(entries) = payload.get("entries").and_then(|v| v.as_array()) {
                let mapped = entries.iter().filter_map(entry_from_json).collect();
                state.reset_entries(mapped);
            }
            if let Some(history) = payload.get("input_history").and_then(|v| v.as_array()) {
                state.prompt.history = history
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect();
                state.prompt.history_index = None;
                state.prompt.draft_backup = None;
            }
            apply_agents(state, payload);
            if payload.get("settings").is_some()
                || payload.get("launch_mode").is_some()
                || payload.get("mode_options").is_some()
            {
                let settings = payload
                    .get("settings")
                    .cloned()
                    .unwrap_or_else(|| payload.clone());
                state.apply_settings_payload(&settings);
            }
            if let Some(usage) = payload.get("usage").and_then(|v| v.as_str()) {
                state.usage_summary = usage.to_string();
                state.rebuild_footer();
            }
            if let Some(count) = payload.get("attachment_count").and_then(|v| v.as_u64()) {
                state.attachment_count = count as usize;
                state.rebuild_footer();
            }
            if payload.get("global_mode").is_some()
                || payload.get("projects").is_some()
                || payload.get("scope").is_some()
            {
                state.apply_projects_payload(payload);
                state.rebuild_footer();
            }
            if let Some(loop_text) = payload.get("loop_summary").and_then(|v| v.as_str()) {
                state.loop_summary = loop_text.to_string();
                state.rebuild_footer();
            }
            Vec::new()
        }
        "transcript.reset" => {
            state.flush_pending_delta();
            state.reset_entries(Vec::new());
            Vec::new()
        }
        "transcript.append" => {
            state.flush_pending_delta();
            if let Some(entry) =
                entry_from_json(payload).or_else(|| payload.get("entry").and_then(entry_from_json))
            {
                state.append_entry(entry);
            }
            Vec::new()
        }
        "transcript.patch" => {
            state.flush_pending_delta();
            if let Some(id) = payload.get("id").and_then(|v| v.as_str()) {
                if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                    if let Some(entry) = state.entries.iter_mut().find(|e| e.id == id) {
                        entry.text = text.to_string();
                    }
                }
            }
            Vec::new()
        }
        "stream.delta" => {
            let text = payload
                .get("text")
                .or_else(|| payload.get("delta"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("stream");
            let speaker = payload
                .get("speaker")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            state.push_stream_delta(id, speaker, text);
            state.busy = true;
            Vec::new()
        }
        "stream.start" => {
            state.flush_pending_delta();
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("stream")
                .to_string();
            state.append_entry(ScrollbackEntry {
                id,
                kind: "assistant".into(),
                text: String::new(),
                speaker: payload
                    .get("speaker")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                expanded: false,
                detail: String::new(),
            });
            state.busy = true;
            Vec::new()
        }
        "stream.done" => {
            state.flush_pending_delta();
            state.status = "ready".into();
            state.busy = false;
            state.status_started = None;
            state.status_clear_at = None;
            Vec::new()
        }
        "status.set" => {
            if let Some(status) = payload
                .get("text")
                .or_else(|| payload.get("status"))
                .and_then(|v| v.as_str())
            {
                state.status = status.to_string();
            }
            if let Some(busy) = payload.get("busy").and_then(|v| v.as_bool()) {
                state.busy = busy;
                state.status_started = if busy { Some(Instant::now()) } else { None };
            }
            let lower = state.status.to_lowercase();
            let terminal = !state.busy
                && !lower.is_empty()
                && lower != "ready"
                && !lower.contains("waiting")
                && !lower.contains("working")
                && !lower.contains("sending")
                && !lower.contains("cancelling")
                && !lower.contains("generating")
                && !lower.contains("calling");
            if terminal {
                state.status_clear_at = Some(Instant::now() + Duration::from_secs(5));
            } else if state.busy || lower == "ready" {
                state.status_clear_at = None;
            }
            Vec::new()
        }
        "agents.snapshot" | "agents.patch" => {
            apply_agents(state, payload);
            Vec::new()
        }
        "completions.set" => {
            state.completions = payload
                .get("items")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            let label = item.get("label").and_then(|v| v.as_str())?.to_string();
                            let replace = item
                                .get("replace")
                                .and_then(|v| v.as_str())
                                .unwrap_or(label.as_str())
                                .to_string();
                            Some(CompletionItem {
                                label,
                                replace,
                                description: item
                                    .get("description")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string(),
                                has_children: item
                                    .get("hasChildren")
                                    .or_else(|| item.get("has_children"))
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            state.completion_index = 0;
            if state.completions.is_empty() {
                if state.focus == FocusPane::Completions {
                    state.focus = FocusPane::Input;
                }
            } else {
                state.focus = FocusPane::Completions;
            }
            Vec::new()
        }
        "connection.set" => {
            state.connected = payload
                .get("connected")
                .and_then(|v| v.as_bool())
                .unwrap_or(state.connected);
            Vec::new()
        }
        "tool.start" | "tool.result" | "tool.group" => {
            state.flush_pending_delta();
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("tool-{}", state.entries.len()));
            let summary = payload
                .get("summary")
                .or_else(|| payload.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let detail = payload
                .get("detail")
                .or_else(|| payload.get("expanded_text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let display = if !detail.is_empty()
                && !summary.contains("Ctrl+O")
                && (detail.lines().count() > 1
                    || payload.get("count").and_then(|v| v.as_u64()).unwrap_or(0) >= 2)
            {
                format!("{summary} (Ctrl+O expand)")
            } else {
                summary
            };
            if let Some(entry) = state.entries.iter_mut().rev().find(|e| e.id == id) {
                entry.text = display;
                entry.detail = detail;
                entry.kind = "tool".into();
                // Keep expand state unless this is a fresh start without detail yet.
                if entry.detail.is_empty() {
                    entry.expanded = false;
                }
            } else {
                state.append_entry(ScrollbackEntry {
                    id,
                    kind: "tool".into(),
                    text: display,
                    speaker: String::new(),
                    expanded: false,
                    detail,
                });
            }
            Vec::new()
        }
        "plan.set" => {
            let visible = payload
                .get("visible")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            state.plan_summary = payload
                .get("summary")
                .or_else(|| payload.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            state.plan_lines = if !visible {
                Vec::new()
            } else {
                payload
                    .get("lines")
                    .and_then(|v| v.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .filter(|s| !s.trim().is_empty())
                            .take(12)
                            .collect()
                    })
                    .unwrap_or_default()
            };
            if visible && state.plan_lines.is_empty() && !state.plan_summary.is_empty() {
                state.plan_lines = vec![state.plan_summary.clone()];
            }
            Vec::new()
        }
        "settings.snapshot" => {
            state.apply_settings_payload(payload);
            Vec::new()
        }
        "projects.snapshot" => {
            state.apply_projects_payload(payload);
            state.rebuild_footer();
            Vec::new()
        }
        "cron.snapshot" | "loop.set" => {
            state.apply_cron_payload(payload);
            if let Some(text) = payload.get("loop_summary").and_then(|v| v.as_str()) {
                state.loop_summary = text.to_string();
                state.rebuild_footer();
            } else if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                if name == "loop.set" {
                    state.loop_summary = text.to_string();
                    state.rebuild_footer();
                }
            }
            Vec::new()
        }
        "agent.view.open" => {
            state.viewing_agent_id = payload
                .get("agent_id")
                .or_else(|| payload.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            state.viewing_agent_label = payload
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or(state.viewing_agent_id.as_str())
                .to_string();
            state.agent_view_status = payload
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("ready")
                .to_string();
            state.focus = FocusPane::AgentView;
            state.agent_bar_focused = false;
            state.agent_bar_index = state
                .agents
                .iter()
                .position(|a| a.id == state.viewing_agent_id)
                .map(|i| i + 1)
                .unwrap_or(0);
            state.prompt_prefix = "› ".into();
            if let Some(entries) = payload.get("entries").and_then(|v| v.as_array()) {
                let mapped = entries.iter().filter_map(entry_from_json).collect();
                state.reset_entries(mapped);
            }
            state.rebuild_footer();
            Vec::new()
        }
        "agent.view.append" => {
            if let Some(entry) =
                entry_from_json(payload).or_else(|| payload.get("entry").and_then(entry_from_json))
            {
                state.append_entry(entry);
            }
            Vec::new()
        }
        "agent.view.status" => {
            state.agent_view_status = payload
                .get("text")
                .or_else(|| payload.get("status"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Vec::new()
        }
        "agent.view.close" => {
            state.viewing_agent_id.clear();
            state.viewing_agent_label.clear();
            state.agent_view_status.clear();
            state.agent_bar_focused = false;
            state.agent_bar_index = 0;
            if state.focus == FocusPane::AgentView {
                state.focus = FocusPane::Input;
            }
            state.rebuild_footer();
            Vec::new()
        }
        "prompt.set_prefix" => {
            let prefix = payload
                .get("prefix")
                .or_else(|| payload.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("› ");
            state.prompt_prefix = if prefix.is_empty() {
                "› ".into()
            } else {
                prefix.to_string()
            };
            Vec::new()
        }
        "prompt.apply_paste" => {
            let text = payload.get("text").and_then(|v| v.as_str()).unwrap_or("");
            for ch in text.chars() {
                if ch == '\r' {
                    continue;
                }
                if ch == '\n' {
                    state.prompt.insert_newline();
                } else {
                    state.prompt.insert_char(ch);
                }
            }
            state.completion_suppressed = None;
            maybe_request_completions(state)
        }
        "attachments.set" => {
            state.attachment_count =
                payload.get("count").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            state.attachment_labels = payload
                .get("labels")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            if state.attachment_labels.is_empty() && state.attachment_count == 0 {
                state.attachment_labels.clear();
            }
            state.rebuild_footer();
            if let Some(labels) = payload.get("labels").and_then(|v| v.as_array()) {
                let joined = labels
                    .iter()
                    .filter_map(|v| v.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                if !joined.is_empty() {
                    state.status = format!("attached: {joined}");
                }
            }
            Vec::new()
        }
        "usage.set" => {
            state.usage_summary = payload
                .get("text")
                .or_else(|| payload.get("label"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            state.rebuild_footer();
            Vec::new()
        }
        "interaction.request" => {
            let id = payload
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("ask")
                .to_string();
            let prompt = payload
                .get("prompt")
                .or_else(|| payload.get("text"))
                .and_then(|v| v.as_str())
                .unwrap_or("Input required")
                .to_string();
            let lines = payload
                .get("lines")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .filter(|s| !s.trim().is_empty())
                        .take(8)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            state.interaction = Some(InteractionPrompt {
                id,
                prompt: prompt.clone(),
                kind: payload
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ask_user")
                    .to_string(),
                lines,
            });
            state.focus = FocusPane::Interaction;
            state.prompt.clear();
            state.status = "waiting for reply…".into();
            state.busy = false;
            Vec::new()
        }
        "interaction.clear" => {
            state.interaction = None;
            if state.focus == FocusPane::Interaction {
                state.focus = FocusPane::Input;
            }
            state.status = "ready".into();
            Vec::new()
        }
        "ui.suspend.prepare" => {
            state.status = "suspending for PTY…".into();
            state.exit_requested = true;
            vec![Effect::Exit(EXIT_SUSPEND)]
        }
        "ui.resume" => {
            state.status = "resumed".into();
            state.busy = false;
            Vec::new()
        }
        "multi.set" => apply_multi_set(state, payload),
        "multi.pane.frame" => {
            apply_multi_frame(state, payload);
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn apply_multi_set(state: &mut AppState, payload: &serde_json::Value) -> Vec<Effect> {
    let active = payload
        .get("active")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !active {
        state.multi.reset();
        state.mark_dirty();
        return Vec::new();
    }
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let kind = payload
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("multi")
        .to_string();
    let rev = payload.get("rev").and_then(|v| v.as_u64()).unwrap_or(0);
    let panes: Vec<MultiPaneDesc> = payload
        .get("panes")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let agent_id = item
                        .get("agent_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if agent_id.is_empty() {
                        return None;
                    }
                    let label = item
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or(agent_id.as_str())
                        .to_string();
                    let mode = item
                        .get("mode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("socket")
                        .to_string();
                    Some(MultiPaneDesc {
                        agent_id,
                        label,
                        mode,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let previously_active = state.multi.active;
    let prev_pane_ids: Vec<String> = state
        .multi
        .panes
        .iter()
        .map(|p| p.agent_id.clone())
        .collect();
    let next_pane_ids: Vec<String> = panes.iter().map(|p| p.agent_id.clone()).collect();
    let panes_changed = prev_pane_ids != next_pane_ids;

    state.multi.active = true;
    state.multi.kind = if kind == "side" {
        "side".into()
    } else {
        "multi".into()
    };
    state.multi.session_id = session_id;
    state.multi.rev = rev;
    state.multi.panes = panes;
    // Drop frames from stale panes so we do not paint ghosts.
    let live_ids: std::collections::HashSet<String> = state
        .multi
        .panes
        .iter()
        .map(|p| p.agent_id.clone())
        .collect();
    state.multi.frames.retain(|id, _| live_ids.contains(id));

    if !previously_active {
        state.multi.focus = MultiFocus::Chat;
        state.multi.focus_agent_id.clear();
        state.focus = FocusPane::Input;
    } else {
        match state.multi.focus {
            MultiFocus::Agent if !live_ids.contains(&state.multi.focus_agent_id) => {
                state.multi.focus = MultiFocus::Chat;
                state.multi.focus_agent_id.clear();
                state.focus = FocusPane::Input;
            }
            _ => {}
        }
    }
    // Node may request a focus change (e.g. activate agent while multi is on)
    // via payload.focus — apply after membership repair.
    if let Some(focus) = payload.get("focus") {
        let target = focus
            .get("target")
            .and_then(|v| v.as_str())
            .unwrap_or("chat");
        let agent_id = focus
            .get("agent_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if target == "agent" && !agent_id.is_empty() && live_ids.contains(&agent_id) {
            state.multi.suppress_agent_focus_until = None;
            state.multi.focus = MultiFocus::Agent;
            state.multi.focus_agent_id = agent_id;
        } else if target == "chat" {
            state.multi.focus = MultiFocus::Chat;
            state.multi.focus_agent_id.clear();
            state.focus = FocusPane::Input;
        }
    }
    state.mark_dirty();
    // Only request viewport sizing on first enter or when the agent set
    // changes. Re-emitting on every daemon status → syncAgents storm bumps
    // viewport_rev, drops in-flight frames, and makes Ctrl+W feel stuck.
    if !previously_active || panes_changed {
        multi_viewport_effects(state)
    } else {
        Vec::new()
    }
}

fn apply_multi_frame(state: &mut AppState, payload: &serde_json::Value) {
    if !state.multi.active {
        return;
    }
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if session_id != state.multi.session_id {
        return;
    }
    let viewport_rev = payload
        .get("viewport_rev")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if viewport_rev < state.multi.viewport_rev {
        return;
    }
    let agent_id = payload
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if agent_id.is_empty() {
        return;
    }
    let label = payload
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or(agent_id.as_str())
        .to_string();
    let mode = payload
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("socket")
        .to_string();
    let lines: Vec<String> = payload
        .get("lines")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let status = payload
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let input = payload
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    state.multi.frames.insert(
        agent_id.clone(),
        MultiPaneFrame {
            agent_id,
            label,
            mode,
            lines,
            status,
            input,
            viewport_rev,
        },
    );
    state.mark_dirty();
}

/// Layout mirroring paneLayout.js: left ≈ 1/3 chat, right = agent grid.
fn multi_agent_layout(width: u16, height: u16, count: usize) -> Vec<(u16, u16)> {
    // Returns (inner_cols, inner_rows) per pane. Layout must match Rust
    // draw.rs::layout_agent_panes.
    if count == 0 || width < 6 || height < 3 {
        return Vec::new();
    }
    let chat_w = (width / 3).max(1);
    let right_left = chat_w.saturating_add(1);
    let right_w = width.saturating_sub(right_left);
    if right_w < 4 {
        return Vec::new();
    }
    if count == 1 {
        let inner_w = right_w.saturating_sub(2).max(1);
        let inner_h = height.saturating_sub(2).max(1);
        return vec![(inner_w, inner_h)];
    }
    if count == 2 {
        let h1 = height / 2;
        let h2 = height - h1;
        let inner_w = right_w.saturating_sub(2).max(1);
        return vec![
            (inner_w, h1.saturating_sub(2).max(1)),
            (inner_w, h2.saturating_sub(2).max(1)),
        ];
    }
    let rows_ct = ((count + 1) / 2) as u16;
    let row_h = height / rows_ct;
    let mut out = Vec::with_capacity(count);
    let mut placed = 0usize;
    for row in 0..rows_ct {
        let last_row = row == rows_ct - 1;
        let actual_h = if last_row {
            height - row * row_h
        } else {
            row_h
        };
        let remaining = count - placed;
        let odd_first = remaining % 2 == 1 && row == 0 && count % 2 == 1;
        if odd_first {
            let inner_w = right_w.saturating_sub(2).max(1);
            let inner_h = actual_h.saturating_sub(2).max(1);
            out.push((inner_w, inner_h));
            placed += 1;
        } else {
            let half_w = right_w / 2;
            let inner_left = half_w.saturating_sub(2).max(1);
            let inner_right = (right_w - half_w).saturating_sub(3).max(1);
            let inner_h = actual_h.saturating_sub(2).max(1);
            out.push((inner_left, inner_h));
            out.push((inner_right, inner_h));
            placed += 2;
        }
    }
    out
}

/// Public wrapper so the chat loop can trigger a viewport update on Resize
/// events without importing the internal helper.
pub fn multi_viewport_effects_public(state: &mut AppState) -> Vec<Effect> {
    multi_viewport_effects(state)
}

fn multi_viewport_effects(state: &mut AppState) -> Vec<Effect> {
    if !state.multi.active || state.multi.panes.is_empty() {
        return Vec::new();
    }
    let term_cols = if state.multi.term_cols == 0 {
        100
    } else {
        state.multi.term_cols
    };
    let term_rows = if state.multi.term_rows == 0 {
        30
    } else {
        state.multi.term_rows
    };
    // Reserve rows for chrome (project bar + status + prompt + footer + gutters).
    let content_h = term_rows.saturating_sub(6).max(3);
    let sizes = multi_agent_layout(term_cols, content_h, state.multi.panes.len());
    if sizes.is_empty() {
        return Vec::new();
    }
    state.multi.viewport_rev = state.multi.viewport_rev.saturating_add(1);
    let panes: Vec<serde_json::Value> = state
        .multi
        .panes
        .iter()
        .enumerate()
        .filter_map(|(idx, desc)| {
            sizes.get(idx).map(|(cols, rows)| {
                json!({
                    "agent_id": desc.agent_id,
                    "cols": *cols,
                    "rows": *rows,
                })
            })
        })
        .collect();
    let session_id = state.multi.session_id.clone();
    vec![Effect::SendCommand {
        name: "multi.viewport".into(),
        request_id: state.alloc_request_id(),
        payload: json!({
            "session_id": session_id,
            "viewport_rev": state.multi.viewport_rev,
            "panes": panes,
        }),
    }]
}

fn apply_agents(state: &mut AppState, payload: &serde_json::Value) {
    if let Some(agents) = payload.get("agents").and_then(|v| v.as_array()) {
        state.agents = agents
            .iter()
            .filter_map(|a| {
                let id = a
                    .get("id")
                    .or_else(|| a.get("fullId"))
                    .and_then(|v| v.as_str())?
                    .to_string();
                let label = a
                    .get("label")
                    .or_else(|| a.get("nickname"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(id.as_str())
                    .to_string();
                Some(AgentItem {
                    id,
                    label,
                    activity_state: a
                        .get("activity_state")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
            })
            .collect();
        if state.selected_agent >= state.agents.len() as isize {
            state.selected_agent = if state.agents.is_empty() {
                -1
            } else {
                state.agents.len() as isize - 1
            };
        }
    }
    if let Some(footer) = payload.get("footer").and_then(|v| v.as_str()) {
        state.footer = footer.to_string();
    } else {
        state.rebuild_footer();
    }
}

fn entry_from_json(value: &serde_json::Value) -> Option<ScrollbackEntry> {
    let text = value
        .get("text")
        .or_else(|| value.get("content"))
        .and_then(|v| v.as_str())?
        .to_string();
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| format!("e-{}", text.len()));
    Some(ScrollbackEntry {
        id,
        kind: value
            .get("kind")
            .or_else(|| value.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("system")
            .to_string(),
        text,
        speaker: value
            .get("speaker")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        expanded: value
            .get("expanded")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        detail: value
            .get("detail")
            .or_else(|| value.get("expanded_text"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

fn dispatch_key(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    // Multi-window intercepts run before the shared Ctrl+C exit and
    // dashboard routing so /multi can own Ctrl+Q / Ctrl+W and raw keys
    // when agent-focused.
    if state.multi.active {
        if let Some(effects) = dispatch_multi_key(state, key) {
            return effects;
        }
    }

    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
        state.exit_requested = true;
        return vec![
            Effect::SendCommand {
                name: "app.exit".into(),
                request_id: state.alloc_request_id(),
                payload: json!({ "reason": "ctrl-c" }),
            },
            Effect::Exit(0),
        ];
    }

    if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('o') {
        if let Some(entry) = state
            .entries
            .iter_mut()
            .rev()
            .find(|e| e.kind == "tool" && !e.detail.is_empty())
        {
            entry.expanded = !entry.expanded;
        }
        return Vec::new();
    }

    match state.focus {
        FocusPane::Interaction => return dispatch_interaction(state, key),
        FocusPane::Completions => return dispatch_completions(state, key),
        FocusPane::Agents => return dispatch_agents(state, key),
        FocusPane::Mode => return dispatch_mode(state, key),
        FocusPane::Provider => return dispatch_provider(state, key),
        FocusPane::Cron => return dispatch_cron(state, key),
        FocusPane::Projects => return dispatch_projects(state, key),
        FocusPane::AgentView => return dispatch_agent_view(state, key),
        FocusPane::Input => {}
    }

    match key.code {
        KeyCode::Tab => {
            state.focus = next_tab_focus(state);
            if state.focus == FocusPane::Agents
                && state.selected_agent < 0
                && !state.agents.is_empty()
            {
                state.selected_agent = 0;
            }
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Esc => {
            if state.busy {
                state.status = "cancelling…".into();
                return vec![Effect::SendCommand {
                    name: "task.cancel".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({}),
                }];
            }
            // Esc layers (Ink parity): busy cancel → completions → @target →
            // project return / exit. Do NOT wipe the draft.
            if !state.completions.is_empty() {
                state.completions.clear();
                state.completion_suppressed = Some(state.prompt.text.clone());
                state.completion_index = 0;
                return Vec::new();
            }
            if state.prompt_prefix.contains('@') {
                state.prompt_prefix = "› ".into();
                state.selected_agent = -1;
                state.rebuild_footer();
                state.status = "ready".into();
                return vec![Effect::SendCommand {
                    name: "agent.select".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "agent_id": "", "label": "" }),
                }];
            }
            if state.global_mode && state.global_scope == "project" {
                state.status = "returning to global…".into();
                vec![Effect::SendCommand {
                    name: "project.return_controller".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({}),
                }]
            } else if state.prompt.text.is_empty() {
                state.exit_requested = true;
                vec![
                    Effect::SendCommand {
                        name: "app.exit".into(),
                        request_id: state.alloc_request_id(),
                        payload: json!({ "reason": "esc" }),
                    },
                    Effect::Exit(0),
                ]
            } else {
                // Draft preserved — same as Ink onCancel.
                Vec::new()
            }
        }
        KeyCode::Enter
            if key.modifiers.contains(KeyModifiers::ALT)
                || key.modifiers.contains(KeyModifiers::SHIFT) =>
        {
            state.prompt.insert_newline();
            maybe_request_completions(state)
        }
        KeyCode::Enter => {
            // Trailing `\` + Enter continues the line (Ink MultilineInput parity).
            if state.prompt.text.ends_with('\\') {
                state.prompt.backspace();
                state.prompt.insert_newline();
                return maybe_request_completions(state);
            }
            submit_prompt(state)
        }
        KeyCode::Home => {
            state.prompt.move_line_start();
            Vec::new()
        }
        KeyCode::End => {
            state.prompt.move_line_end();
            Vec::new()
        }
        KeyCode::Delete => {
            state.prompt.delete_forward();
            maybe_request_completions(state)
        }
        KeyCode::Backspace => {
            state.prompt.backspace();
            maybe_request_completions(state)
        }
        KeyCode::Left => {
            state.prompt.move_left();
            Vec::new()
        }
        KeyCode::Right => {
            state.prompt.move_right();
            Vec::new()
        }
        KeyCode::Up => {
            if key.modifiers.contains(KeyModifiers::ALT)
                || key.modifiers.contains(KeyModifiers::CONTROL)
            {
                scroll_up(state);
                Vec::new()
            } else if state.wants_completion_query() && !state.completions.is_empty() {
                state.focus = FocusPane::Completions;
                dispatch_completions(state, KeyEvent::new(KeyCode::Up, KeyModifiers::NONE))
            } else if state.prompt.move_up_line() {
                Vec::new()
            } else {
                state.prompt.history_up();
                state.completion_suppressed = Some(state.prompt.text.clone());
                state.completions.clear();
                Vec::new()
            }
        }
        KeyCode::Down => {
            if key.modifiers.contains(KeyModifiers::ALT)
                || key.modifiers.contains(KeyModifiers::CONTROL)
            {
                scroll_down(state);
                Vec::new()
            } else if state.wants_completion_query() && !state.completions.is_empty() {
                state.focus = FocusPane::Completions;
                dispatch_completions(state, KeyEvent::new(KeyCode::Down, KeyModifiers::NONE))
            } else if state.prompt.move_down_line() {
                Vec::new()
            } else if state.prompt.text.is_empty() {
                // Enter dashboard even when agents is empty (Ink: agents row).
                state.focus = FocusPane::Agents;
                if state.selected_agent < 0 && !state.agents.is_empty() {
                    state.selected_agent = 0;
                }
                if state.surface == "ucode" && state.agents.is_empty() {
                    state.prompt.history_down();
                    state.completion_suppressed = Some(state.prompt.text.clone());
                    state.completions.clear();
                    return Vec::new();
                }
                state.rebuild_footer();
                Vec::new()
            } else {
                state.prompt.history_down();
                state.completion_suppressed = Some(state.prompt.text.clone());
                state.completions.clear();
                Vec::new()
            }
        }
        KeyCode::PageUp => {
            for _ in 0..3 {
                scroll_up(state);
            }
            Vec::new()
        }
        KeyCode::PageDown => {
            for _ in 0..3 {
                scroll_down(state);
            }
            Vec::new()
        }
        KeyCode::Char(ch) if key.modifiers.contains(KeyModifiers::CONTROL) => match ch {
            'a' | 'A' => {
                state.prompt.move_line_start();
                Vec::new()
            }
            'e' | 'E' => {
                state.prompt.move_line_end();
                Vec::new()
            }
            'w' | 'W' => {
                state.prompt.kill_word_back();
                maybe_request_completions(state)
            }
            'u' | 'U' => {
                state.prompt.kill_to_line_start();
                maybe_request_completions(state)
            }
            'k' | 'K' => {
                state.prompt.kill_to_line_end();
                maybe_request_completions(state)
            }
            _ => Vec::new(),
        },
        KeyCode::Char(ch) => {
            state.prompt.insert_char(ch);
            state.completion_suppressed = None;
            maybe_request_completions(state)
        }
        _ => Vec::new(),
    }
}

fn dispatch_interaction(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    match key.code {
        KeyCode::Esc => {
            state.interaction = None;
            state.focus = FocusPane::Input;
            state.prompt.clear();
            state.status = "ready".into();
            vec![Effect::SendCommand {
                name: "interaction.respond".into(),
                request_id: state.alloc_request_id(),
                payload: json!({ "cancelled": true }),
            }]
        }
        KeyCode::Enter
            if key.modifiers.contains(KeyModifiers::ALT)
                || key.modifiers.contains(KeyModifiers::SHIFT) =>
        {
            state.prompt.insert_newline();
            Vec::new()
        }
        KeyCode::Enter => {
            let answer = state.prompt.text.clone();
            let id = state
                .interaction
                .as_ref()
                .map(|i| i.id.clone())
                .unwrap_or_default();
            state.interaction = None;
            state.focus = FocusPane::Input;
            state.prompt.clear();
            state.status = "sending answer…".into();
            vec![Effect::SendCommand {
                name: "interaction.respond".into(),
                request_id: state.alloc_request_id(),
                payload: json!({ "id": id, "text": answer }),
            }]
        }
        KeyCode::Backspace => {
            state.prompt.backspace();
            Vec::new()
        }
        KeyCode::Left => {
            state.prompt.move_left();
            Vec::new()
        }
        KeyCode::Right => {
            state.prompt.move_right();
            Vec::new()
        }
        KeyCode::Char(ch) => {
            state.prompt.insert_char(ch);
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn dispatch_completions(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    if state.completions.is_empty() {
        state.focus = FocusPane::Input;
        return dispatch_key(state, key);
    }
    match key.code {
        KeyCode::Esc => {
            state.completions.clear();
            state.focus = FocusPane::Input;
            state.completion_suppressed = Some(state.prompt.text.clone());
            Vec::new()
        }
        KeyCode::Up => {
            if state.completion_index == 0 {
                state.completion_index = state.completions.len() - 1;
            } else {
                state.completion_index -= 1;
            }
            Vec::new()
        }
        KeyCode::Down => {
            state.completion_index = (state.completion_index + 1) % state.completions.len();
            Vec::new()
        }
        KeyCode::Tab => {
            let item = state.completions[state.completion_index].clone();
            state.prompt.set_text(item.replace);
            let has_children = item.has_children;
            state.completions.clear();
            state.focus = FocusPane::Input;
            if has_children {
                maybe_request_completions(state)
            } else {
                Vec::new()
            }
        }
        KeyCode::Enter => {
            let item = state.completions[state.completion_index].clone();
            state.prompt.set_text(item.replace);
            let has_children = item.has_children;
            state.completions.clear();
            state.focus = FocusPane::Input;
            if has_children {
                maybe_request_completions(state)
            } else {
                // Leaf completions (slash / @) run immediately — Ink parity.
                submit_prompt(state)
            }
        }
        KeyCode::Char(ch) => {
            state.focus = FocusPane::Input;
            state.prompt.insert_char(ch);
            state.completion_suppressed = None;
            maybe_request_completions(state)
        }
        KeyCode::Backspace => {
            state.focus = FocusPane::Input;
            state.prompt.backspace();
            maybe_request_completions(state)
        }
        _ => Vec::new(),
    }
}

fn lock_selected_agent(state: &mut AppState) -> Option<Effect> {
    if state.selected_agent < 0 {
        return None;
    }
    let agent = state.agents.get(state.selected_agent as usize)?;
    let id = agent.id.clone();
    let label = agent.label.clone();
    state.prompt_prefix = format!("›@{label} ");
    state.rebuild_footer();
    Some(Effect::SendCommand {
        name: "agent.select".into(),
        request_id: state.alloc_request_id(),
        payload: json!({ "agent_id": id, "label": label }),
    })
}

/// Dashboard stack: projects → agents → cron.
fn dashboard_up(state: &mut AppState) {
    state.focus = match state.focus {
        FocusPane::Cron => {
            if !state.agents.is_empty() {
                if state.selected_agent < 0 {
                    state.selected_agent = 0;
                }
                FocusPane::Agents
            } else if state.show_project_bar() {
                FocusPane::Projects
            } else {
                FocusPane::Input
            }
        }
        FocusPane::Agents => {
            if state.show_project_bar() {
                FocusPane::Projects
            } else {
                FocusPane::Input
            }
        }
        FocusPane::Projects => FocusPane::Input,
        // Mode/provider removed from dashboard; escape to input.
        FocusPane::Mode | FocusPane::Provider => FocusPane::Input,
        _ => FocusPane::Input,
    };
    state.rebuild_footer();
}

fn dashboard_down(state: &mut AppState) {
    if state.surface == "ucode" {
        // Ucode only has agents in the bottom bar.
        if state.focus == FocusPane::Agents || state.focus == FocusPane::Projects {
            state.focus = FocusPane::Input;
            state.rebuild_footer();
        }
        return;
    }
    state.focus = match state.focus {
        FocusPane::Projects => {
            if state.selected_agent < 0 && !state.agents.is_empty() {
                state.selected_agent = 0;
            }
            FocusPane::Agents
        }
        FocusPane::Agents => FocusPane::Cron,
        FocusPane::Cron => FocusPane::Input,
        FocusPane::Mode | FocusPane::Provider => FocusPane::Input,
        _ => state.focus,
    };
    state.rebuild_footer();
}

fn leave_dashboard(state: &mut AppState) {
    state.focus = FocusPane::Input;
    state.rebuild_footer();
}

fn dispatch_agents(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    match key.code {
        KeyCode::Esc => {
            leave_dashboard(state);
            Vec::new()
        }
        KeyCode::Up => {
            dashboard_up(state);
            Vec::new()
        }
        KeyCode::Down => {
            dashboard_down(state);
            Vec::new()
        }
        KeyCode::Tab => {
            state.focus = next_tab_focus(state);
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Left => {
            if state.selected_agent > 0 {
                state.selected_agent -= 1;
            }
            // Live ›@target while browsing (Ink agentSelectionMode).
            if let Some(effect) = lock_selected_agent(state) {
                vec![effect]
            } else {
                state.rebuild_footer();
                Vec::new()
            }
        }
        KeyCode::Right => {
            if state.selected_agent + 1 < state.agents.len() as isize {
                state.selected_agent += 1;
            }
            if let Some(effect) = lock_selected_agent(state) {
                vec![effect]
            } else {
                state.rebuild_footer();
                Vec::new()
            }
        }
        KeyCode::Char('x') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            if state.selected_agent < 0 {
                return Vec::new();
            }
            let Some(agent) = state.agents.get(state.selected_agent as usize).cloned() else {
                return Vec::new();
            };
            // Clear ›@target if it pointed at the closed agent.
            if state.prompt_prefix.contains('@')
                && state.prompt_prefix.contains(agent.label.as_str())
            {
                state.prompt_prefix = "› ".into();
            }
            state.focus = FocusPane::Input;
            state.rebuild_footer();
            vec![
                Effect::SendCommand {
                    name: "agent.select".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "agent_id": "", "label": "" }),
                },
                Effect::SendCommand {
                    name: "agent.close".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "agent_id": agent.id, "label": agent.label }),
                },
            ]
        }
        KeyCode::Enter => {
            // Enter only locks ›@target. Activate is ›@xxx + empty Enter
            // in the prompt (input.submit → tryActivateTargetAgent).
            state.focus = FocusPane::Input;
            let mut effects = Vec::new();
            if let Some(effect) = lock_selected_agent(state) {
                effects.push(effect);
            }
            effects
        }
        KeyCode::Char(ch) => {
            // Typing while browsing agents locks the highlighted ›@target
            // (Ink parity: agentSelectionMode keeps target while drafting).
            state.focus = FocusPane::Input;
            let mut effects = Vec::new();
            if let Some(effect) = lock_selected_agent(state) {
                effects.push(effect);
            }
            state.prompt.insert_char(ch);
            effects.extend(maybe_request_completions(state));
            effects
        }
        _ => Vec::new(),
    }
}

fn next_tab_focus(state: &AppState) -> FocusPane {
    // Global projects live in the top bar.
    // Bottom cycle: agents → cron.
    match state.focus {
        FocusPane::Input => {
            if state.show_project_bar() {
                FocusPane::Projects
            } else {
                FocusPane::Agents
            }
        }
        FocusPane::Projects => FocusPane::Agents,
        FocusPane::Agents => {
            if state.surface != "ucode" {
                FocusPane::Cron
            } else {
                FocusPane::Input
            }
        }
        FocusPane::Cron | FocusPane::Mode | FocusPane::Provider => FocusPane::Input,
        FocusPane::Completions | FocusPane::Interaction | FocusPane::AgentView => FocusPane::Input,
    }
}

fn dispatch_mode(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    match key.code {
        KeyCode::Esc => {
            leave_dashboard(state);
            Vec::new()
        }
        KeyCode::Up => {
            dashboard_up(state);
            Vec::new()
        }
        KeyCode::Down => {
            dashboard_down(state);
            Vec::new()
        }
        KeyCode::Tab => {
            state.focus = next_tab_focus(state);
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Left => {
            if state.selected_mode == 0 {
                state.selected_mode = state.mode_options.len().saturating_sub(1);
            } else {
                state.selected_mode -= 1;
            }
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Right => {
            if state.mode_options.is_empty() {
                return Vec::new();
            }
            state.selected_mode = (state.selected_mode + 1) % state.mode_options.len();
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Enter => {
            let mode = state
                .mode_options
                .get(state.selected_mode)
                .cloned()
                .unwrap_or_else(|| state.launch_mode.clone());
            state.launch_mode = mode.clone();
            state.focus = FocusPane::Input;
            state.rebuild_footer();
            vec![Effect::SendCommand {
                name: "settings.set".into(),
                request_id: state.alloc_request_id(),
                payload: json!({ "launch_mode": mode }),
            }]
        }
        KeyCode::Char(ch) => {
            state.focus = FocusPane::Input;
            state.prompt.insert_char(ch);
            maybe_request_completions(state)
        }
        _ => Vec::new(),
    }
}

fn dispatch_provider(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    match key.code {
        KeyCode::Esc => {
            leave_dashboard(state);
            Vec::new()
        }
        KeyCode::Up => {
            dashboard_up(state);
            Vec::new()
        }
        KeyCode::Down => {
            dashboard_down(state);
            Vec::new()
        }
        KeyCode::Tab => {
            state.focus = next_tab_focus(state);
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Left => {
            if state.selected_provider == 0 {
                state.selected_provider = state.provider_options.len().saturating_sub(1);
            } else {
                state.selected_provider -= 1;
            }
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Right => {
            if state.provider_options.is_empty() {
                return Vec::new();
            }
            state.selected_provider = (state.selected_provider + 1) % state.provider_options.len();
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Enter => {
            let provider = state
                .provider_options
                .get(state.selected_provider)
                .map(|opt| opt.value.clone())
                .unwrap_or_else(|| state.agent_provider.clone());
            state.agent_provider = provider.clone();
            state.focus = FocusPane::Input;
            state.rebuild_footer();
            vec![Effect::SendCommand {
                name: "settings.set".into(),
                request_id: state.alloc_request_id(),
                payload: json!({ "agent_provider": provider }),
            }]
        }
        KeyCode::Char(ch) => {
            state.focus = FocusPane::Input;
            state.prompt.insert_char(ch);
            maybe_request_completions(state)
        }
        _ => Vec::new(),
    }
}

fn dispatch_projects(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    match key.code {
        KeyCode::Esc => {
            leave_dashboard(state);
            Vec::new()
        }
        KeyCode::Up => {
            dashboard_up(state);
            Vec::new()
        }
        KeyCode::Down => {
            dashboard_down(state);
            Vec::new()
        }
        KeyCode::Tab => {
            state.focus = next_tab_focus(state);
            if state.focus == FocusPane::Agents
                && state.selected_agent < 0
                && !state.agents.is_empty()
            {
                state.selected_agent = 0;
            }
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Left => {
            if state.projects.is_empty() {
                return Vec::new();
            }
            if state.selected_project <= 0 {
                state.selected_project = (state.projects.len() as isize) - 1;
            } else {
                state.selected_project -= 1;
            }
            Vec::new()
        }
        KeyCode::Right => {
            if state.projects.is_empty() {
                return Vec::new();
            }
            state.selected_project = (state.selected_project + 1) % state.projects.len() as isize;
            Vec::new()
        }
        KeyCode::Enter => {
            if let Some(project) = state
                .projects
                .get(state.selected_project.max(0) as usize)
                .cloned()
            {
                state.focus = FocusPane::Input;
                state.rebuild_footer();
                return vec![Effect::SendCommand {
                    name: "project.switch".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "root": project.root, "label": project.label }),
                }];
            }
            Vec::new()
        }
        KeyCode::Char('x') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            if let Some(project) = state
                .projects
                .get(state.selected_project.max(0) as usize)
                .cloned()
            {
                return vec![Effect::SendCommand {
                    name: "project.close".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "root": project.root, "label": project.label }),
                }];
            }
            Vec::new()
        }
        KeyCode::Char(ch) => {
            state.focus = FocusPane::Input;
            state.prompt.insert_char(ch);
            maybe_request_completions(state)
        }
        _ => Vec::new(),
    }
}

fn dispatch_cron(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    match key.code {
        KeyCode::Esc => {
            leave_dashboard(state);
            Vec::new()
        }
        KeyCode::Up => {
            dashboard_up(state);
            Vec::new()
        }
        KeyCode::Down => {
            dashboard_down(state);
            Vec::new()
        }
        KeyCode::Tab => {
            state.focus = next_tab_focus(state);
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Left => {
            if state.cron_tasks.is_empty() {
                return Vec::new();
            }
            if state.selected_cron <= 0 {
                state.selected_cron = (state.cron_tasks.len() as isize) - 1;
            } else {
                state.selected_cron -= 1;
            }
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Right => {
            if state.cron_tasks.is_empty() {
                return Vec::new();
            }
            state.selected_cron = (state.selected_cron + 1) % state.cron_tasks.len() as isize;
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Char('x') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            let task = state
                .cron_tasks
                .get(state.selected_cron.max(0) as usize)
                .map(|t| (t.id.clone(), t.label.clone()));
            if let Some((id, label)) = task {
                return vec![Effect::SendCommand {
                    name: "cron.stop".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "id": id, "label": label }),
                }];
            }
            Vec::new()
        }
        KeyCode::Char(ch) => {
            state.focus = FocusPane::Input;
            state.prompt.insert_char(ch);
            maybe_request_completions(state)
        }
        _ => Vec::new(),
    }
}

fn dispatch_agent_view(state: &mut AppState, key: KeyEvent) -> Vec<Effect> {
    let bar_len = state.agents.len() + 1; // index 0 = exit (ufoo)

    if state.agent_bar_focused {
        match key.code {
            KeyCode::Esc => {
                let id = state.viewing_agent_id.clone();
                state.viewing_agent_id.clear();
                state.viewing_agent_label.clear();
                state.agent_view_status.clear();
                state.agent_bar_focused = false;
                state.agent_bar_index = 0;
                state.focus = FocusPane::Input;
                state.rebuild_footer();
                return vec![Effect::SendCommand {
                    name: "agent.view.exit".into(),
                    request_id: state.alloc_request_id(),
                    payload: json!({ "agent_id": id }),
                }];
            }
            KeyCode::Up => {
                state.agent_bar_focused = false;
                state.rebuild_footer();
                return Vec::new();
            }
            KeyCode::Left => {
                if state.agent_bar_index > 0 {
                    state.agent_bar_index -= 1;
                }
                state.rebuild_footer();
                return Vec::new();
            }
            KeyCode::Right => {
                if state.agent_bar_index + 1 < bar_len {
                    state.agent_bar_index += 1;
                }
                state.rebuild_footer();
                return Vec::new();
            }
            KeyCode::Enter => {
                if state.agent_bar_index == 0 {
                    let id = state.viewing_agent_id.clone();
                    state.viewing_agent_id.clear();
                    state.viewing_agent_label.clear();
                    state.agent_view_status.clear();
                    state.agent_bar_focused = false;
                    state.focus = FocusPane::Input;
                    state.rebuild_footer();
                    return vec![Effect::SendCommand {
                        name: "agent.view.exit".into(),
                        request_id: state.alloc_request_id(),
                        payload: json!({ "agent_id": id }),
                    }];
                }
                let agent_idx = state.agent_bar_index.saturating_sub(1);
                if let Some(agent) = state.agents.get(agent_idx).cloned() {
                    if agent.id == state.viewing_agent_id {
                        state.agent_bar_focused = false;
                        state.rebuild_footer();
                        return Vec::new();
                    }
                    state.agent_bar_focused = false;
                    state.rebuild_footer();
                    return vec![
                        Effect::SendCommand {
                            name: "agent.select".into(),
                            request_id: state.alloc_request_id(),
                            payload: json!({ "agent_id": agent.id, "label": agent.label }),
                        },
                        Effect::SendCommand {
                            name: "agent.open".into(),
                            request_id: state.alloc_request_id(),
                            payload: json!({ "agent_id": agent.id, "label": agent.label }),
                        },
                    ];
                }
                return Vec::new();
            }
            KeyCode::Char('x') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if state.agent_bar_index == 0 {
                    return Vec::new();
                }
                let agent_idx = state.agent_bar_index.saturating_sub(1);
                if let Some(agent) = state.agents.get(agent_idx).cloned() {
                    let closing_view = agent.id == state.viewing_agent_id;
                    let mut effects = vec![Effect::SendCommand {
                        name: "agent.close".into(),
                        request_id: state.alloc_request_id(),
                        payload: json!({ "agent_id": agent.id }),
                    }];
                    if closing_view {
                        let id = state.viewing_agent_id.clone();
                        state.viewing_agent_id.clear();
                        state.viewing_agent_label.clear();
                        state.agent_view_status.clear();
                        state.agent_bar_focused = false;
                        state.focus = FocusPane::Input;
                        state.rebuild_footer();
                        effects.push(Effect::SendCommand {
                            name: "agent.view.exit".into(),
                            request_id: state.alloc_request_id(),
                            payload: json!({ "agent_id": id }),
                        });
                    } else if state.agent_bar_index >= bar_len.saturating_sub(1)
                        && state.agent_bar_index > 0
                    {
                        state.agent_bar_index -= 1;
                        state.rebuild_footer();
                    }
                    return effects;
                }
                return Vec::new();
            }
            _ => return Vec::new(),
        }
    }

    match key.code {
        KeyCode::Esc => {
            let id = state.viewing_agent_id.clone();
            state.viewing_agent_id.clear();
            state.viewing_agent_label.clear();
            state.agent_view_status.clear();
            state.agent_bar_focused = false;
            state.focus = FocusPane::Input;
            state.rebuild_footer();
            vec![Effect::SendCommand {
                name: "agent.view.exit".into(),
                request_id: state.alloc_request_id(),
                payload: json!({ "agent_id": id }),
            }]
        }
        KeyCode::Down => {
            if state.agents.is_empty() && state.viewing_agent_id.is_empty() {
                return Vec::new();
            }
            state.agent_bar_focused = true;
            if state.agent_bar_index == 0 {
                state.agent_bar_index = state
                    .agents
                    .iter()
                    .position(|a| a.id == state.viewing_agent_id)
                    .map(|i| i + 1)
                    .unwrap_or(0);
            }
            state.rebuild_footer();
            Vec::new()
        }
        KeyCode::Enter => {
            let text = state.prompt.text.clone();
            if text.trim().is_empty() {
                return Vec::new();
            }
            state.prompt.commit_history(&text);
            state.prompt.clear();
            vec![Effect::SendCommand {
                name: "agent.view.submit".into(),
                request_id: state.alloc_request_id(),
                payload: json!({
                    "agent_id": state.viewing_agent_id,
                    "text": text,
                }),
            }]
        }
        KeyCode::Backspace => {
            state.prompt.backspace();
            Vec::new()
        }
        KeyCode::Left => {
            state.prompt.move_left();
            Vec::new()
        }
        KeyCode::Right => {
            state.prompt.move_right();
            Vec::new()
        }
        KeyCode::Char(ch) => {
            state.prompt.insert_char(ch);
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn maybe_request_completions(state: &mut AppState) -> Vec<Effect> {
    if !state.wants_completion_query() {
        state.completions.clear();
        if state.focus == FocusPane::Completions {
            state.focus = FocusPane::Input;
        }
        return Vec::new();
    }
    let request_id = state.alloc_request_id();
    vec![Effect::SendCommand {
        name: "completion.request".into(),
        request_id,
        payload: json!({ "text": state.prompt.text }),
    }]
}

fn submit_prompt(state: &mut AppState) -> Vec<Effect> {
    let text = state.prompt.text.clone();
    let has_target = state.prompt_prefix.contains('@');
    // Capture before clearing ›@ lock / selected_agent.
    let target_agent_id = if has_target {
        if state.selected_agent >= 0 {
            state
                .agents
                .get(state.selected_agent as usize)
                .map(|a| a.id.clone())
                .unwrap_or_default()
        } else {
            // Prefix-only lock (›@label ): resolve id by label.
            let label = state
                .prompt_prefix
                .trim()
                .trim_start_matches('›')
                .trim()
                .trim_start_matches('@')
                .trim()
                .to_string();
            state
                .agents
                .iter()
                .find(|a| a.label == label || a.id == label || format!("@{}", a.label) == label)
                .map(|a| a.id.clone())
                .unwrap_or_default()
        }
    } else {
        String::new()
    };
    if text.trim().is_empty() && state.attachment_count == 0 && !has_target {
        return Vec::new();
    }
    if !text.trim().is_empty() {
        state.prompt.commit_history(&text);
    }
    state.prompt.clear();
    state.completions.clear();
    state.completion_suppressed = None;
    // Empty ›@target Enter activates then clears the lock (Ink parity).
    if text.trim().is_empty() && has_target {
        state.prompt_prefix = "› ".into();
        state.selected_agent = -1;
    }
    state.focus = FocusPane::Input;
    state.status = if text.trim().is_empty() {
        "activating…".into()
    } else {
        "sending…".into()
    };
    state.busy = !text.trim().is_empty() || state.attachment_count > 0;
    if state.busy {
        state.status_started = Some(Instant::now());
    }
    state.status_clear_at = None;
    let attachment_count = state.attachment_count;
    state.attachment_count = 0;
    state.attachment_labels.clear();
    state.rebuild_footer();
    let request_id = state.alloc_request_id();
    vec![Effect::SendCommand {
        name: "input.submit".into(),
        request_id,
        payload: json!({
            "text": text,
            "attachment_count": attachment_count,
            "target_agent": target_agent_id,
            "has_target": has_target,
        }),
    }]
}

/// Handle multi-window key routing. Returns Some(effects) when the key is
/// consumed by multi mode (exit / focus cycle / agent-focused raw). Returns
/// None to fall through to normal chat dispatch (e.g. MultiFocus::Chat with
/// non-multi keys).
fn dispatch_multi_key(state: &mut AppState, key: KeyEvent) -> Option<Vec<Effect>> {
    // Ctrl+Q — exit multi. Always consumed.
    // Some terminals deliver Ctrl+Q as CONTROL+'q'; others as raw \x11 with
    // no CONTROL modifier — both must exit, never fall through as agent RAW.
    if is_ctrl_letter(key, 'q') {
        let session_id = state.multi.session_id.clone();
        return Some(vec![Effect::SendCommand {
            name: "multi.exit".into(),
            request_id: state.alloc_request_id(),
            payload: json!({ "session_id": session_id }),
        }]);
    }
    // Ctrl+W — cycle focus Chat → agent0 → agent1 → … → Chat.
    // Same dual encoding as Ctrl+Q (\x17). Without this, agent-focused Ctrl+W
    // was forwarded as RAW into the PTY and could never return to ufoo chat.
    if is_ctrl_letter(key, 'w') {
        return Some(cycle_multi_focus(state));
    }

    // Agent-focused: encode as raw bytes and ship to Node.
    if matches!(state.multi.focus, MultiFocus::Agent) && !state.multi.focus_agent_id.is_empty() {
        if let Some(bytes) = encode_key_to_raw(key) {
            let session_id = state.multi.session_id.clone();
            let agent_id = state.multi.focus_agent_id.clone();
            return Some(vec![Effect::SendCommand {
                name: "multi.raw".into(),
                request_id: state.alloc_request_id(),
                payload: json!({
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "data": bytes,
                }),
            }]);
        }
        return Some(Vec::new());
    }

    None
}

/// True for CONTROL+letter and for the C0 control byte (e.g. Ctrl+W → \x17).
fn is_ctrl_letter(key: KeyEvent, letter: char) -> bool {
    let lower = letter.to_ascii_lowercase();
    if !lower.is_ascii_alphabetic() {
        return false;
    }
    let ctrl_byte = ((lower as u8) - b'a' + 1) as char;
    match key.code {
        KeyCode::Char(ch) if key.modifiers.contains(KeyModifiers::CONTROL) => {
            ch.eq_ignore_ascii_case(&lower)
        }
        KeyCode::Char(ch) if ch == ctrl_byte => true,
        _ => false,
    }
}

fn cycle_multi_focus(state: &mut AppState) -> Vec<Effect> {
    use std::time::{Duration, Instant};

    let panes = state.multi.panes.clone();
    let session_id = state.multi.session_id.clone();

    // Duplicate Ctrl+W encodings (CONTROL+'w' then bare \x17) arrive as two
    // Press events a few ms apart. Without this guard the ring does
    // lastAgent→Chat→agent0 in one keypress and it feels impossible to stay
    // on the ufoo chat input.
    if matches!(state.multi.focus, MultiFocus::Chat) {
        if let Some(until) = state.multi.suppress_agent_focus_until {
            if Instant::now() < until {
                return Vec::new();
            }
            state.multi.suppress_agent_focus_until = None;
        }
    }

    let (next_focus, next_agent) = match state.multi.focus {
        MultiFocus::Chat if !panes.is_empty() => (MultiFocus::Agent, panes[0].agent_id.clone()),
        MultiFocus::Agent => {
            // Unknown / stale agent id: jump back to chat instead of getting
            // stuck on panes[1] forever (unwrap_or(0) + next=1 with N>=2).
            match panes
                .iter()
                .position(|p| p.agent_id == state.multi.focus_agent_id)
            {
                Some(idx) if idx + 1 < panes.len() => {
                    (MultiFocus::Agent, panes[idx + 1].agent_id.clone())
                }
                _ => (MultiFocus::Chat, String::new()),
            }
        }
        _ => (MultiFocus::Chat, String::new()),
    };
    state.multi.focus = next_focus;
    state.multi.focus_agent_id = next_agent.clone();
    if matches!(next_focus, MultiFocus::Chat) {
        state.focus = FocusPane::Input;
        state.multi.suppress_agent_focus_until = Some(Instant::now() + Duration::from_millis(200));
    } else {
        state.multi.suppress_agent_focus_until = None;
    }
    state.mark_dirty();
    let target = if matches!(next_focus, MultiFocus::Agent) {
        "agent"
    } else {
        "chat"
    };
    state.status = if target == "agent" {
        format!("multi · agent {next_agent}")
    } else {
        "multi · chat".to_string()
    };
    vec![Effect::SendCommand {
        name: "multi.focus".into(),
        request_id: state.alloc_request_id(),
        payload: json!({
            "session_id": session_id,
            "target": target,
            "agent_id": next_agent,
        }),
    }]
}

fn encode_key_to_raw(key: KeyEvent) -> Option<String> {
    match key.code {
        KeyCode::Char(ch) => {
            if key.modifiers.contains(KeyModifiers::CONTROL) {
                let lower = ch.to_ascii_lowercase();
                if lower.is_ascii_alphabetic() {
                    let byte = (lower as u8) - b'a' + 1;
                    return Some((byte as char).to_string());
                }
                match lower {
                    ' ' => return Some("\0".into()),
                    '[' => return Some("\x1b".into()),
                    '\\' => return Some("\x1c".into()),
                    ']' => return Some("\x1d".into()),
                    _ => {}
                }
            }
            if key.modifiers.contains(KeyModifiers::ALT) {
                let mut s = String::from("\x1b");
                s.push(ch);
                return Some(s);
            }
            Some(ch.to_string())
        }
        KeyCode::Enter => Some("\r".into()),
        KeyCode::Backspace => Some("\x7f".into()),
        KeyCode::Esc => Some("\x1b".into()),
        KeyCode::Tab => Some("\t".into()),
        KeyCode::BackTab => Some("\x1b[Z".into()),
        KeyCode::Left => Some("\x1b[D".into()),
        KeyCode::Right => Some("\x1b[C".into()),
        KeyCode::Up => Some("\x1b[A".into()),
        KeyCode::Down => Some("\x1b[B".into()),
        KeyCode::Home => Some("\x1b[H".into()),
        KeyCode::End => Some("\x1b[F".into()),
        KeyCode::Delete => Some("\x1b[3~".into()),
        KeyCode::Insert => Some("\x1b[2~".into()),
        KeyCode::PageUp => Some("\x1b[5~".into()),
        KeyCode::PageDown => Some("\x1b[6~".into()),
        _ => None,
    }
}

fn scroll_up(state: &mut AppState) {
    scroll_by(state, 1);
}

fn scroll_down(state: &mut AppState) {
    scroll_by(state, -1);
}

/// Positive lines = toward older history; negative = toward newer / follow-tail.
fn scroll_by(state: &mut AppState, lines: isize) {
    if lines > 0 {
        state.follow_tail = false;
        let next = state.scroll_offset.saturating_add(lines as usize);
        // Prefer the last-drawn max so we cannot overscroll the top edge.
        // Before the first paint scroll_max_off is 0 — allow a soft climb.
        state.scroll_offset = if state.scroll_max_off > 0 {
            next.min(state.scroll_max_off)
        } else {
            next.min(10_000)
        };
        return;
    }
    if lines == 0 {
        return;
    }
    let down = (-lines) as usize;
    if state.scroll_offset == 0 {
        // Overscroll at bottom re-engages follow (Grok Build parity).
        state.follow_tail = true;
        return;
    }
    state.scroll_offset = state.scroll_offset.saturating_sub(down);
    if state.scroll_offset == 0 {
        state.follow_tail = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::PROTOCOL;

    #[test]
    fn welcome_uses_host_package_version_for_ui_chrome() {
        let mut state = AppState::new("ufoo", "chat");
        dispatch(
            &mut state,
            Action::Host(Envelope {
                protocol: PROTOCOL.into(),
                kind: "welcome".into(),
                name: String::new(),
                request_id: None,
                seq: None,
                payload: json!({ "package_version": "3.0.23" }),
            }),
        );

        assert_eq!(state.package_version, "3.0.23");
        assert!(state.connected);
    }
}

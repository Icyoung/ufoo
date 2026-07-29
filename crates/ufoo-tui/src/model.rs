//! View-side state: scrollback + multiline prompt + panes.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use serde_json::Value;

pub const DEFAULT_SCROLLBACK_CAP: usize = 4_000;
pub const STREAM_COALESCE_MS: u64 = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusPane {
    Input,
    Agents,
    Mode,
    Provider,
    Cron,
    Projects,
    Completions,
    Interaction,
    AgentView,
}

#[derive(Debug, Clone, Default)]
pub struct InteractionPrompt {
    pub id: String,
    pub prompt: String,
    pub kind: String,
    pub lines: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ScrollbackEntry {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub speaker: String,
    pub expanded: bool,
    /// Collapsed tool-merge body; shown only when `expanded` is true.
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct CompletionItem {
    pub label: String,
    pub replace: String,
    pub description: String,
    pub has_children: bool,
}

#[derive(Debug, Clone)]
pub struct AgentItem {
    pub id: String,
    pub label: String,
    pub activity_state: String,
}

#[derive(Debug, Clone)]
pub struct SettingOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct ProjectItem {
    pub id: String,
    pub label: String,
    pub root: String,
    pub status: String,
    pub active: bool,
}

#[derive(Debug, Clone)]
pub struct CronItem {
    pub id: String,
    pub label: String,
    pub summary: String,
}

#[derive(Debug, Clone, Default)]
pub struct PromptState {
    pub text: String,
    pub cursor: usize,
    pub history: Vec<String>,
    pub history_index: Option<usize>,
    pub draft_backup: Option<String>,
}

impl PromptState {
    pub fn clear(&mut self) {
        self.text.clear();
        self.cursor = 0;
        self.history_index = None;
        self.draft_backup = None;
    }

    pub fn insert_char(&mut self, ch: char) {
        let byte = self.byte_index(self.cursor);
        self.text.insert(byte, ch);
        self.cursor += 1;
    }

    pub fn insert_newline(&mut self) {
        self.insert_char('\n');
    }

    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let end = self.byte_index(self.cursor);
        let start = self.byte_index(self.cursor - 1);
        self.text.drain(start..end);
        self.cursor -= 1;
    }

    pub fn move_left(&mut self) {
        if self.cursor > 0 {
            self.cursor -= 1;
        }
    }

    pub fn move_right(&mut self) {
        if self.cursor < self.char_len() {
            self.cursor += 1;
        }
    }

    pub fn history_up(&mut self) {
        if self.history.is_empty() {
            return;
        }
        match self.history_index {
            None => {
                self.draft_backup = Some(self.text.clone());
                let idx = self.history.len() - 1;
                self.history_index = Some(idx);
                self.set_text(self.history[idx].clone());
            }
            Some(0) => {}
            Some(idx) => {
                let next = idx - 1;
                self.history_index = Some(next);
                self.set_text(self.history[next].clone());
            }
        }
    }

    pub fn history_down(&mut self) {
        let Some(idx) = self.history_index else {
            return;
        };
        if idx + 1 >= self.history.len() {
            self.history_index = None;
            let draft = self.draft_backup.take().unwrap_or_default();
            self.set_text(draft);
            return;
        }
        let next = idx + 1;
        self.history_index = Some(next);
        self.set_text(self.history[next].clone());
    }

    pub fn commit_history(&mut self, value: &str) {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return;
        }
        if self.history.last().map(String::as_str) != Some(trimmed) {
            self.history.push(trimmed.to_string());
        }
        self.history_index = None;
        self.draft_backup = None;
    }

    pub fn lines(&self) -> Vec<&str> {
        if self.text.is_empty() {
            return vec![""];
        }
        self.text.split('\n').collect()
    }

    pub fn set_text(&mut self, text: String) {
        self.text = text;
        self.cursor = self.char_len();
    }

    pub fn char_len(&self) -> usize {
        self.text.chars().count()
    }

    /// (line, col) of the cursor within logical `\n`-separated lines.
    pub fn cursor_line_col(&self) -> (usize, usize) {
        let mut line = 0usize;
        let mut col = 0usize;
        for (i, ch) in self.text.chars().enumerate() {
            if i == self.cursor {
                return (line, col);
            }
            if ch == '\n' {
                line += 1;
                col = 0;
            } else {
                col += 1;
            }
        }
        (line, col)
    }

    fn set_cursor_line_col(&mut self, target_line: usize, target_col: usize) {
        let mut line = 0usize;
        let mut idx = 0usize;
        for ch in self.text.chars() {
            if line == target_line {
                break;
            }
            idx += 1;
            if ch == '\n' {
                line += 1;
            }
        }
        if line < target_line {
            self.cursor = self.char_len();
            return;
        }
        let line_len = self
            .lines()
            .get(target_line)
            .map(|s| s.chars().count())
            .unwrap_or(0);
        self.cursor = idx + target_col.min(line_len);
    }

    /// Move up one logical line. Returns false when already on the first line.
    pub fn move_up_line(&mut self) -> bool {
        let (line, col) = self.cursor_line_col();
        if line == 0 {
            return false;
        }
        self.set_cursor_line_col(line - 1, col);
        true
    }

    /// Move down one logical line. Returns false when already on the last line.
    pub fn move_down_line(&mut self) -> bool {
        let (line, col) = self.cursor_line_col();
        let last = self.lines().len().saturating_sub(1);
        if line >= last {
            return false;
        }
        self.set_cursor_line_col(line + 1, col);
        true
    }

    pub fn move_line_start(&mut self) {
        let (line, _) = self.cursor_line_col();
        self.set_cursor_line_col(line, 0);
    }

    pub fn move_line_end(&mut self) {
        let (line, _) = self.cursor_line_col();
        let len = self
            .lines()
            .get(line)
            .map(|s| s.chars().count())
            .unwrap_or(0);
        self.set_cursor_line_col(line, len);
    }

    pub fn delete_forward(&mut self) {
        if self.cursor >= self.char_len() {
            return;
        }
        let start = self.byte_index(self.cursor);
        let end = self.byte_index(self.cursor + 1);
        self.text.drain(start..end);
    }

    pub fn kill_word_back(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let chars: Vec<char> = self.text.chars().collect();
        let mut i = self.cursor;
        while i > 0 && chars[i - 1].is_whitespace() {
            i -= 1;
        }
        while i > 0 && !chars[i - 1].is_whitespace() {
            i -= 1;
        }
        let start = self.byte_index(i);
        let end = self.byte_index(self.cursor);
        self.text.drain(start..end);
        self.cursor = i;
    }

    pub fn kill_to_line_start(&mut self) {
        let (line, col) = self.cursor_line_col();
        if col == 0 {
            return;
        }
        let start_cursor = {
            let mut tmp = self.clone();
            tmp.set_cursor_line_col(line, 0);
            tmp.cursor
        };
        let start = self.byte_index(start_cursor);
        let end = self.byte_index(self.cursor);
        self.text.drain(start..end);
        self.cursor = start_cursor;
    }

    pub fn kill_to_line_end(&mut self) {
        let (line, col) = self.cursor_line_col();
        let len = self
            .lines()
            .get(line)
            .map(|s| s.chars().count())
            .unwrap_or(0);
        if col >= len {
            if self.cursor < self.char_len() {
                self.delete_forward();
            }
            return;
        }
        let end_cursor = {
            let mut tmp = self.clone();
            tmp.set_cursor_line_col(line, len);
            tmp.cursor
        };
        let start = self.byte_index(self.cursor);
        let end = self.byte_index(end_cursor);
        self.text.drain(start..end);
    }

    fn byte_index(&self, char_index: usize) -> usize {
        self.text
            .char_indices()
            .nth(char_index)
            .map(|(i, _)| i)
            .unwrap_or(self.text.len())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MultiFocus {
    Chat,
    Agent,
}

impl Default for MultiFocus {
    fn default() -> Self {
        MultiFocus::Chat
    }
}

#[derive(Debug, Clone, Default)]
pub struct MultiPaneDesc {
    pub agent_id: String,
    pub label: String,
    pub mode: String,
}

#[derive(Debug, Clone, Default)]
pub struct MultiPaneFrame {
    pub agent_id: String,
    pub label: String,
    pub mode: String,
    pub lines: Vec<String>,
    pub status: String,
    pub input: String,
    pub viewport_rev: u64,
}

#[derive(Debug, Clone, Default)]
pub struct MultiState {
    pub active: bool,
    /// Wire identity: "multi" (/multi) or "side" (internal activate).
    /// Not shown as a separate user-facing mode — same chrome as multi.
    pub kind: String,
    pub session_id: String,
    pub rev: u64,
    pub focus: MultiFocus,
    pub focus_agent_id: String,
    pub panes: Vec<MultiPaneDesc>,
    pub frames: HashMap<String, MultiPaneFrame>,
    pub viewport_rev: u64,
    pub term_cols: u16,
    pub term_rows: u16,
    /// After returning to chat, ignore Chat→agent for a short window so a
    /// duplicate Ctrl+W encoding (CONTROL+'w' + bare \x17) cannot bounce
    /// straight back onto agent0.
    pub suppress_agent_focus_until: Option<Instant>,
}

impl MultiState {
    pub fn reset(&mut self) {
        self.active = false;
        self.kind.clear();
        self.session_id.clear();
        self.rev = 0;
        self.focus = MultiFocus::Chat;
        self.focus_agent_id.clear();
        self.panes.clear();
        self.frames.clear();
        self.viewport_rev = 0;
        self.suppress_agent_focus_until = None;
    }
}

#[derive(Debug, Clone)]
pub struct PendingDelta {
    pub id: String,
    pub speaker: String,
    pub text: String,
    pub last_flush: Instant,
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub title: String,
    pub surface: String,
    pub package_version: String,
    pub entries: VecDeque<ScrollbackEntry>,
    pub scrollback_cap: usize,
    pub prompt: PromptState,
    pub status: String,
    pub footer: String,
    pub agents: Vec<AgentItem>,
    pub selected_agent: isize,
    pub completions: Vec<CompletionItem>,
    pub completion_index: usize,
    pub focus: FocusPane,
    pub scroll_offset: usize,
    /// Max scroll_offset from the last draw (lines above the viewport).
    /// Used to stop overscrolling past the oldest line.
    pub scroll_max_off: usize,
    pub follow_tail: bool,
    pub connected: bool,
    pub busy: bool,
    pub exit_requested: bool,
    pub next_request: u64,
    pub pending_delta: Option<PendingDelta>,
    pub completion_suppressed: Option<String>,
    pub dirty: bool,
    pub last_seq: Option<u64>,
    pub status_started: Option<Instant>,
    pub spinner_ticks: u64,
    pub interaction: Option<InteractionPrompt>,
    pub plan_summary: String,
    pub launch_mode: String,
    pub agent_provider: String,
    pub mode_options: Vec<String>,
    pub provider_options: Vec<SettingOption>,
    pub selected_mode: usize,
    pub selected_provider: usize,
    pub attachment_count: usize,
    pub usage_summary: String,
    pub global_mode: bool,
    pub projects: Vec<ProjectItem>,
    pub selected_project: isize,
    pub cron_tasks: Vec<CronItem>,
    pub selected_cron: isize,
    pub loop_summary: String,
    pub viewing_agent_id: String,
    pub viewing_agent_label: String,
    pub agent_view_status: String,
    pub agent_bar_index: usize,
    pub agent_bar_focused: bool,
    pub prompt_prefix: String,
    pub attachment_labels: Vec<String>,
    pub controller_root: String,
    pub active_root: String,
    pub global_scope: String,
    pub plan_lines: Vec<String>,
    pub status_clear_at: Option<Instant>,
    pub multi: MultiState,
}

impl AppState {
    pub fn new(title: impl Into<String>, surface: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            surface: surface.into(),
            package_version: crate::protocol::BINARY_VERSION.into(),
            entries: VecDeque::new(),
            scrollback_cap: DEFAULT_SCROLLBACK_CAP,
            prompt: PromptState::default(),
            status: "connecting…".into(),
            footer: String::new(),
            agents: Vec::new(),
            selected_agent: -1,
            completions: Vec::new(),
            completion_index: 0,
            focus: FocusPane::Input,
            scroll_offset: 0,
            scroll_max_off: 0,
            follow_tail: true,
            connected: false,
            busy: false,
            exit_requested: false,
            next_request: 1,
            pending_delta: None,
            completion_suppressed: None,
            dirty: true,
            last_seq: None,
            status_started: None,
            spinner_ticks: 0,
            interaction: None,
            plan_summary: String::new(),
            launch_mode: "auto".into(),
            agent_provider: "codex-cli".into(),
            mode_options: vec![
                "auto".into(),
                "host".into(),
                "terminal".into(),
                "tmux".into(),
                "internal".into(),
            ],
            provider_options: vec![
                SettingOption {
                    label: "codex".into(),
                    value: "codex-cli".into(),
                },
                SettingOption {
                    label: "claude".into(),
                    value: "claude-cli".into(),
                },
                SettingOption {
                    label: "agy".into(),
                    value: "agy-cli".into(),
                },
                SettingOption {
                    label: "kimi".into(),
                    value: "kimi-cli".into(),
                },
            ],
            selected_mode: 0,
            selected_provider: 0,
            attachment_count: 0,
            usage_summary: String::new(),
            global_mode: false,
            projects: Vec::new(),
            selected_project: -1,
            cron_tasks: Vec::new(),
            selected_cron: -1,
            loop_summary: String::new(),
            viewing_agent_id: String::new(),
            viewing_agent_label: String::new(),
            agent_view_status: String::new(),
            agent_bar_index: 0,
            agent_bar_focused: false,
            prompt_prefix: "› ".into(),
            attachment_labels: Vec::new(),
            controller_root: String::new(),
            active_root: String::new(),
            global_scope: "controller".into(),
            plan_lines: Vec::new(),
            status_clear_at: None,
            multi: MultiState::default(),
        }
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn append_entry(&mut self, entry: ScrollbackEntry) {
        self.entries.push_back(entry);
        self.evict_if_needed();
        if self.follow_tail {
            self.scroll_offset = 0;
        } else if self.scroll_max_off > 0 && self.scroll_offset >= self.scroll_max_off {
            // Pinned at the oldest edge: stay there as more lines arrive so
            // the ↑N title and viewport don't silently drift.
            self.scroll_offset = self.scroll_max_off.saturating_add(1);
        }
    }

    pub fn reset_entries(&mut self, entries: Vec<ScrollbackEntry>) {
        self.entries = entries.into();
        self.evict_if_needed();
        self.scroll_offset = 0;
        self.follow_tail = true;
    }

    pub fn evict_if_needed(&mut self) {
        while self.entries.len() > self.scrollback_cap {
            self.entries.pop_front();
        }
    }

    pub fn alloc_request_id(&mut self) -> String {
        let id = self.next_request;
        self.next_request += 1;
        format!("req-{id}")
    }

    pub fn flush_pending_delta(&mut self) {
        if let Some(pending) = self.pending_delta.take() {
            if let Some(entry) = self.entries.iter_mut().rev().find(|e| e.id == pending.id) {
                entry.text.push_str(&pending.text);
            } else {
                self.append_entry(ScrollbackEntry {
                    id: pending.id,
                    kind: "assistant".into(),
                    text: pending.text,
                    speaker: pending.speaker,
                    expanded: false,
                    detail: String::new(),
                });
            }
        }
    }

    pub fn push_stream_delta(&mut self, id: &str, speaker: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let now = Instant::now();
        match self.pending_delta.as_mut() {
            Some(pending) if pending.id == id => {
                pending.text.push_str(text);
                if now.duration_since(pending.last_flush)
                    >= Duration::from_millis(STREAM_COALESCE_MS)
                {
                    let flush = pending.text.clone();
                    pending.text.clear();
                    pending.last_flush = now;
                    if let Some(entry) = self.entries.iter_mut().rev().find(|e| e.id == id) {
                        entry.text.push_str(&flush);
                    }
                }
            }
            _ => {
                self.flush_pending_delta();
                if let Some(entry) = self.entries.iter_mut().rev().find(|e| e.id == id) {
                    entry.text.push_str(text);
                    self.pending_delta = Some(PendingDelta {
                        id: id.to_string(),
                        speaker: speaker.to_string(),
                        text: String::new(),
                        last_flush: now,
                    });
                } else {
                    self.append_entry(ScrollbackEntry {
                        id: id.to_string(),
                        kind: "assistant".into(),
                        text: text.to_string(),
                        speaker: speaker.to_string(),
                        expanded: false,
                        detail: String::new(),
                    });
                    self.pending_delta = Some(PendingDelta {
                        id: id.to_string(),
                        speaker: speaker.to_string(),
                        text: String::new(),
                        last_flush: now,
                    });
                }
            }
        }
    }

    pub fn show_project_bar(&self) -> bool {
        self.global_mode && !self.projects.is_empty() && self.surface != "ucode"
    }

    pub fn rebuild_footer(&mut self) {
        if self.focus == FocusPane::Mode {
            let parts: Vec<String> = self
                .mode_options
                .iter()
                .enumerate()
                .map(|(i, mode)| {
                    if i == self.selected_mode {
                        format!("[{mode}]")
                    } else {
                        mode.clone()
                    }
                })
                .collect();
            self.footer = format!(
                "Mode: {} · ←/→ · ↓ provider · ↑ cron · esc",
                parts.join(" · ")
            );
            return;
        }
        if self.focus == FocusPane::Provider {
            let parts: Vec<String> = self
                .provider_options
                .iter()
                .enumerate()
                .map(|(i, opt)| {
                    if i == self.selected_provider {
                        format!("[{}]", opt.label)
                    } else {
                        opt.label.clone()
                    }
                })
                .collect();
            self.footer = format!(
                "Provider: {} · ←/→ · ↓/esc back · ↑ mode",
                parts.join(" · ")
            );
            return;
        }
        if self.focus == FocusPane::Cron {
            if self.cron_tasks.is_empty() {
                self.footer = "Cron: none · ↑ agents · esc".into();
                return;
            }
            let parts: Vec<String> = self
                .cron_tasks
                .iter()
                .enumerate()
                .map(|(i, task)| {
                    if i as isize == self.selected_cron {
                        format!("[{}]", task.label)
                    } else {
                        task.label.clone()
                    }
                })
                .collect();
            self.footer = format!(
                "Cron: {} · ←/→ · Ctrl+X stop · ↑ agents · esc",
                parts.join(" · ")
            );
            return;
        }
        if !self.viewing_agent_id.is_empty() {
            let mut parts = Vec::with_capacity(self.agents.len() + 1);
            let exit_selected = self.agent_bar_focused && self.agent_bar_index == 0;
            parts.push(if exit_selected {
                "[ufoo]".to_string()
            } else {
                "ufoo".to_string()
            });
            for (i, agent) in self.agents.iter().enumerate() {
                let bar_i = i + 1;
                let mark = match agent.activity_state.as_str() {
                    "working" => "*",
                    "waiting_input" => "?",
                    "blocked" => "!",
                    _ => "",
                };
                let selected = self.agent_bar_focused && self.agent_bar_index == bar_i;
                let viewing = agent.id == self.viewing_agent_id;
                if selected {
                    parts.push(format!("[{mark}{}]", agent.label));
                } else if viewing {
                    parts.push(format!("*{mark}{}", agent.label));
                } else {
                    parts.push(format!("{mark}{}", agent.label));
                }
            }
            let hint = if self.agent_bar_focused {
                "←/→ enter · ↑ input · ctrl+x · esc exit"
            } else {
                "↓ bar · esc exit · enter send"
            };
            self.footer = format!("{} · {}", parts.join(" · "), hint);
            return;
        }
        let mut base = if self.agents.is_empty() {
            "Agents: none".to_string()
        } else {
            // Ink summary row: "Agents: @a, @b, @c" (+N when truncated).
            const MAX_VISIBLE: usize = 6;
            let total = self.agents.len();
            let visible = self.agents.iter().enumerate().take(MAX_VISIBLE);
            let parts: Vec<String> = visible
                .map(|(i, agent)| {
                    let mark = match agent.activity_state.as_str() {
                        "working" => "*",
                        "waiting_input" => "?",
                        "blocked" => "!",
                        _ => "",
                    };
                    let name = ensure_at_prefix(&agent.label);
                    let label = format!("{mark}{name}");
                    let selected =
                        self.focus == FocusPane::Agents && self.selected_agent == i as isize;
                    if selected {
                        format!("[{label}]")
                    } else {
                        label
                    }
                })
                .collect();
            let mut agents = parts.join(", ");
            if total > MAX_VISIBLE {
                agents = format!("{agents} +{}", total - MAX_VISIBLE);
            }
            format!("Agents: {agents}")
        };
        if self.attachment_count > 0 {
            base = format!("{base} · 📎{}", self.attachment_count);
        }
        if !self.usage_summary.is_empty() {
            base = format!("{base} · {}", self.usage_summary);
        }
        if !self.loop_summary.is_empty() {
            base = format!("{base} · {}", self.loop_summary);
        }
        // Detail panes (Agents focused) show only that caption — cron belongs
        // on the idle summary row when tasks exist. Mode/provider are slash cmds.
        if self.focus == FocusPane::Agents {
            self.footer = format!("{base} · ←/→ · Enter @lock · empty Enter activate · Ctrl+X close · ↓ cron · ↑/esc back");
            return;
        }
        // Summary: Agents (+ Mode · Provider) · Cron only when non-empty.
        if self.surface != "ucode" {
            base = format!(
                "{base} · {} · {}",
                self.launch_mode,
                provider_short(&self.agent_provider)
            );
            if !self.cron_tasks.is_empty() {
                base = format!("{base} · {}", self.cron_tasks.len());
            }
        } else if !self.cron_tasks.is_empty() {
            base = format!("{base} · {}", self.cron_tasks.len());
        }
        self.footer = base;
    }

    pub fn apply_projects_payload(&mut self, payload: &Value) {
        self.global_mode = payload
            .get("global_mode")
            .and_then(|v| v.as_bool())
            .unwrap_or(self.global_mode);
        if let Some(root) = payload.get("controller_root").and_then(|v| v.as_str()) {
            self.controller_root = root.to_string();
        }
        if let Some(root) = payload.get("active_root").and_then(|v| v.as_str()) {
            self.active_root = root.to_string();
        }
        if let Some(scope) = payload.get("scope").and_then(|v| v.as_str()) {
            self.global_scope = scope.to_string();
        }
        if let Some(items) = payload.get("projects").and_then(|v| v.as_array()) {
            self.projects = items
                .iter()
                .filter_map(|item| {
                    let label = item
                        .get("label")
                        .or_else(|| item.get("id"))
                        .and_then(|v| v.as_str())?
                        .to_string();
                    let root = item
                        .get("root")
                        .or_else(|| item.get("project_root"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let id = item
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(root.as_str())
                        .to_string();
                    Some(ProjectItem {
                        id,
                        label,
                        root,
                        status: item
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        active: item
                            .get("active")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false),
                    })
                })
                .collect();
            if self.selected_project < 0 || self.selected_project >= self.projects.len() as isize {
                self.selected_project = self
                    .projects
                    .iter()
                    .position(|p| p.active)
                    .map(|i| i as isize)
                    .unwrap_or(if self.projects.is_empty() { -1 } else { 0 });
            }
        }
    }

    pub fn apply_cron_payload(&mut self, payload: &Value) {
        let tasks = payload
            .get("cron")
            .or_else(|| payload.get("tasks"))
            .and_then(|v| v.as_array());
        if let Some(items) = tasks {
            self.cron_tasks = items
                .iter()
                .enumerate()
                .map(|(index, item)| CronItem {
                    id: item
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&format!("cron-{index}"))
                        .to_string(),
                    label: item
                        .get("label")
                        .or_else(|| item.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or(&format!("cron-{index}"))
                        .to_string(),
                    summary: item
                        .get("summary")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect();
            if self.selected_cron < 0 || self.selected_cron >= self.cron_tasks.len() as isize {
                self.selected_cron = if self.cron_tasks.is_empty() { -1 } else { 0 };
            }
        }
        if let Some(loop_text) = payload.get("loop_summary").and_then(|v| v.as_str()) {
            self.loop_summary = loop_text.to_string();
        } else if payload.get("loop").is_some() {
            // Host may send structured loop; prefer preformatted loop_summary.
        }
        self.rebuild_footer();
    }

    pub fn apply_settings_payload(&mut self, payload: &Value) {
        if let Some(mode) = payload
            .get("launch_mode")
            .or_else(|| payload.get("launchMode"))
            .and_then(|v| v.as_str())
        {
            self.launch_mode = mode.to_string();
            if let Some(idx) = self.mode_options.iter().position(|m| m == mode) {
                self.selected_mode = idx;
            }
        }
        if let Some(provider) = payload
            .get("agent_provider")
            .or_else(|| payload.get("agentProvider"))
            .and_then(|v| v.as_str())
        {
            self.agent_provider = provider.to_string();
            if let Some(idx) = self
                .provider_options
                .iter()
                .position(|opt| opt.value == provider)
            {
                self.selected_provider = idx;
            }
        }
        if let Some(modes) = payload.get("mode_options").and_then(|v| v.as_array()) {
            let next: Vec<String> = modes
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect();
            if !next.is_empty() {
                self.mode_options = next;
                if let Some(idx) = self
                    .mode_options
                    .iter()
                    .position(|m| m == &self.launch_mode)
                {
                    self.selected_mode = idx;
                } else {
                    self.selected_mode = 0;
                }
            }
        }
        if let Some(providers) = payload.get("provider_options").and_then(|v| v.as_array()) {
            let next: Vec<SettingOption> = providers
                .iter()
                .filter_map(|item| {
                    let label = item.get("label").and_then(|v| v.as_str())?.to_string();
                    let value = item
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or(label.as_str())
                        .to_string();
                    Some(SettingOption { label, value })
                })
                .collect();
            if !next.is_empty() {
                self.provider_options = next;
                if let Some(idx) = self
                    .provider_options
                    .iter()
                    .position(|opt| opt.value == self.agent_provider)
                {
                    self.selected_provider = idx;
                } else {
                    self.selected_provider = 0;
                }
            }
        }
        self.rebuild_footer();
    }

    pub fn wants_completion_query(&self) -> bool {
        let text = self.prompt.text.trim_start();
        if text.is_empty() {
            return false;
        }
        if self.completion_suppressed.as_deref() == Some(self.prompt.text.as_str()) {
            return false;
        }
        text.starts_with('/') || text.starts_with('@')
    }
}

fn ensure_at_prefix(value: &str) -> String {
    let text = value.trim();
    if text.is_empty() {
        return String::new();
    }
    if text.starts_with('@') {
        text.to_string()
    } else {
        format!("@{text}")
    }
}

fn provider_short(value: &str) -> &str {
    match value {
        "claude-cli" => "claude",
        "agy-cli" | "agy" | "antigravity" => "agy",
        "kimi-cli" | "kimi" | "kimi-code" => "kimi",
        "ucode" | "ufoo" | "ufoo-code" => "ucode",
        _ => "codex",
    }
}

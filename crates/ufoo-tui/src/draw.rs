//! ratatui Presenter for chat / ucode surfaces.

use ansi_to_tui::IntoText;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::model::{AppState, FocusPane, MultiFocus};

const SPINNER: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// Draw UI and return hardware cursor position (x, y) for IME, if any.
pub fn draw(frame: &mut Frame, state: &AppState) -> Option<(u16, u16)> {
    let area = frame.area();
    let project_h = if state.show_project_bar() { 1 } else { 0 };
    let completion_h = if state.focus == FocusPane::Completions && !state.completions.is_empty() {
        (state.completions.len().min(8) as u16).saturating_add(2).max(3)
    } else {
        0
    };
    let plan_h = if state.plan_lines.is_empty() {
        0
    } else {
        (state.plan_lines.len() as u16).clamp(1, 8)
    };
    let interaction_h = state
        .interaction
        .as_ref()
        .map(|i| {
            let n = if i.lines.is_empty() { 1 } else { i.lines.len() };
            (n as u16).clamp(1, 6)
        })
        .unwrap_or(0);
    let attach_h = if state.attachment_labels.is_empty() { 0 } else { 1 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(project_h),
            Constraint::Min(3),
            Constraint::Length(completion_h),
            Constraint::Length(plan_h),
            Constraint::Length(interaction_h),
            Constraint::Length(attach_h),
            Constraint::Length(1), // status above input (Ink ChatStatusLine)
            Constraint::Length(prompt_height(state, area.width)),
            Constraint::Length(1), // agents / mode / provider / cron
        ])
        .split(area);

    if project_h > 0 {
        draw_project_bar(frame, chunks[0], state);
    }
    if state.multi.active && !state.multi.panes.is_empty() {
        draw_multi_content(frame, chunks[1], state);
    } else {
        draw_scrollback(frame, chunks[1], state);
    }
    if completion_h > 0 {
        draw_completions(frame, chunks[2], state);
    }
    if plan_h > 0 {
        draw_plan_band(frame, chunks[3], state);
    }
    if interaction_h > 0 {
        draw_interaction_band(frame, chunks[4], state);
    }
    if attach_h > 0 {
        draw_attachments(frame, chunks[5], state);
    }
    draw_status(frame, chunks[6], state);
    let cursor = draw_prompt(frame, chunks[7], state);
    draw_footer(frame, chunks[8], state);
    cursor
}

/// Hit-test top project bar. Returns project index when (x,y) is on a chip.
pub fn project_index_at(state: &AppState, area: Rect, column: u16, row: u16) -> Option<usize> {
    if !state.show_project_bar() || row != area.y {
        return None;
    }
    let mut x = area.x as usize;
    let max_x = (area.x + area.width) as usize;
    for (i, project) in state.projects.iter().enumerate() {
        let mark = if project.active { "*" } else { "" };
        let selected = state.focus == FocusPane::Projects && state.selected_project == i as isize;
        let label = if selected {
            format!("[{mark}{}]", project.label)
        } else {
            format!("{mark}{}", project.label)
        };
        let chip = format!(" {label} ");
        let width = chip.width().max(1);
        let end = x + width;
        if (column as usize) >= x && (column as usize) < end.min(max_x) {
            return Some(i);
        }
        x = end;
        if x >= max_x {
            break;
        }
    }
    None
}

fn prompt_height(state: &AppState, width: u16) -> u16 {
    // Border consumes 2 rows; size the content area, then add chrome.
    let inner = width.saturating_sub(2).max(1) as usize;
    let mut rows = 0usize;
    for line in state.prompt.lines() {
        let w = line.width().max(1);
        rows += (w + inner - 1) / inner;
    }
    let content = rows.clamp(1, 10) as u16;
    content.saturating_add(2).max(3)
}

fn prompt_accepts_typing(state: &AppState) -> bool {
    // When multi focuses an agent pane, keys go raw to that pane — hide the
    // chat caret so Ctrl+W focus changes feel immediate.
    if state.multi.active && matches!(state.multi.focus, MultiFocus::Agent) {
        return false;
    }
    // Footer / project focus still routes printable keys into the draft, so the
    // hardware caret must stay inside the prompt box (IME / CJK preedit).
    match state.focus {
        FocusPane::AgentView => !state.agent_bar_focused,
        FocusPane::Completions => false,
        _ => true,
    }
}

/// Multi-window: ufoo (chat log + prompt) owns focus — cyan like agent panes.
fn multi_ufoo_focused(state: &AppState) -> bool {
    state.multi.active && matches!(state.multi.focus, MultiFocus::Chat)
}

fn draw_project_bar(frame: &mut Frame, area: Rect, state: &AppState) {
    let mut spans = Vec::new();
    spans.push(Span::styled(
        " projects ",
        Style::default().fg(Color::DarkGray),
    ));
    for (i, project) in state.projects.iter().enumerate() {
        let mark = if project.active { "*" } else { "" };
        let selected = state.focus == FocusPane::Projects && state.selected_project == i as isize;
        let label = if selected {
            format!("[{mark}{}]", project.label)
        } else {
            format!(" {mark}{} ", project.label)
        };
        let style = if selected || project.active {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        } else if state.focus == FocusPane::Projects {
            Style::default().fg(Color::Yellow)
        } else {
            Style::default().fg(Color::Cyan)
        };
        spans.push(Span::styled(label, style));
    }
    if state.focus == FocusPane::Projects {
        spans.push(Span::styled(
            "  ←/→ enter · esc",
            Style::default().fg(Color::DarkGray),
        ));
    }
    let paragraph = Paragraph::new(Line::from(spans));
    frame.render_widget(paragraph, area);
}

fn draw_scrollback(frame: &mut Frame, area: Rect, state: &AppState) {
    let ufoo_hi = multi_ufoo_focused(state);
    // Keep the same brand title as single-pane mode (🛸 UFOO); only the
    // border/title color changes when multi focuses the ufoo chat side.
    let title = if !state.viewing_agent_id.is_empty() {
        format!(" agent · {} ", state.viewing_agent_label)
    } else if state.follow_tail {
        state.title.clone()
    } else {
        format!("{}↑{} ", state.title.trim_end(), state.scroll_offset)
    };
    let border_style = if ufoo_hi {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    let title_style = if ufoo_hi {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    let block = Block::default()
        .title(Span::styled(title, title_style))
        .borders(Borders::ALL)
        .border_style(border_style);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    // Grok-style content inset: leave 1 col for optional scrollbar + pad.
    let content = Rect {
        x: inner.x.saturating_add(1),
        y: inner.y,
        width: inner.width.saturating_sub(2).max(1),
        height: inner.height,
    };
    let max_rows = content.height as usize;
    let lines = build_scrollback_lines(state, content.width as usize);
    let total = lines.len();
    let max_off = total.saturating_sub(max_rows);
    let offset = state.scroll_offset.min(max_off);
    let end = total.saturating_sub(offset);
    let start = end.saturating_sub(max_rows);
    let visible = lines[start..end].to_vec();
    let paragraph = Paragraph::new(visible);
    frame.render_widget(paragraph, content);

    // Minimal scrollbar (bright when scrolled up, dim when following).
    // Cap thumb at 3 rows — a full-height ▐ strip looks like a dense sidebar.
    if inner.width > 0 && total > max_rows && max_rows > 0 {
        let track_h = inner.height.max(1) as usize;
        let thumb_h = ((max_rows * track_h) / total).clamp(1, track_h.min(3));
        let from_top = if max_off == 0 || state.follow_tail {
            track_h.saturating_sub(thumb_h)
        } else {
            let older = offset;
            let newer_progress = max_off.saturating_sub(older);
            (newer_progress * track_h.saturating_sub(thumb_h)) / max_off
        };
        let bar_x = inner.x + inner.width.saturating_sub(1);
        let style = if state.follow_tail {
            Style::default().fg(Color::DarkGray)
        } else {
            Style::default().fg(Color::Gray)
        };
        for row in from_top..(from_top + thumb_h).min(track_h) {
            frame.render_widget(
                Paragraph::new(Span::styled("▐", style)),
                Rect {
                    x: bar_x,
                    y: inner.y + row as u16,
                    width: 1,
                    height: 1,
                },
            );
        }
    }
}

fn build_scrollback_lines(state: &AppState, width: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let pad = " ";
    for (entry_idx, entry) in state.entries.iter().enumerate() {
        // Tighter than Grok's always-on gap: only separate user turns.
        if entry_idx > 0 && entry.kind == "user" {
            out.push(Line::from(""));
        }
        let mut body = if entry.kind == "tool" && entry.expanded && !entry.detail.is_empty() {
            let summary = entry
                .text
                .trim_end_matches(" (Ctrl+O expand)")
                .to_string();
            format!("{summary}\n{}", entry.detail)
        } else {
            entry.text.clone()
        };

        // Host already echoes user lines as "› …" / "> …". Strip that and
        // paint a single Grok-style ❯ so we don't get "❯ ›" / "> >".
        if entry.kind == "user" {
            let trimmed = body.trim_start();
            for needle in ["❯ ", "› ", "> ", "❯", "›", ">"] {
                if let Some(rest) = trimmed.strip_prefix(needle) {
                    body = rest.to_string();
                    break;
                }
            }
        }

        let (prefix, kind_style) = match entry.kind.as_str() {
            "user" => (
                if entry.speaker.is_empty() {
                    "❯ ".to_string()
                } else {
                    format!("❯ {} · ", entry.speaker)
                },
                Style::default().fg(Color::Cyan),
            ),
            "error" => (
                if entry.speaker.is_empty() {
                    String::new()
                } else {
                    format!("{} · ", entry.speaker)
                },
                Style::default().fg(Color::Red),
            ),
            "tool" => (String::new(), Style::default().fg(Color::DarkGray)),
            "bus" => (
                if entry.speaker.is_empty() {
                    String::new()
                } else {
                    format!("{} · ", entry.speaker)
                },
                Style::default().fg(Color::Yellow),
            ),
            "assistant" => (
                if entry.speaker.is_empty() {
                    String::new()
                } else {
                    format!("{} · ", entry.speaker)
                },
                Style::default().fg(Color::Gray),
            ),
            _ => (
                if entry.speaker.is_empty() {
                    String::new()
                } else {
                    format!("{} · ", entry.speaker)
                },
                Style::default().fg(Color::DarkGray),
            ),
        };
        let content_width = width.saturating_sub(pad.width()).max(1);
        for (line_idx, line) in body.lines().enumerate() {
            let head = if line_idx == 0 {
                format!("{prefix}{line}")
            } else {
                format!("{:width$}{line}", "", width = prefix.width())
            };
            if head.contains('\u{1b}') {
                if let Ok(text) = head.into_text() {
                    for ansi_line in text.lines {
                        let mut spans = vec![Span::raw(pad.to_string())];
                        for span in ansi_line.spans {
                            spans.push(Span::styled(span.content.to_string(), span.style));
                        }
                        out.push(Line::from(spans));
                    }
                    continue;
                }
            }
            let mut rest = head;
            while !rest.is_empty() {
                let mut used = 0usize;
                let mut cut = rest.len();
                for (idx, ch) in rest.char_indices() {
                    let w = ch.width().unwrap_or(1);
                    if used + w > content_width && used > 0 {
                        cut = idx;
                        break;
                    }
                    used += w;
                    cut = idx + ch.len_utf8();
                }
                let (chunk, next) = rest.split_at(cut);
                out.push(Line::from(vec![
                    Span::raw(pad.to_string()),
                    Span::styled(chunk.to_string(), kind_style),
                ]));
                rest = next.to_string();
                if cut == 0 {
                    break;
                }
            }
        }
    }
    out
}

fn draw_completions(frame: &mut Frame, area: Rect, state: &AppState) {
    let block = Block::default().title("completions").borders(Borders::ALL);
    let lines: Vec<Line> = state
        .completions
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let selected = i == state.completion_index;
            let mark = if selected { "› " } else { "  " };
            let desc = if item.description.is_empty() {
                String::new()
            } else {
                format!("  {}", item.description)
            };
            let style = if selected {
                Style::default().fg(Color::Black).bg(Color::Cyan)
            } else {
                Style::default()
            };
            Line::from(Span::styled(format!("{mark}{}{desc}", item.label), style))
        })
        .collect();
    let paragraph = Paragraph::new(lines).block(block);
    frame.render_widget(paragraph, area);
}

fn draw_plan_band(frame: &mut Frame, area: Rect, state: &AppState) {
    let lines: Vec<Line> = state
        .plan_lines
        .iter()
        .take(area.height as usize)
        .map(|line| {
            let painted = format!(" {line}");
            if painted.contains('\u{1b}') {
                if let Ok(text) = painted.into_text() {
                    if let Some(first) = text.lines.into_iter().next() {
                        return first;
                    }
                }
            }
            Line::from(Span::styled(
                painted,
                Style::default().fg(Color::Magenta),
            ))
        })
        .collect();
    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, area);
}

fn draw_interaction_band(frame: &mut Frame, area: Rect, state: &AppState) {
    let Some(interaction) = state.interaction.as_ref() else {
        return;
    };
    let source: Vec<String> = if interaction.lines.is_empty() {
        vec![format!(
            "{}: {}",
            interaction.kind,
            interaction.prompt
        )]
    } else {
        interaction.lines.clone()
    };
    let lines: Vec<Line> = source
        .iter()
        .take(area.height as usize)
        .map(|line| {
            Line::from(Span::styled(
                format!(" {line}"),
                Style::default()
                    .fg(Color::Black)
                    .bg(Color::Yellow)
                    .add_modifier(Modifier::BOLD),
            ))
        })
        .collect();
    let paragraph = Paragraph::new(lines);
    frame.render_widget(paragraph, area);
}

fn draw_attachments(frame: &mut Frame, area: Rect, state: &AppState) {
    let mut spans = Vec::new();
    for (i, label) in state.attachment_labels.iter().enumerate() {
        if i > 0 {
            spans.push(Span::styled(" ", Style::default()));
        }
        spans.push(Span::styled(
            format!("[img] {label}"),
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));
    }
    let paragraph = Paragraph::new(Line::from(spans));
    frame.render_widget(paragraph, area);
}

fn draw_prompt(frame: &mut Frame, area: Rect, state: &AppState) -> Option<(u16, u16)> {
    let title = if state.focus == FocusPane::AgentView {
        if state.agent_bar_focused {
            "› agent bar".to_string()
        } else {
            format!(
                "› {}",
                if state.viewing_agent_label.is_empty() {
                    state.viewing_agent_id.as_str()
                } else {
                    state.viewing_agent_label.as_str()
                }
            )
        }
    } else if state.focus == FocusPane::Input || state.focus == FocusPane::Interaction {
        state.prompt_prefix.trim_end().to_string()
    } else if state.focus == FocusPane::Agents {
        if let Some(agent) = state.agents.get(state.selected_agent.max(0) as usize) {
            format!("›@{}", agent.label)
        } else {
            "› agents".into()
        }
    } else {
        match state.focus {
            FocusPane::Completions => "› completions".into(),
            FocusPane::Mode => "› mode".into(),
            FocusPane::Provider => "› provider".into(),
            FocusPane::Cron => "› cron".into(),
            FocusPane::Projects => "› projects".into(),
            _ => "›".into(),
        }
    };
    let ufoo_hi = multi_ufoo_focused(state);
    let border_style = if ufoo_hi {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    let block = Block::default()
        .title(Span::styled(
            title,
            if ufoo_hi {
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            },
        ))
        .borders(Borders::ALL)
        .border_style(border_style);
    let inner = block.inner(area);
    let show_caret = prompt_accepts_typing(state);
    let inner_w = inner.width.max(1) as usize;

    // Soft-wrap draft into visual rows and map the caret onto them.
    let chars: Vec<char> = state.prompt.text.chars().collect();
    let mut visual_rows: Vec<String> = Vec::new();
    let mut caret_row = 0usize;
    let mut caret_col = 0usize;
    let mut row = String::new();
    let mut row_w = 0usize;

    if chars.is_empty() {
        visual_rows.push(String::new());
    } else {
        for (i, ch) in chars.iter().enumerate() {
            if i == state.prompt.cursor {
                caret_row = visual_rows.len();
                caret_col = row_w;
            }
            if *ch == '\n' {
                visual_rows.push(std::mem::take(&mut row));
                row_w = 0;
                continue;
            }
            let cw = ch.width().unwrap_or(1);
            if row_w + cw > inner_w && !row.is_empty() {
                visual_rows.push(std::mem::take(&mut row));
                row_w = 0;
            }
            row.push(*ch);
            row_w += cw;
        }
        if state.prompt.cursor >= chars.len() {
            caret_row = visual_rows.len();
            caret_col = row_w;
        }
        visual_rows.push(row);
    }

    let max_rows = inner.height.max(1) as usize;
    let start_row = caret_row.saturating_add(1).saturating_sub(max_rows);
    let visible: Vec<Line> = visual_rows
        .iter()
        .enumerate()
        .skip(start_row)
        .take(max_rows)
        .map(|(row_idx, text)| {
            if show_caret && row_idx == caret_row {
                let mut spans = Vec::new();
                let mut w = 0usize;
                let mut placed = false;
                for ch in text.chars() {
                    let cw = ch.width().unwrap_or(1);
                    if !placed && w == caret_col {
                        spans.push(Span::styled(
                            ch.to_string(),
                            Style::default().fg(Color::Black).bg(Color::White),
                        ));
                        placed = true;
                    } else {
                        spans.push(Span::raw(ch.to_string()));
                    }
                    w += cw;
                }
                if !placed {
                    spans.push(Span::styled(
                        " ",
                        Style::default().fg(Color::Black).bg(Color::White),
                    ));
                }
                Line::from(spans)
            } else {
                Line::from(text.clone())
            }
        })
        .collect();

    let paragraph = Paragraph::new(visible).block(block);
    frame.render_widget(paragraph, area);

    if !show_caret {
        return None;
    }
    let vis_row = caret_row.saturating_sub(start_row) as u16;
    let col = (caret_col as u16).min(inner.width.saturating_sub(1));
    let x = inner.x.saturating_add(col);
    let y = inner.y.saturating_add(vis_row.min(inner.height.saturating_sub(1)));
    // Keep IME preedit inside the prompt inner area — never past status/footer.
    let max_x = inner.x.saturating_add(inner.width.saturating_sub(1));
    let max_y = inner.y.saturating_add(inner.height.saturating_sub(1));
    Some((x.min(max_x), y.min(max_y)))
}

fn draw_status(frame: &mut Frame, area: Rect, state: &AppState) {
    // Ink ChatStatusLine: left = live status, right = version. No ui:ok chrome.
    let spin = if state.busy {
        let ch = SPINNER[state.spinner_ticks as usize % SPINNER.len()];
        format!("{ch} ")
    } else {
        String::new()
    };
    let elapsed = if state.busy {
        state
            .status_started
            .map(|started| {
                let secs = started.elapsed().as_secs();
                format!(" ({secs}s, esc cancel)")
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    let ask = if let Some(interaction) = state.interaction.as_ref() {
        format!(" | {}: {}", interaction.kind, interaction.prompt)
    } else if !state.agent_view_status.is_empty() {
        format!(" | {}", state.agent_view_status)
    } else {
        String::new()
    };
    let loop_bit = if state.loop_summary.is_empty() {
        String::new()
    } else {
        format!(" | {}", state.loop_summary)
    };
    let version = format!("v{}", crate::protocol::BINARY_VERSION);
    let left = format!(
        "{spin}{status}{elapsed}{ask}{loop_bit}",
        status = if state.status.is_empty() {
            "ready"
        } else {
            state.status.as_str()
        }
    );
    let version_w = version.width() as u16;
    let gap = area.width.saturating_sub(1 + left.width() as u16 + version_w);
    let mut spans = vec![Span::styled(
        format!(" {left}"),
        Style::default().fg(Color::DarkGray),
    )];
    if gap > 0 {
        spans.push(Span::raw(" ".repeat(gap as usize)));
    }
    spans.push(Span::styled(version, Style::default().fg(Color::DarkGray)));
    let paragraph = Paragraph::new(Line::from(spans));
    frame.render_widget(paragraph, area);
}

/// Split the content area horizontally: ~1/3 chat scrollback on the left,
/// agent panes grid on the right. Ports paneLayout.js::layoutAgentPanes so the
/// Rust presentation and Node's `multi.viewport` calculation stay in sync.
fn draw_multi_content(frame: &mut Frame, area: Rect, state: &AppState) {
    let chat_w = (area.width / 3).max(4);
    let right_left = area.x.saturating_add(chat_w).saturating_add(1);
    let right_w = area.width.saturating_sub(chat_w).saturating_sub(1);
    let chat_area = Rect {
        x: area.x,
        y: area.y,
        width: chat_w,
        height: area.height,
    };
    // Chat scrollback keeps its own borders/title.
    draw_scrollback(frame, chat_area, state);
    if right_w < 4 || area.height < 3 {
        return;
    }
    let panes = layout_agent_panes(right_left, area.y, right_w, area.height, state.multi.panes.len());
    for (i, pane_area) in panes.iter().enumerate() {
        let Some(desc) = state.multi.panes.get(i) else { continue };
        let focused = matches!(state.multi.focus, MultiFocus::Agent)
            && state.multi.focus_agent_id == desc.agent_id;
        draw_multi_pane(frame, *pane_area, state, i, focused);
    }
}

fn draw_multi_pane(
    frame: &mut Frame,
    area: Rect,
    state: &AppState,
    idx: usize,
    focused: bool,
) {
    let Some(desc) = state.multi.panes.get(idx) else { return };
    let title = format!(" {} ", desc.label);
    let border_style = if focused {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(border_style);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let lines: Vec<Line<'static>> = state
        .multi
        .frames
        .get(&desc.agent_id)
        .map(|frame_state| {
            let mut out: Vec<Line<'static>> = Vec::new();
            for raw in &frame_state.lines {
                if raw.contains('\u{1b}') {
                    match raw.as_str().into_text() {
                        Ok(text) => {
                            for l in text.lines {
                                let owned = Line::from(
                                    l.spans
                                        .into_iter()
                                        .map(|s| Span::styled(s.content.to_string(), s.style))
                                        .collect::<Vec<_>>(),
                                );
                                out.push(owned);
                            }
                        }
                        Err(_) => {
                            out.push(Line::from(raw.clone()));
                        }
                    }
                } else {
                    out.push(Line::from(raw.clone()));
                }
            }
            if frame_state.mode == "internal" && !frame_state.input.is_empty() {
                out.push(Line::from(vec![
                    Span::styled(
                        "› ".to_string(),
                        Style::default().fg(Color::Magenta),
                    ),
                    Span::raw(frame_state.input.clone()),
                ]));
            }
            out
        })
        .unwrap_or_else(|| vec![Line::from(Span::styled(
            "(waiting for frame…)",
            Style::default().fg(Color::DarkGray),
        ))]);

    let take = (inner.height as usize).max(1);
    let visible = if lines.len() > take {
        lines[lines.len() - take..].to_vec()
    } else {
        lines
    };
    let paragraph = Paragraph::new(visible);
    frame.render_widget(paragraph, inner);
}

/// Mirror of paneLayout.js::layoutAgentPanes. Returns Rects in absolute
/// coordinates so the caller can `frame.render_widget` directly.
fn layout_agent_panes(left: u16, top: u16, width: u16, height: u16, count: usize) -> Vec<Rect> {
    if count == 0 || width == 0 || height == 0 {
        return Vec::new();
    }
    if count == 1 {
        return vec![Rect { x: left, y: top, width, height }];
    }
    if count == 2 {
        let h1 = height / 2;
        return vec![
            Rect { x: left, y: top, width, height: h1 },
            Rect { x: left, y: top + h1, width, height: height - h1 },
        ];
    }
    let row_count = ((count as u16) + 1) / 2;
    let row_h = height / row_count;
    let mut out = Vec::with_capacity(count);
    let mut placed = 0usize;
    for row in 0..row_count {
        let row_top = top + row * row_h;
        let last_row = row == row_count - 1;
        let actual_h = if last_row { height - row * row_h } else { row_h };
        let remaining = count - placed;
        let is_odd = remaining % 2 == 1 && row == 0 && count % 2 == 1;
        if is_odd {
            out.push(Rect { x: left, y: row_top, width, height: actual_h });
            placed += 1;
        } else {
            let half_w = width / 2;
            out.push(Rect {
                x: left,
                y: row_top,
                width: half_w,
                height: actual_h,
            });
            out.push(Rect {
                x: left + half_w + 1,
                y: row_top,
                width: width - half_w - 1,
                height: actual_h,
            });
            placed += 2;
        }
    }
    out
}

fn draw_footer(frame: &mut Frame, area: Rect, state: &AppState) {
    let base = if state.footer.is_empty() {
        "enter submit · tab agents/cron · / @ complete · esc".to_string()
    } else {
        state.footer.clone()
    };
    let text = if state.multi.active {
        format!("{base} · Ctrl+W cycle · Ctrl+Q exit")
    } else {
        base
    };
    // Ink-style: plain caption row; only highlight when a dashboard pane is focused.
    let style = match state.focus {
        FocusPane::Agents | FocusPane::Mode | FocusPane::Provider | FocusPane::Cron => {
            Style::default()
                .fg(Color::Black)
                .bg(Color::Yellow)
                .add_modifier(Modifier::BOLD)
        }
        FocusPane::Projects => Style::default()
            .fg(Color::Black)
            .bg(Color::Yellow)
            .add_modifier(Modifier::BOLD),
        FocusPane::AgentView => Style::default()
            .fg(Color::Black)
            .bg(Color::Magenta)
            .add_modifier(Modifier::BOLD),
        _ => Style::default().fg(Color::Cyan),
    };
    let paragraph = Paragraph::new(format!(" {text} ")).style(style);
    frame.render_widget(paragraph, area);
}

//! ratatui Presenter for chat / ucode surfaces.

use ansi_to_tui::IntoText;
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use unicode_width::UnicodeWidthStr;

pub(crate) use crate::agent_surface::pane_content_area;
use crate::agent_surface::{
    build_transcript_lines, build_transcript_lines_with_text_color, draw_input, pane_border_style,
};
#[cfg(test)]
use crate::agent_surface::{
    compact_assistant_paragraphs, is_speaker_stream_entry, UCODE_ASSISTANT_TEXT, UCODE_BANNER_BLUE,
    UCODE_BANNER_META, UCODE_TOOL_TEXT,
};
use crate::model::{AppState, FocusPane, MultiFocus, MultiPaneFrame, PromptState};

const SPINNER: &[char] = &['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Reuse the UI's existing theme blue (the same color as "Agents: none").

/// Draw UI and return hardware cursor position (x, y) for IME, if any.
pub fn draw(frame: &mut Frame, state: &mut AppState) -> Option<(u16, u16)> {
    let area = frame.area();
    let child_focused = focused_child(state).is_some();
    let status_h = if state.surface == "chat" { 0 } else { 1 };
    let project_h = if state.show_project_bar() { 1 } else { 0 };
    let completion_h =
        if !child_focused && state.focus == FocusPane::Completions && !state.completions.is_empty()
        {
            (state.completions.len().min(8) as u16)
                .saturating_add(2)
                .max(3)
        } else {
            0
        };
    let plan_h = if child_focused || state.plan_lines.is_empty() {
        0
    } else {
        (state.plan_lines.len() as u16).clamp(1, 8)
    };
    let interaction_h = if child_focused {
        0
    } else {
        state
            .interaction
            .as_ref()
            .map(|i| {
                let n = if i.lines.is_empty() { 1 } else { i.lines.len() };
                (n as u16).clamp(1, 6)
            })
            .unwrap_or(0)
    };
    let attach_h = if child_focused || state.attachment_labels.is_empty() {
        0
    } else {
        1
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(project_h),
            Constraint::Min(3),
            Constraint::Length(completion_h),
            Constraint::Length(plan_h),
            Constraint::Length(interaction_h),
            Constraint::Length(attach_h),
            Constraint::Length(status_h), // chat status lives in each pane's border
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
    if status_h > 0 {
        draw_status(frame, chunks[6], state);
    }
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

pub(crate) fn prompt_height(state: &AppState, width: u16) -> u16 {
    // Border consumes 2 rows; size the content area, then add chrome.
    let inner_width = width.saturating_sub(2);
    let inner = if state.surface == "chat" {
        pane_content_area(Rect::new(0, 0, inner_width, 1)).width
    } else {
        inner_width
    }
    .max(1) as usize;
    let mut rows = 0usize;
    for line in shared_prompt(state).lines() {
        let w = line.width().max(1);
        rows += (w + inner - 1) / inner;
    }
    let content = rows.clamp(1, 10) as u16;
    content.saturating_add(2).max(3)
}

fn prompt_accepts_typing(state: &AppState) -> bool {
    // Footer / project focus still routes printable keys into the draft, so the
    // hardware caret must stay inside the prompt box (IME / CJK preedit).
    match state.focus {
        FocusPane::AgentView => !state.agent_bar_focused,
        FocusPane::Completions => false,
        _ => true,
    }
}

/// Main log and prompt share the child panes' focus colors in split layouts.
fn main_border_style(state: &AppState) -> Style {
    if state.multi.active {
        pane_border_style(matches!(state.multi.focus, MultiFocus::Chat))
    } else {
        Style::default()
    }
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

fn draw_scrollback(frame: &mut Frame, area: Rect, state: &mut AppState) {
    let inner = Block::default().borders(Borders::ALL).inner(area);
    // Standalone ucode retains its existing inline gutter; embedded/chat
    // surfaces receive their gutter from the shared pane rectangle.
    let content = if state.surface == "ucode" {
        inner
    } else {
        pane_content_area(inner)
    };
    let max_rows = content.height as usize;
    let lines = build_scrollback_lines(state, content.width as usize);
    let total = lines.len();
    let max_off = total.saturating_sub(max_rows);
    state.scroll_max_off = max_off;
    if state.follow_tail {
        state.scroll_offset = 0;
    } else if state.scroll_offset > max_off {
        // Stop ↑N from climbing past the oldest line (content already pinned).
        state.scroll_offset = max_off;
    }

    // Keep the same brand title as single-pane mode (🛸 UFOO); only the
    // border/title color changes when multi focuses the ufoo chat side.
    let title = if !state.viewing_agent_id.is_empty() {
        format!(" agent · {} ", state.viewing_agent_label)
    } else if state.follow_tail {
        state.title.clone()
    } else {
        format!("{}↑{} ", state.title.trim_end(), state.scroll_offset)
    };
    let border_style = main_border_style(state);
    let mut block = Block::default()
        .title(Span::styled(title, border_style))
        .borders(Borders::ALL)
        .border_style(border_style);
    if state.surface == "chat" {
        block = block
            .title_bottom(Line::from(Span::styled(
                format!(" {} ", main_status_text(state)),
                Style::default().fg(Color::DarkGray),
            )))
            .title_bottom(
                Line::from(Span::styled(
                    format!(" {} ", display_version(state)),
                    Style::default().fg(Color::DarkGray),
                ))
                .right_aligned(),
            );
    }
    frame.render_widget(block, area);

    let offset = state.scroll_offset.min(max_off);
    let end = total.saturating_sub(offset);
    let start = end.saturating_sub(max_rows);
    let visible = lines[start..end].to_vec();
    frame.render_widget(Paragraph::new(visible), content);

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
    if state.surface == "chat" {
        let focused = !state.multi.active || matches!(state.multi.focus, MultiFocus::Chat);
        build_transcript_lines_with_text_color(
            &state.entries,
            width,
            false,
            focused.then_some(Color::Reset),
        )
    } else {
        build_transcript_lines(&state.entries, width, true)
    }
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
            Line::from(Span::styled(painted, Style::default().fg(Color::Magenta)))
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
        vec![format!("{}: {}", interaction.kind, interaction.prompt)]
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
            label.clone(),
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ));
    }
    let paragraph = Paragraph::new(Line::from(spans));
    frame.render_widget(paragraph, area);
}

fn focused_child(state: &AppState) -> Option<&MultiPaneFrame> {
    if state.multi.active && matches!(state.multi.focus, MultiFocus::Agent) {
        state.multi.frames.get(&state.multi.focus_agent_id)
    } else {
        None
    }
}

fn shared_prompt(state: &AppState) -> PromptState {
    let Some(pane) = focused_child(state) else {
        return state.prompt.clone();
    };
    // Child drafts are Node-owned and use UTF-16 offsets; Rust prompts use scalars.
    let mut units = 0;
    let cursor = pane
        .input
        .chars()
        .take_while(|ch| {
            units += ch.len_utf16();
            units <= pane.input_cursor
        })
        .count();
    PromptState {
        text: pane.input.clone(),
        cursor,
        ..Default::default()
    }
}

fn draw_prompt(frame: &mut Frame, area: Rect, state: &AppState) -> Option<(u16, u16)> {
    if state.multi.active && matches!(state.multi.focus, MultiFocus::Agent) {
        let label = state
            .multi
            .panes
            .iter()
            .find(|pane| pane.agent_id == state.multi.focus_agent_id)
            .map(|pane| pane.label.as_str())
            .unwrap_or(state.multi.focus_agent_id.as_str());
        return draw_input(
            frame,
            area,
            &shared_prompt(state),
            format!("› @{}", label.trim_start_matches('@')),
            pane_border_style(true),
            true,
            true,
        );
    }

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
        if state.surface == "chat" && !state.prompt_prefix.contains('@') {
            "› main".into()
        } else {
            state.prompt_prefix.trim_end().to_string()
        }
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
    draw_input(
        frame,
        area,
        &state.prompt,
        title,
        if state.multi.active {
            pane_border_style(true)
        } else {
            main_border_style(state)
        },
        prompt_accepts_typing(state),
        state.surface == "chat",
    )
}

fn draw_status(frame: &mut Frame, area: Rect, state: &AppState) {
    if let Some(pane) = focused_child(state) {
        let label = state
            .multi
            .panes
            .iter()
            .find(|desc| desc.agent_id == state.multi.focus_agent_id)
            .map(|desc| desc.label.as_str())
            .unwrap_or(state.multi.focus_agent_id.as_str());
        let text = format!(
            " @{} · {}",
            label.trim_start_matches('@'),
            multi_status_text(pane, state.spinner_ticks)
        );
        frame.render_widget(
            Paragraph::new(Span::styled(text, Style::default().fg(Color::DarkGray))),
            area,
        );
        return;
    }

    let version = display_version(state);
    let left = main_status_text(state);
    let version_w = version.width() as u16;
    let gap = area
        .width
        .saturating_sub(1 + left.width() as u16 + version_w);
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

fn main_status_text(state: &AppState) -> String {
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
                if state.multi.active {
                    format!(" ({secs}s)")
                } else {
                    format!(" ({secs}s, esc cancel)")
                }
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    let ask = if let Some(interaction) = state.interaction.as_ref() {
        format!(" | {}: {}", interaction.kind, interaction.prompt)
    } else if state.surface != "chat" && !state.agent_view_status.is_empty() {
        format!(" | {}", state.agent_view_status)
    } else {
        String::new()
    };
    let loop_bit = if state.loop_summary.is_empty() {
        String::new()
    } else {
        format!(" | {}", state.loop_summary)
    };
    let queue_bit = if state.queued_count > 0 {
        format!(" · queued {}", state.queued_count)
    } else if state.queue_cancel_requested {
        " · stopping…".to_string()
    } else {
        String::new()
    };
    format!(
        "{spin}{status}{elapsed}{ask}{loop_bit}{queue_bit}",
        status = if state.status.is_empty() {
            "ready"
        } else {
            state.status.as_str()
        }
    )
}

fn display_version(state: &AppState) -> String {
    format!("v{}", state.package_version)
}

/// Split the content area horizontally: ~1/3 chat scrollback on the left,
/// agent panes grid on the right. The viewport dispatch shares this layout.
fn draw_multi_content(frame: &mut Frame, area: Rect, state: &mut AppState) {
    state.multi.pane_rects.clear();
    let chat_w = (area.width / 3).max(4);
    let right_left = area.x.saturating_add(chat_w).saturating_add(1);
    let right_w = area.width.saturating_sub(chat_w).saturating_sub(1);
    let chat_area = Rect {
        x: area.x,
        y: area.y,
        width: chat_w,
        height: area.height,
    };
    state.multi.chat_rect = Some((chat_area.x, chat_area.y, chat_area.width, chat_area.height));
    // Chat scrollback keeps its own borders/title.
    draw_scrollback(frame, chat_area, state);
    if right_w < 4 || area.height < 3 {
        return;
    }
    let panes = layout_agent_panes(
        right_left,
        area.y,
        right_w,
        area.height,
        state.multi.panes.len(),
    );
    for (i, pane_area) in panes.iter().enumerate() {
        let Some(desc) = state.multi.panes.get(i) else {
            continue;
        };
        let focused = matches!(state.multi.focus, MultiFocus::Agent)
            && state.multi.focus_agent_id == desc.agent_id;
        state.multi.pane_rects.insert(
            desc.agent_id.clone(),
            (pane_area.x, pane_area.y, pane_area.width, pane_area.height),
        );
        draw_multi_pane(frame, *pane_area, state, i, focused);
    }
}

fn draw_multi_pane(frame: &mut Frame, area: Rect, state: &mut AppState, idx: usize, focused: bool) {
    let Some(desc) = state.multi.panes.get(idx).cloned() else {
        return;
    };
    if desc.mode != "internal" {
        return;
    }
    let pane = state.multi.frames.entry(desc.agent_id.clone()).or_default();
    let border_style = pane_border_style(focused);
    let block = Block::default()
        .title(format!(" {} ", desc.label))
        .borders(Borders::ALL)
        .border_style(border_style);
    let inner = pane_content_area(block.inner(area));
    let plan_height = (pane.plan.len() as u16)
        .min(3)
        .min(inner.height.saturating_sub(2));
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(0), Constraint::Length(plan_height)])
        .split(inner);
    let content = chunks[0];
    let lines = build_transcript_lines_with_text_color(
        &pane.entries,
        content.width as usize,
        false,
        focused.then_some(Color::Reset),
    );
    let max_off = lines.len().saturating_sub(content.height as usize);
    if pane.scroll_offset > 0 && pane.rendered_rows > 0 {
        pane.scroll_offset = pane
            .scroll_offset
            .saturating_add(lines.len().saturating_sub(pane.rendered_rows));
    }
    pane.rendered_rows = lines.len();
    pane.scroll_max_off = max_off;
    pane.scroll_offset = pane.scroll_offset.min(max_off);
    let skip = max_off.saturating_sub(pane.scroll_offset);
    frame.render_widget(
        block.title_bottom(Line::from(Span::styled(
            format!(" {} ", multi_status_text(pane, state.spinner_ticks)),
            Style::default().fg(Color::DarkGray),
        ))),
        area,
    );
    frame.render_widget(
        Paragraph::new(
            lines
                .into_iter()
                .skip(skip)
                .take(content.height as usize)
                .collect::<Vec<_>>(),
        ),
        content,
    );
    if plan_height > 0 {
        frame.render_widget(
            Paragraph::new(
                pane.plan
                    .iter()
                    .take(plan_height as usize)
                    .map(|line| Line::from(line.clone()))
                    .collect::<Vec<_>>(),
            ),
            chunks[1],
        );
    }
}

fn multi_status_text(pane: &MultiPaneFrame, spinner_ticks: u64) -> String {
    let spinner = if pane.busy {
        format!("{} ", SPINNER[spinner_ticks as usize % SPINNER.len()])
    } else {
        String::new()
    };
    let elapsed = if pane.busy && pane.started_at > 0 {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        format!(" · {}s", now.saturating_sub(pane.started_at) / 1000)
    } else {
        String::new()
    };
    let usage = if pane.usage.is_empty() {
        String::new()
    } else {
        format!(" · {}", pane.usage)
    };
    let scroll = if pane.scroll_offset > 0 {
        format!(" · ↑{}", pane.scroll_offset)
    } else {
        String::new()
    };
    let status = if pane.status.is_empty() {
        "ready"
    } else {
        pane.status.as_str()
    };
    format!("{spinner}{status}{elapsed}{usage}{scroll}")
}

/// Shared child grid for drawing and viewport sizing. Returns absolute Rects.
pub(crate) fn layout_agent_panes(
    left: u16,
    top: u16,
    width: u16,
    height: u16,
    count: usize,
) -> Vec<Rect> {
    if count == 0 || width == 0 || height == 0 {
        return Vec::new();
    }
    if count == 1 {
        return vec![Rect {
            x: left,
            y: top,
            width,
            height,
        }];
    }
    if count == 2 {
        let h1 = height / 2;
        return vec![
            Rect {
                x: left,
                y: top,
                width,
                height: h1,
            },
            Rect {
                x: left,
                y: top + h1,
                width,
                height: height - h1,
            },
        ];
    }
    let row_count = ((count as u16) + 1) / 2;
    let row_h = height / row_count;
    let mut out = Vec::with_capacity(count);
    let mut placed = 0usize;
    for row in 0..row_count {
        let row_top = top + row * row_h;
        let last_row = row == row_count - 1;
        let actual_h = if last_row {
            height - row * row_h
        } else {
            row_h
        };
        let remaining = count - placed;
        let is_odd = remaining % 2 == 1 && row == 0 && count % 2 == 1;
        if is_odd {
            out.push(Rect {
                x: left,
                y: row_top,
                width,
                height: actual_h,
            });
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

/// Footer controls remain usable while an internal child owns the shared input.
pub(crate) fn footer_focus_at(
    state: &AppState,
    column: u16,
    row: u16,
) -> Option<(FocusPane, Option<usize>)> {
    if state.multi.term_rows == 0
        || row != state.multi.term_rows - 1
        || column >= state.multi.term_cols
    {
        return None;
    }
    let text = state.footer.as_str();
    let hits = |needle: &str| {
        text.match_indices(needle).any(|(start, _)| {
            let left = 1 + text[..start].width();
            let right = left + needle.width();
            (column as usize) >= left && (column as usize) < right
        })
    };
    if state.focus == FocusPane::Provider {
        for (index, provider) in state.provider_options.iter().enumerate() {
            if hits(&provider.label) {
                return Some((FocusPane::Provider, Some(index)));
            }
        }
        return Some((FocusPane::Provider, None));
    }
    if state.focus == FocusPane::Cron {
        for (index, task) in state.cron_tasks.iter().enumerate() {
            if hits(&task.label) {
                return Some((FocusPane::Cron, Some(index)));
            }
        }
        return Some((FocusPane::Cron, None));
    }
    for (index, agent) in state.agents.iter().enumerate() {
        let needle = format!("@{}", agent.label.trim_start_matches('@'));
        let selected = text.match_indices(&needle).any(|(start, _)| {
            let end = start + needle.len();
            let suffix = &text[end..];
            let boundary =
                suffix.is_empty() || suffix.starts_with([',', ']']) || suffix.starts_with(" ·");
            let left = 1 + text[..start].width();
            boundary && (column as usize) >= left && (column as usize) < left + needle.width()
        });
        if selected {
            return Some((FocusPane::Agents, Some(index)));
        }
    }
    let provider = crate::model::provider_short(&state.agent_provider);
    if state.surface == "chat" && (hits(&format!(" · {provider}")) || hits("↓ settings")) {
        return Some((FocusPane::Provider, None));
    }
    let index = state
        .agents
        .iter()
        .position(|agent| agent.id == state.multi.focus_agent_id)
        .or_else(|| (!state.agents.is_empty()).then_some(0));
    Some((FocusPane::Agents, index))
}

fn draw_footer(frame: &mut Frame, area: Rect, state: &AppState) {
    let base = if state.footer.is_empty() {
        "enter submit · tab agents · / @ complete · esc".to_string()
    } else {
        state.footer.clone()
    };
    let text = if state.multi.active {
        format!("{base} · Tab switch")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_input_title_and_status_are_independent_of_child_status() {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 40)).unwrap();
        let mut state = AppState::new("ufoo", "chat");
        state.status = "Thinking…".into();
        state.agent_view_status = "child task".into();
        for split in [false, true] {
            state.multi.active = split;
            state.multi.focus = MultiFocus::Chat;
            terminal
                .draw(|frame| {
                    draw(frame, &mut state);
                })
                .unwrap();
            let buffer = terminal.backend().buffer();
            let row = |y| -> String {
                (0..120)
                    .map(|x| buffer.cell((x, y)).unwrap().symbol())
                    .collect()
            };
            assert!(row(36).contains("› main"));
            assert!(row(35).starts_with("└ Thinking… "));
            assert!(!row(35).contains("child task"));
        }
    }

    #[test]
    fn footer_clicks_use_unicode_cell_widths_and_distinguish_agent_names_from_settings() {
        let mut state = AppState::new("ufoo", "chat");
        state.multi.term_rows = 40;
        state.multi.term_cols = 120;
        state.agents = vec![
            crate::model::AgentItem {
                id: "a".into(),
                label: "coder".into(),
                activity_state: String::new(),
            },
            crate::model::AgentItem {
                id: "b".into(),
                label: "coder-review".into(),
                activity_state: String::new(),
            },
            crate::model::AgentItem {
                id: "c".into(),
                label: "中文".into(),
                activity_state: String::new(),
            },
        ];
        state.rebuild_footer();
        for (needle, index) in [("@coder,", 0), ("@coder-review", 1), ("@中文", 2)] {
            let start = state.footer.find(needle).unwrap();
            let column = (1 + state.footer[..start].width()) as u16;
            assert_eq!(
                footer_focus_at(&state, column, 39),
                Some((FocusPane::Agents, Some(index)))
            );
        }
        let start = state.footer.rfind("codex").unwrap();
        let column = (1 + state.footer[..start].width()) as u16;
        assert_eq!(
            footer_focus_at(&state, column, 39),
            Some((FocusPane::Provider, None))
        );
        assert_eq!(footer_focus_at(&state, column, 38), None);
    }

    #[test]
    fn agent_footer_precedes_compact_split_hint() {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 1)).unwrap();
        let mut state = AppState::new("ufoo", "chat");
        state.multi.active = true;
        state.multi.kind = "side".into();
        state.footer = "Agents: @coder".into();
        terminal
            .draw(|frame| draw_footer(frame, frame.area(), &state))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text: String = (0..80)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol())
            .collect();
        assert!(text.starts_with(" Agents: @coder · Tab switch"));
        assert!(!text.contains("Ctrl+"));
        state.footer = format!("Agents: {}", "agent metadata ".repeat(20));
        terminal
            .draw(|frame| draw_footer(frame, frame.area(), &state))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let text: String = (0..80)
            .map(|x| buffer.cell((x, 0)).unwrap().symbol())
            .collect();
        assert!(text.starts_with(" Agents:"));
        assert!(!text.contains("Tab switch"));
    }

    #[test]
    fn child_status_is_embedded_in_the_bottom_border_and_plan_stays_inside() {
        use crate::model::MultiPaneDesc;
        for (label, status) in [
            ("codex", "ready"),
            ("claude", "Thinking…"),
            ("ucode", "Reading file…"),
        ] {
            for focused in [false, true] {
                let mut terminal =
                    ratatui::Terminal::new(ratatui::backend::TestBackend::new(40, 12)).unwrap();
                let mut state = AppState::new("ufoo", "chat");
                state.multi.panes.push(MultiPaneDesc {
                    agent_id: label.into(),
                    label: label.into(),
                    mode: "internal".into(),
                });
                state.multi.frames.insert(
                    label.into(),
                    MultiPaneFrame {
                        status: status.into(),
                        plan: vec!["→ Next step".into()],
                        ..Default::default()
                    },
                );
                terminal
                    .draw(|frame| {
                        draw_multi_pane(frame, Rect::new(0, 0, 40, 10), &mut state, 0, focused);
                    })
                    .unwrap();
                let buffer = terminal.backend().buffer();
                let row = |y| -> String {
                    (0..40)
                        .map(|x| buffer.cell((x, y)).unwrap().symbol())
                        .collect()
                };
                assert!(row(0).contains(&format!(" {label} ")));
                assert!(row(9).starts_with(&format!("└ {status} ─")));
                assert!(row(9).ends_with('┘'));
                assert!(row(8).starts_with("│ → Next step"));
                assert!(row(10).trim().is_empty());
                assert_eq!(buffer.cell((39, 8)).unwrap().symbol(), "│");
                assert_eq!(
                    buffer.cell((0, 9)).unwrap().fg,
                    if focused {
                        Color::Cyan
                    } else {
                        Color::DarkGray
                    }
                );
            }
        }
    }

    #[test]
    fn selected_child_uses_the_single_bottom_input_and_keeps_output_padding() {
        use crate::model::{MultiPaneDesc, MultiPaneFrame};
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 40)).unwrap();
        let mut state = AppState::new("ufoo", "chat");
        state.status = "ready".into();
        state.multi.active = true;
        state.multi.focus = MultiFocus::Agent;
        state.multi.focus_agent_id = "codex:one".into();
        state.multi.term_cols = 120;
        state.multi.term_rows = 40;
        state.append_entry(crate::model::ScrollbackEntry {
            id: "main-output".into(),
            kind: "system".into(),
            text: "MAIN_OUTPUT".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });
        state.multi.panes.push(MultiPaneDesc {
            agent_id: "codex:one".into(),
            label: "coder".into(),
            mode: "internal".into(),
        });
        let viewport = crate::dispatch::multi_viewport_effects_public(&mut state);
        let cols = match &viewport[0] {
            crate::action::Effect::SendCommand { payload, .. } => {
                payload["panes"][0]["cols"].as_u64().unwrap() as usize
            }
            _ => panic!("child viewport missing"),
        };
        state.multi.frames.insert(
            "codex:one".into(),
            MultiPaneFrame {
                status: "working".into(),
                entries: [crate::model::ScrollbackEntry {
                    text: format!("CHILD_OUTPUT{}Z", "x".repeat(cols - 13)),
                    kind: "system".into(),
                    id: "child-output".into(),
                    speaker: String::new(),
                    expanded: false,
                    detail: String::new(),
                }]
                .into(),
                ..Default::default()
            },
        );
        let mut cursor = None;
        terminal
            .draw(|frame| {
                cursor = draw(frame, &mut state);
            })
            .unwrap();
        let (x, y) = cursor.expect("agent caret is visible even before typing");
        assert_eq!(x, 2);
        assert!(y >= 35);
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((1, 1)).unwrap().symbol(), " ");
        assert_eq!(buffer.cell((2, 1)).unwrap().symbol(), "M");
        assert_eq!(buffer.cell((42, 1)).unwrap().symbol(), " ");
        assert_eq!(buffer.cell((43, 1)).unwrap().symbol(), "C");
        assert_eq!(buffer.cell((43, 1)).unwrap().fg, Color::Reset);
        assert_eq!(
            buffer.cell((2, 1)).unwrap().fg,
            crate::agent_surface::UCODE_SYSTEM_TEXT
        );
        assert_eq!(buffer.cell((117, 1)).unwrap().symbol(), "Z");
        assert_eq!(buffer.cell((118, 1)).unwrap().symbol(), " ");
        assert_eq!(buffer.cell((1, y - 1)).unwrap().symbol(), "›");
        assert_eq!(buffer.cell((41, y - 1)).unwrap().symbol(), "─");
        let status: String = (41..120)
            .map(|x| buffer.cell((x, y - 2)).unwrap().symbol())
            .collect();
        assert!(status.starts_with("└ working ─"));
        let main_status: String = (0..40)
            .map(|x| buffer.cell((x, y - 2)).unwrap().symbol())
            .collect();
        assert!(main_status.starts_with("└ ready ─"));
        state.multi.focus = MultiFocus::Chat;
        terminal
            .draw(|frame| {
                cursor = draw(frame, &mut state);
            })
            .unwrap();
        assert!(cursor.unwrap().0 < 40);
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((2, 1)).unwrap().fg, Color::Reset);
        assert_eq!(
            buffer.cell((43, 1)).unwrap().fg,
            crate::agent_surface::UCODE_SYSTEM_TEXT
        );
    }

    #[test]
    fn embedded_input_shares_multiline_chrome_and_utf16_caret_mapping() {
        use crate::model::{MultiPaneDesc, MultiPaneFrame};
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(120, 40)).unwrap();
        let mut state = AppState::new("ufoo", "chat");
        state.multi.active = true;
        state.multi.focus = MultiFocus::Agent;
        state.multi.focus_agent_id = "native".into();
        state.multi.panes.push(MultiPaneDesc {
            agent_id: "native".into(),
            label: "ucode".into(),
            mode: "internal".into(),
        });
        state.multi.frames.insert(
            "native".into(),
            MultiPaneFrame {
                input: "你好🙂abc\nsecond".into(),
                input_cursor: 4,
                busy: true,
                status: "Thinking…".into(),
                ..Default::default()
            },
        );
        let mut caret = None;
        terminal
            .draw(|frame| caret = draw(frame, &mut state))
            .unwrap();
        let (x, y) = caret.unwrap();
        assert_eq!(x, 8); // x=2 + two CJK cells + emoji width=2
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((2, y)).unwrap().symbol(), "你");
        assert_eq!(buffer.cell((2, y + 1)).unwrap().symbol(), "s");
        assert_eq!(buffer.cell((1, y - 1)).unwrap().symbol(), "›");
        assert_eq!(buffer.cell((0, y - 1)).unwrap().fg, Color::Cyan);
        state.multi.focus = MultiFocus::Chat;
        terminal
            .draw(|frame| {
                draw(frame, &mut state);
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(buffer.cell((41, 0)).unwrap().fg, Color::DarkGray);
        assert_eq!(buffer.cell((0, 36)).unwrap().fg, Color::Cyan);
    }

    #[test]
    fn status_version_uses_host_package_version() {
        let mut state = AppState::new("ufoo", "chat");
        state.package_version = "3.0.23".into();

        assert_eq!(display_version(&state), "v3.0.23");
    }

    #[test]
    fn banner_entries_do_not_join_the_transcript_zebra_stream() {
        let entry = crate::model::ScrollbackEntry {
            id: "banner-0".into(),
            kind: "banner".into(),
            text: "UCODE".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        };

        assert!(!is_speaker_stream_entry(&entry));
    }

    #[test]
    fn banner_line_uses_layout_gutter_without_mutating_literal_content() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "banner-0".into(),
            kind: "banner".into(),
            text: "█ █ █▀▀ █▀█ █▀▄ █▀▀".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });

        let lines = build_scrollback_lines(&state, 80);
        let rendered: String = lines[0]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        assert_eq!(rendered, " █ █ █▀▀ █▀█ █▀▄ █▀▀");
        assert_eq!(lines[0].spans[0].content.as_ref(), " ");
        assert_eq!(lines[0].spans[1].content.as_ref(), "█ █ █▀▀ █▀█ █▀▄ █▀▀");
    }

    #[test]
    fn banner_uses_ufoo_blue_for_logo_and_muted_gray_for_metadata() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "banner-0".into(),
            kind: "banner".into(),
            text: "UCODE".into(),
            speaker: String::new(),
            expanded: false,
            detail: "Model: test".into(),
        });

        let lines = build_scrollback_lines(&state, 80);
        assert_eq!(lines[0].spans[1].style.fg, Some(UCODE_BANNER_BLUE));
        assert_eq!(lines[0].spans[3].style.fg, Some(UCODE_BANNER_META));
    }

    #[test]
    fn consecutive_banner_rows_do_not_gain_blank_log_lines() {
        let mut state = AppState::new("ufoo", "ucode");
        for (index, text) in ["top", "middle", "bottom"].iter().enumerate() {
            state.append_entry(crate::model::ScrollbackEntry {
                id: format!("banner-{index}"),
                kind: "banner".into(),
                text: (*text).into(),
                speaker: String::new(),
                expanded: false,
                detail: String::new(),
            });
        }

        let lines = build_scrollback_lines(&state, 80);
        assert_eq!(lines.len(), 3);
    }

    #[test]
    fn markdown_table_rows_do_not_gain_implicit_blank_lines() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "table-0".into(),
            kind: "assistant".into(),
            text: "| file | time | size |\n| --- | --- | --- |\n| current.jsonl | today | 152K |"
                .into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });

        let lines = build_scrollback_lines(&state, 120);
        assert_eq!(lines.len(), 4);
        assert!(lines[..3].iter().all(|line| !line.spans.is_empty()));
        assert!(lines[3].spans.is_empty());
    }

    #[test]
    fn assistant_paragraph_gaps_are_compact_but_code_whitespace_is_preserved() {
        assert_eq!(
            compact_assistant_paragraphs("\nfirst\n\n\n \nsecond\n\n\n"),
            "first\n\nsecond"
        );
        for marker in ["```", "~~~"] {
            let code = format!("{marker}text\na\n\n\nb\n{marker}");
            assert_eq!(compact_assistant_paragraphs(&code), code);
        }
        assert_eq!(compact_assistant_paragraphs("```\na\n\n\n"), "```\na\n\n");
    }

    #[test]
    fn assistant_block_uses_one_leading_bullet_only_on_its_first_line() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "assistant-1".into(),
            kind: "assistant".into(),
            text: "first line\n- markdown item\nlast line".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });

        let lines = build_scrollback_lines(&state, 80);
        let rendered: Vec<String> = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        assert_eq!(rendered.len(), 4);
        assert_eq!(rendered[0], " • first line");
        assert_eq!(rendered[1], "   - markdown item");
        assert_eq!(rendered[2], "   last line");
        assert_eq!(rendered[3], "");
    }

    #[test]
    fn collapsed_bash_tool_stays_on_one_row_and_uses_three_dot_overflow() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "tool-1".into(),
            kind: "tool".into(),
            text: "• Bash printf '%s' this-is-a-very-long-command".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });

        let lines = build_scrollback_lines(&state, 24);
        assert_eq!(lines.len(), 2);
        let rendered: String = lines[0]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        assert!(rendered.ends_with("..."));
        assert!(rendered.width() <= 24);
        let action = lines[0]
            .spans
            .iter()
            .find(|span| span.content.as_ref() == "Bash")
            .expect("bold Bash action span");
        assert!(action.style.add_modifier.contains(Modifier::BOLD));
        let command = lines[0]
            .spans
            .iter()
            .find(|span| span.content.starts_with(" printf"))
            .expect("plain command span");
        assert!(!command.style.add_modifier.contains(Modifier::BOLD));
        assert!(lines[1].spans.is_empty());
    }

    #[test]
    fn collapsed_tool_group_keeps_first_and_live_tail_as_three_tree_rows() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "tools".into(),
            kind: "tool".into(),
            text: "• Read first.rs · +4 calls (Ctrl+O expand)".into(),
            speaker: String::new(),
            expanded: false,
            detail: "Read first.rs\nBash second\nEdit third.rs\nRead fourth.rs\nWrite fifth.rs"
                .into(),
        });

        let lines = build_scrollback_lines(&state, 100);
        let rendered: Vec<String> = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        assert_eq!(
            rendered,
            vec![
                " Read first.rs (Ctrl+O expand)",
                " ├─ ... Read fourth.rs",
                " └─ Write fifth.rs",
                "",
            ]
        );
    }

    #[test]
    fn expanded_tool_group_shows_every_tree_row() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "tools".into(),
            kind: "tool".into(),
            text: "• Read first.rs · +3 calls (Ctrl+O expand)".into(),
            speaker: String::new(),
            expanded: true,
            detail: "Read first.rs\nBash second\nEdit third.rs\nWrite fourth.rs".into(),
        });

        let lines = build_scrollback_lines(&state, 100);
        let rendered: Vec<String> = lines
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        assert_eq!(
            rendered,
            vec![
                " Read first.rs",
                " ├─ Bash second",
                " ├─ Edit third.rs",
                " └─ Write fourth.rs",
                "",
            ]
        );
    }

    #[test]
    fn tool_rows_are_light_and_assistant_replies_are_dark_regardless_of_order() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "tool-1".into(),
            kind: "tool".into(),
            text: "• Bash pwd".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });
        state.append_entry(crate::model::ScrollbackEntry {
            id: "assistant-1".into(),
            kind: "assistant".into(),
            text: "Found it.".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });

        let lines = build_scrollback_lines(&state, 80);
        assert!(lines[0]
            .spans
            .iter()
            .skip(1)
            .all(|span| span.style.fg == Some(UCODE_TOOL_TEXT)));
        assert!(lines[2]
            .spans
            .iter()
            .skip(1)
            .all(|span| span.style.fg == Some(UCODE_ASSISTANT_TEXT)));
        assert_ne!(UCODE_TOOL_TEXT, UCODE_ASSISTANT_TEXT);
    }

    #[test]
    fn explicit_spacer_entry_is_the_only_automatic_vertical_gap() {
        let mut state = AppState::new("ufoo", "ucode");
        for (index, (kind, text)) in [
            ("assistant", "before"),
            ("spacer", ""),
            ("assistant", "after"),
        ]
        .iter()
        .enumerate()
        {
            state.append_entry(crate::model::ScrollbackEntry {
                id: format!("row-{index}"),
                kind: (*kind).into(),
                text: (*text).into(),
                speaker: String::new(),
                expanded: false,
                detail: String::new(),
            });
        }

        let lines = build_scrollback_lines(&state, 80);
        assert_eq!(lines.len(), 4);
        assert!(lines[1].spans.is_empty());
        assert!(lines[3].spans.is_empty());
    }

    #[test]
    fn thinking_block_keeps_the_latest_four_visual_rows_until_expanded() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "thinking-1".into(),
            kind: "thinking".into(),
            text: "one\ntwo\nthree\nfour\nfive".into(),
            speaker: String::new(),
            expanded: false,
            detail: String::new(),
        });

        let collapsed = build_scrollback_lines(&state, 80);
        assert_eq!(collapsed.len(), 5);
        let first: String = collapsed[0]
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect();
        assert!(first.trim_start().starts_with("… two"));
        for line in &collapsed[1..4] {
            let content = line.spans[1].content.as_ref();
            assert!(content.starts_with("  "));
            assert!(!content.starts_with("           "));
        }

        state.entries.front_mut().expect("thinking entry").expanded = true;
        let expanded = build_scrollback_lines(&state, 80);
        assert_eq!(expanded.len(), 6);
        assert_eq!(expanded[0].spans[1].content.as_ref(), "Thinking · one");
        assert_eq!(expanded[1].spans[1].content.as_ref(), "           two");
    }

    #[test]
    fn expanded_thinking_soft_wrap_and_hard_newline_share_continuation_indent() {
        let mut state = AppState::new("ufoo", "ucode");
        state.append_entry(crate::model::ScrollbackEntry {
            id: "thinking-wrap".into(),
            kind: "thinking".into(),
            text: "abcdefghijklmnop\nnext".into(),
            speaker: String::new(),
            expanded: true,
            detail: String::new(),
        });

        let lines = build_scrollback_lines(&state, 20);
        assert_eq!(lines[0].spans[1].content.as_ref(), "Thinking · abcdefgh");
        assert_eq!(lines[1].spans[1].content.as_ref(), "           ijklmnop");
        assert_eq!(lines[2].spans[1].content.as_ref(), "           next");
        assert!(lines[3].spans.is_empty());
    }
}

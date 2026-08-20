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
// Reuse the UI's existing theme blue (the same color as "Agents: none").
const UCODE_BANNER_BLUE: Color = Color::Cyan;
const UCODE_BANNER_META: Color = Color::Rgb(163, 171, 183);
const UCODE_TOOL_TEXT: Color = Color::Rgb(168, 172, 178);
const UCODE_ASSISTANT_TEXT: Color = Color::Rgb(112, 116, 122);
const UCODE_SYSTEM_TEXT: Color = Color::Rgb(138, 142, 148);

/// Draw UI and return hardware cursor position (x, y) for IME, if any.
pub fn draw(frame: &mut Frame, state: &mut AppState) -> Option<(u16, u16)> {
    let area = frame.area();
    let project_h = if state.show_project_bar() { 1 } else { 0 };
    let completion_h = if state.focus == FocusPane::Completions && !state.completions.is_empty() {
        (state.completions.len().min(8) as u16)
            .saturating_add(2)
            .max(3)
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
    let attach_h = if state.attachment_labels.is_empty() {
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

fn draw_scrollback(frame: &mut Frame, area: Rect, state: &mut AppState) {
    let ufoo_hi = multi_ufoo_focused(state);
    let inner = Block::default().borders(Borders::ALL).inner(area);
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

fn strip_ansi_codes(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() {
                    let b = bytes[i];
                    i += 1;
                    if (b'@'..=b'~').contains(&b) {
                        break;
                    }
                }
            }
            continue;
        }
        let ch = input[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn is_speaker_stream_entry(entry: &crate::model::ScrollbackEntry) -> bool {
    // Nearly all chat rows zebra; keep tools dim/unstriped so collapsed
    // tool dumps don't dominate the stripe rhythm. Banners are preformatted
    // presentation content, and thinking is a transient mutable log block.
    !matches!(
        entry.kind.as_str(),
        "tool" | "spacer" | "banner" | "thinking"
    )
}

fn wrap_entry_visual_lines(
    body: &str,
    first_prefix: &str,
    continuation_prefix: &str,
    content_width: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    for (line_idx, line) in body.lines().enumerate() {
        let mut prefix = if line_idx == 0 {
            first_prefix
        } else {
            continuation_prefix
        };
        let mut rest = line;
        if rest.is_empty() {
            out.push(prefix.to_string());
            continue;
        }
        while !rest.is_empty() {
            let available = content_width.saturating_sub(prefix.width()).max(1);
            let mut used = 0usize;
            let mut cut = rest.len();
            for (idx, ch) in rest.char_indices() {
                let w = ch.width().unwrap_or(1);
                if used + w > available && used > 0 {
                    cut = idx;
                    break;
                }
                used += w;
                cut = idx + ch.len_utf8();
            }
            let (chunk, next) = rest.split_at(cut);
            out.push(format!("{prefix}{chunk}"));
            rest = next;
            prefix = continuation_prefix;
            if cut == 0 {
                break;
            }
        }
    }
    out
}

fn truncate_single_visual_line(text: &str, content_width: usize) -> String {
    let single_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if single_line.width() <= content_width {
        return single_line;
    }
    if content_width <= 3 {
        return ".".repeat(content_width);
    }

    let target = content_width - 3;
    let mut out = String::new();
    let mut used = 0usize;
    for ch in single_line.chars() {
        let width = ch.width().unwrap_or(1);
        if used + width > target {
            break;
        }
        out.push(ch);
        used += width;
    }
    out.push_str("...");
    out
}

fn tool_tree_line(
    raw: &str,
    branch: &str,
    omitted: bool,
    hint: &str,
    content_width: usize,
    style: Style,
) -> Line<'static> {
    let clean = raw.trim().strip_prefix("• ").unwrap_or(raw.trim());
    let omission = if omitted { "... " } else { "" };
    let decorated = format!("{branch}{omission}{clean}{hint}");
    let truncated = truncate_single_visual_line(&decorated, content_width);
    let mut spans = vec![Span::raw(" ".to_string())];
    let rest = truncated.strip_prefix(branch).unwrap_or(truncated.as_str());
    spans.push(Span::styled(branch.to_string(), style));
    let rest = if omitted {
        if let Some(value) = rest.strip_prefix("... ") {
            spans.push(Span::styled("... ".to_string(), style));
            value
        } else {
            rest
        }
    } else {
        rest
    };
    let (action, command) = rest.split_once(' ').unwrap_or((rest, ""));
    spans.push(Span::styled(
        action.to_string(),
        style.add_modifier(Modifier::BOLD),
    ));
    if !command.is_empty() {
        spans.push(Span::styled(format!(" {command}"), style));
    }
    Line::from(spans)
}

fn collapsed_tool_tree_rows<'a>(lines: &'a [&'a str]) -> Vec<(&'a str, bool)> {
    match lines.len() {
        0 => Vec::new(),
        1..=3 => lines.iter().map(|line| (*line, false)).collect(),
        count => vec![
            (lines[0], false),
            (lines[count - 2], true),
            (lines[count - 1], false),
        ],
    }
}

fn build_scrollback_lines(state: &AppState, width: usize) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    let pad = " ";
    for (entry_idx, entry) in state.entries.iter().enumerate() {
        // Transcript entries are content, not layout boundaries. Markdown
        // renderers commonly emit one entry per visual row (tables, lists,
        // code blocks), so inserting a gap between every entry corrupts the
        // original layout. Callers that need vertical space send an explicit
        // spacer entry instead.
        if entry.kind == "spacer" {
            out.push(Line::from(""));
            continue;
        }
        let append_block_gap = entry.kind != "banner"
            && state
                .entries
                .get(entry_idx + 1)
                .is_none_or(|next| next.kind != "spacer");
        let mut body = entry.text.clone();

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

        let speaker_stream = is_speaker_stream_entry(entry);
        // Markdown chalk (bold→whiteBright) punched random white holes into
        // solid-colored semantic rows. Strip it before applying role colors.
        if (speaker_stream || entry.kind == "thinking") && body.contains('\u{1b}') {
            body = strip_ansi_codes(&body);
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
            "tool" => (String::new(), Style::default().fg(UCODE_TOOL_TEXT)),
            "banner" => (String::new(), Style::default()),
            "thinking" => (
                "Thinking · ".to_string(),
                Style::default().fg(Color::Rgb(121, 142, 164)),
            ),
            "assistant" => (
                if entry.speaker.is_empty() {
                    "• ".to_string()
                } else {
                    format!("• {} · ", entry.speaker)
                },
                Style::default().fg(UCODE_ASSISTANT_TEXT),
            ),
            "bus" | "agent" | "report" | "success" | "system" | "meta" => (
                if entry.speaker.is_empty() {
                    String::new()
                } else {
                    format!("{} · ", entry.speaker)
                },
                match entry.kind.as_str() {
                    "bus" => Style::default().fg(Color::Yellow),
                    "success" => Style::default().fg(Color::Green),
                    "system" | "meta" => Style::default().fg(UCODE_SYSTEM_TEXT),
                    _ => Style::default().fg(UCODE_ASSISTANT_TEXT),
                },
            ),
            _ => (
                if entry.speaker.is_empty() {
                    String::new()
                } else {
                    format!("{} · ", entry.speaker)
                },
                Style::default().fg(UCODE_ASSISTANT_TEXT),
            ),
        };
        let content_width = width.saturating_sub(pad.width()).max(1);
        if entry.kind == "thinking" {
            let continuation = " ".repeat(prefix.width());
            let mut lines = wrap_entry_visual_lines(&body, &prefix, &continuation, content_width);
            if !entry.expanded && lines.len() > 4 {
                let gutter = "  ";
                lines = wrap_entry_visual_lines(&body, gutter, gutter, content_width);
                if lines.len() > 4 {
                    lines = lines.split_off(lines.len() - 4);
                }
                if let Some(first) = lines.first_mut() {
                    let content = first
                        .strip_prefix(gutter)
                        .unwrap_or(first.as_str())
                        .to_string();
                    *first = format!("… {content}");
                }
            }
            for line in lines {
                out.push(Line::from(vec![
                    Span::raw(pad.to_string()),
                    Span::styled(line, kind_style),
                ]));
            }
            if append_block_gap {
                out.push(Line::from(""));
            }
            continue;
        }
        if entry.kind == "banner" {
            let has_body = !body.is_empty();
            let mut spans = vec![Span::raw(pad.to_string())];
            if has_body {
                spans.push(Span::styled(body, Style::default().fg(UCODE_BANNER_BLUE)));
            }
            if !entry.detail.is_empty() {
                if has_body {
                    spans.push(Span::raw("  "));
                }
                spans.push(Span::styled(
                    entry.detail.clone(),
                    Style::default().fg(UCODE_BANNER_META),
                ));
            }
            if has_body || !entry.detail.is_empty() {
                out.push(Line::from(spans));
            }
            continue;
        }
        if entry.kind == "tool" && !entry.detail.is_empty() {
            let detail_lines: Vec<&str> = entry
                .detail
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect();
            if detail_lines.len() >= 2 {
                let visible = if entry.expanded {
                    detail_lines.iter().map(|line| (*line, false)).collect()
                } else {
                    collapsed_tool_tree_rows(&detail_lines)
                };
                let visible_len = visible.len();
                for (index, (line, omitted)) in visible.into_iter().enumerate() {
                    let branch = if index == 0 {
                        ""
                    } else if index + 1 == visible_len {
                        "└─ "
                    } else {
                        "├─ "
                    };
                    let hint = if !entry.expanded && index == 0 {
                        " (Ctrl+O expand)"
                    } else {
                        ""
                    };
                    out.push(tool_tree_line(
                        line,
                        branch,
                        omitted,
                        hint,
                        content_width,
                        kind_style,
                    ));
                }
                if append_block_gap {
                    out.push(Line::from(""));
                }
                continue;
            }
        }
        if entry.kind == "tool" && !entry.expanded {
            let line = truncate_single_visual_line(&body, content_width);
            let mut spans = vec![Span::raw(pad.to_string())];
            if let Some(rest) = line.strip_prefix("• ") {
                let (action, command) = rest.split_once(' ').unwrap_or((rest, ""));
                spans.push(Span::styled("• ", kind_style));
                spans.push(Span::styled(
                    action.to_string(),
                    kind_style.add_modifier(Modifier::BOLD),
                ));
                if !command.is_empty() {
                    spans.push(Span::styled(format!(" {command}"), kind_style));
                }
            } else {
                spans.push(Span::styled(line, kind_style));
            }
            out.push(Line::from(spans));
            if append_block_gap {
                out.push(Line::from(""));
            }
            continue;
        }
        for (line_idx, line) in body.lines().enumerate() {
            let head = if line_idx == 0 {
                format!("{prefix}{line}")
            } else {
                format!("{:width$}{line}", "", width = prefix.width())
            };
            // Speaker-stream rows always use zebra flat paint (no ANSI path).
            if !speaker_stream && head.contains('\u{1b}') {
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
                let content = if entry.kind == "banner" {
                    // A banner is literal terminal content, not a styled log span.
                    Span::raw(chunk.to_string())
                } else {
                    Span::styled(chunk.to_string(), kind_style)
                };
                let mut spans = Vec::with_capacity(2);
                if entry.kind != "banner" {
                    spans.push(Span::raw(pad.to_string()));
                }
                spans.push(content);
                out.push(Line::from(spans));
                rest = next.to_string();
                if cut == 0 {
                    break;
                }
            }
        }
        if append_block_gap {
            out.push(Line::from(""));
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
    let y = inner
        .y
        .saturating_add(vis_row.min(inner.height.saturating_sub(1)));
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
    let version = display_version(state);
    let left = format!(
        "{spin}{status}{elapsed}{ask}{loop_bit}",
        status = if state.status.is_empty() {
            "ready"
        } else {
            state.status.as_str()
        }
    );
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

fn display_version(state: &AppState) -> String {
    format!("v{}", state.package_version)
}

/// Split the content area horizontally: ~1/3 chat scrollback on the left,
/// agent panes grid on the right. Ports paneLayout.js::layoutAgentPanes so the
/// Rust presentation and Node's `multi.viewport` calculation stay in sync.
fn draw_multi_content(frame: &mut Frame, area: Rect, state: &mut AppState) {
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
        draw_multi_pane(frame, *pane_area, state, i, focused);
    }
}

fn draw_multi_pane(frame: &mut Frame, area: Rect, state: &AppState, idx: usize, focused: bool) {
    let Some(desc) = state.multi.panes.get(idx) else {
        return;
    };
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
                    Span::styled("› ".to_string(), Style::default().fg(Color::Magenta)),
                    Span::raw(frame_state.input.clone()),
                ]));
            }
            out
        })
        .unwrap_or_else(|| {
            vec![Line::from(Span::styled(
                "(waiting for frame…)",
                Style::default().fg(Color::DarkGray),
            ))]
        });

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

#[cfg(test)]
mod tests {
    use super::*;

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

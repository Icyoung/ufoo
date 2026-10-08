//! Shared coding-agent transcript, tool/thinking presentation, input and focus chrome.
//! Used by standalone ucode and every embedded internal agent; no provider coupling.
use ansi_to_tui::IntoText;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub(crate) const UCODE_BANNER_BLUE: Color = Color::Cyan;
pub(crate) const UCODE_BANNER_META: Color = Color::Rgb(163, 171, 183);
pub(crate) const UCODE_TOOL_TEXT: Color = Color::Rgb(168, 172, 178);
pub(crate) const UCODE_ASSISTANT_TEXT: Color = Color::Rgb(112, 116, 122);
pub(crate) const UCODE_SYSTEM_TEXT: Color = Color::Rgb(138, 142, 148);
pub(crate) fn pane_border_style(focused: bool) -> Style {
    if focused {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::DarkGray)
    }
}

/// One cell of horizontal space inside each border, shared by logs and inputs.
pub(crate) fn pane_content_area(inner: Rect) -> Rect {
    let padding = if inner.width > 2 { 1 } else { 0 };
    Rect {
        x: inner.x.saturating_add(padding),
        width: inner.width.saturating_sub(padding * 2),
        ..inner
    }
}

pub(crate) fn strip_ansi_codes(input: &str) -> String {
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

pub(crate) fn is_speaker_stream_entry(entry: &crate::model::ScrollbackEntry) -> bool {
    // Nearly all chat rows zebra; keep tools dim/unstriped so collapsed
    // tool dumps don't dominate the stripe rhythm. Banners are preformatted
    // presentation content, and thinking is a transient mutable log block.
    !matches!(
        entry.kind.as_str(),
        "tool" | "spacer" | "banner" | "thinking"
    )
}

pub(crate) fn wrap_entry_visual_lines(
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

pub(crate) fn truncate_single_visual_line(text: &str, content_width: usize) -> String {
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

pub(crate) fn tool_tree_line(
    raw: &str,
    branch: &str,
    omitted: bool,
    hint: &str,
    content_width: usize,
    style: Style,
    pad: &str,
) -> Line<'static> {
    let clean = raw.trim().strip_prefix("• ").unwrap_or(raw.trim());
    let omission = if omitted { "... " } else { "" };
    let decorated = format!("{branch}{omission}{clean}{hint}");
    let truncated = truncate_single_visual_line(&decorated, content_width);
    let mut spans = vec![Span::raw(pad.to_string())];
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

pub(crate) fn collapsed_tool_tree_rows<'a>(lines: &'a [&'a str]) -> Vec<(&'a str, bool)> {
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

pub(crate) fn compact_assistant_paragraphs(text: &str) -> String {
    let mut lines = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut blank = false;
    for line in text.lines() {
        let trimmed = line.trim();
        let marker = trimmed.chars().next().unwrap_or(' ');
        let count = trimmed.chars().take_while(|ch| *ch == marker).count();
        let in_code = fence.is_some();
        if marker == '`' || marker == '~' {
            if let Some((open_marker, open_count)) = fence {
                if marker == open_marker
                    && count >= open_count
                    && trimmed[count..].trim().is_empty()
                {
                    fence = None;
                }
            } else if count >= 3 {
                fence = Some((marker, count));
            }
        }
        if !in_code && trimmed.is_empty() {
            if blank || lines.is_empty() {
                continue;
            }
            blank = true;
        } else {
            blank = false;
        }
        lines.push(line);
    }
    // The renderer supplies the inter-message gap itself.
    if fence.is_none() {
        while lines.last().is_some_and(|line| line.trim().is_empty()) {
            lines.pop();
        }
    }
    lines.join("\n")
}

pub(crate) fn build_transcript_lines(
    entries: &std::collections::VecDeque<crate::model::ScrollbackEntry>,
    width: usize,
    inline_padding: bool,
) -> Vec<Line<'static>> {
    build_transcript_lines_with_text_color(entries, width, inline_padding, None)
}

/// Focused dashboard bodies use the terminal's default foreground so both dark
/// and light themes remain readable. Semantic tool / thinking / error colors
/// and standalone ucode's existing palette are preserved.
pub(crate) fn build_transcript_lines_with_text_color(
    entries: &std::collections::VecDeque<crate::model::ScrollbackEntry>,
    width: usize,
    inline_padding: bool,
    text_color: Option<Color>,
) -> Vec<Line<'static>> {
    let mut out = Vec::new();
    // Chat padding belongs to the pane, so semantic rows cannot add it twice.
    let pad = if inline_padding { " " } else { "" };
    for (entry_idx, entry) in entries.iter().enumerate() {
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
            && entries
                .get(entry_idx + 1)
                .is_none_or(|next| next.kind != "spacer");
        let mut body = entry.text.clone();
        if entry.kind == "assistant" {
            body = compact_assistant_paragraphs(&body);
        }

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
                Style::default().fg(text_color.unwrap_or(UCODE_ASSISTANT_TEXT)),
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
                    "system" | "meta" => {
                        Style::default().fg(text_color.unwrap_or(UCODE_SYSTEM_TEXT))
                    }
                    _ => Style::default().fg(text_color.unwrap_or(UCODE_ASSISTANT_TEXT)),
                },
            ),
            _ => (
                if entry.speaker.is_empty() {
                    String::new()
                } else {
                    format!("{} · ", entry.speaker)
                },
                Style::default().fg(text_color.unwrap_or(UCODE_ASSISTANT_TEXT)),
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
                        pad,
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

pub(crate) fn draw_input(
    frame: &mut Frame,
    area: Rect,
    prompt: &crate::model::PromptState,
    title: String,
    border_style: Style,
    show_caret: bool,
    padded: bool,
) -> Option<(u16, u16)> {
    let block = Block::default()
        .title(Span::styled(title, border_style))
        .borders(Borders::ALL)
        .border_style(border_style);
    let inner = if padded {
        pane_content_area(block.inner(area))
    } else {
        block.inner(area)
    };
    frame.render_widget(block, area);
    if inner.width == 0 || inner.height == 0 {
        return None;
    }
    let inner_w = inner.width.max(1) as usize;

    // Soft-wrap draft into visual rows and map the caret onto them.
    let chars: Vec<char> = prompt.text.chars().collect();
    let mut visual_rows: Vec<String> = Vec::new();
    let mut caret_row = 0usize;
    let mut caret_col = 0usize;
    let mut row = String::new();
    let mut row_w = 0usize;

    if chars.is_empty() {
        visual_rows.push(String::new());
    } else {
        for (i, ch) in chars.iter().enumerate() {
            if i == prompt.cursor {
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
        if prompt.cursor >= chars.len() {
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

    frame.render_widget(Paragraph::new(visible), inner);

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

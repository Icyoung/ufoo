//! Select visible transcript cells inside one pane, independently of terminal mouse capture.

use ratatui::buffer::Buffer;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Color, Modifier};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone)]
struct Drag {
    area: Rect,
    snapshot: Buffer,
    anchor: Position,
    head: Position,
    moved: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TextSelection {
    regions: Vec<Rect>,
    screen: Option<Buffer>,
    drag: Option<Drag>,
}

impl TextSelection {
    pub fn begin_frame(&mut self) {
        self.regions.clear();
    }

    pub fn register(&mut self, area: Rect) {
        if !area.is_empty() {
            self.regions.push(area);
        }
    }

    pub fn finish_frame(&mut self, buffer: &mut Buffer) {
        if self
            .drag
            .as_ref()
            .is_some_and(|drag| !self.regions.contains(&drag.area))
        {
            self.clear();
        }
        // Preserve the cells being selected while streamed text keeps updating
        // the underlying transcript. Other panes and status bars remain live.
        if let Some(drag) = self.drag.as_ref().filter(|drag| drag.moved) {
            let (start, end) = drag.bounds();
            let end_right = end.x.saturating_add(
                drag.snapshot
                    .cell(end)
                    .map(|cell| cell.symbol().width())
                    .unwrap_or(1)
                    .max(1) as u16,
            );
            for y in drag.area.y..drag.area.bottom() {
                for x in drag.area.x..drag.area.right() {
                    let Some(source) = drag.snapshot.cell((x, y)) else {
                        continue;
                    };
                    let Some(cell) = buffer.cell_mut((x, y)) else {
                        continue;
                    };
                    *cell = source.clone();
                    if y >= start.y
                        && y <= end.y
                        && (y != start.y || x >= start.x)
                        && (y != end.y || x < end_right)
                    {
                        cell.fg = Color::Black;
                        cell.bg = Color::Cyan;
                        cell.modifier.remove(Modifier::DIM | Modifier::REVERSED);
                    }
                }
            }
        } else {
            self.screen = Some(buffer.clone());
        }
    }

    pub fn begin(&mut self, column: u16, row: u16) -> bool {
        self.clear();
        let point = Position::new(column, row);
        let Some(area) = self
            .regions
            .iter()
            .find(|area| area.contains(point))
            .copied()
        else {
            return false;
        };
        let Some(snapshot) = self.screen.clone() else {
            return false;
        };
        let anchor = glyph_start(&snapshot, area, point);
        self.drag = Some(Drag {
            area,
            snapshot,
            anchor,
            head: anchor,
            moved: false,
        });
        true
    }

    pub fn is_selecting(&self) -> bool {
        self.drag.is_some()
    }

    pub fn extend(&mut self, column: u16, row: u16) {
        if let Some(drag) = self.drag.as_mut() {
            let point = Position::new(
                column.clamp(drag.area.x, drag.area.right() - 1),
                row.clamp(drag.area.y, drag.area.bottom() - 1),
            );
            drag.head = glyph_start(&drag.snapshot, drag.area, point);
            drag.moved |= drag.head != drag.anchor;
        }
    }

    pub fn finish(&mut self, column: u16, row: u16) -> Option<String> {
        self.extend(column, row);
        let drag = self.drag.take()?;
        if !drag.moved {
            return None;
        }
        let (start, end) = drag.bounds();
        let mut lines = Vec::new();
        for y in start.y..=end.y {
            let mut x = if y == start.y { start.x } else { drag.area.x };
            let right = if y == end.y {
                end.x + 1
            } else {
                drag.area.right()
            };
            let mut line = String::new();
            while x < right {
                let symbol = drag.snapshot.cell((x, y))?.symbol();
                line.push_str(symbol);
                // Wide glyph continuation cells are padding, not extra spaces.
                x = x.saturating_add(symbol.width().max(1) as u16);
            }
            lines.push(line.trim_end_matches(' ').to_string());
        }
        let text = lines.join("\n");
        (!text.trim().is_empty()).then_some(text)
    }

    pub fn clear(&mut self) {
        self.drag = None;
    }

    pub fn reset(&mut self) {
        self.clear();
        self.screen = None;
        self.regions.clear();
    }
}

impl Drag {
    fn bounds(&self) -> (Position, Position) {
        if (self.anchor.y, self.anchor.x) <= (self.head.y, self.head.x) {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }
}

fn glyph_start(buffer: &Buffer, area: Rect, point: Position) -> Position {
    let mut x = area.x;
    while x < point.x {
        let width = buffer
            .cell((x, point.y))
            .map(|cell| cell.symbol().width())
            .unwrap_or(1)
            .max(1) as u16;
        if x.saturating_add(width) > point.x {
            return Position::new(x, point.y);
        }
        x = x.saturating_add(width);
    }
    point
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::style::Style;

    fn fixture() -> (TextSelection, Buffer) {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 24, 6));
        buffer.set_string(0, 0, "┌ MAIN ┐    ┌ CHILD ┐", Style::default());
        buffer.set_string(2, 1, "abcdef", Style::default());
        buffer.set_string(2, 2, "  ghij", Style::default());
        buffer.set_string(14, 1, "你好🙂xyz", Style::default());
        buffer.set_string(14, 2, "child two", Style::default());
        let mut selection = TextSelection::default();
        selection.register(Rect::new(2, 1, 8, 3));
        selection.register(Rect::new(14, 1, 9, 3));
        selection.finish_frame(&mut buffer);
        (selection, buffer)
    }

    #[test]
    fn selects_forward_and_reverse_with_code_indentation_without_other_panes() {
        for (start, end) in [((3, 1), (7, 2)), ((7, 2), (3, 1))] {
            let (mut selection, _) = fixture();
            selection.begin(start.0, start.1);
            selection.extend(end.0, end.1);
            assert_eq!(
                selection.finish(end.0, end.1).as_deref(),
                Some("bcdef\n  ghij")
            );
        }
    }

    #[test]
    fn preserves_cjk_and_emoji_when_drag_starts_on_a_continuation_cell() {
        let (mut selection, _) = fixture();
        selection.begin(15, 1);
        selection.extend(21, 1);
        assert_eq!(selection.finish(21, 1).as_deref(), Some("你好🙂xy"));
    }

    #[test]
    fn clicks_borders_and_empty_selections_do_not_copy() {
        let (mut selection, _) = fixture();
        selection.begin(2, 1);
        assert_eq!(selection.finish(2, 1), None);
        selection.begin(0, 0);
        assert_eq!(selection.finish(8, 2), None);
        selection.begin(8, 3);
        assert_eq!(selection.finish(9, 3), None);
    }

    #[test]
    fn dragging_across_a_divider_stays_inside_the_original_pane() {
        let (mut selection, _) = fixture();
        selection.begin(2, 1);
        assert_eq!(selection.finish(22, 1).as_deref(), Some("abcdef"));
    }

    #[test]
    fn stream_updates_cannot_change_selected_text_and_highlight_excludes_borders() {
        let (mut selection, mut buffer) = fixture();
        selection.begin(2, 1);
        selection.extend(5, 1);
        buffer.set_string(2, 1, "new data", Style::default());
        buffer.set_string(14, 1, "live", Style::default());
        selection.finish_frame(&mut buffer);
        assert_eq!(buffer.cell((2, 1)).unwrap().symbol(), "a");
        assert_eq!(buffer.cell((2, 1)).unwrap().bg, Color::Cyan);
        assert_eq!(buffer.cell((0, 0)).unwrap().bg, Color::Reset);
        assert_eq!(buffer.cell((14, 1)).unwrap().symbol(), "l");
        assert_eq!(selection.finish(5, 1).as_deref(), Some("abcd"));
        selection.begin_frame();
        selection.register(Rect::new(2, 1, 6, 2));
        selection.finish_frame(&mut buffer);
        selection.begin(2, 1);
        selection.reset();
        assert_eq!(selection.finish(5, 1), None);
    }
}

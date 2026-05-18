"use strict";

/**
 * Multiline text input for the ink-based ucode TUI.
 *
 * Mirrors the behaviour of the blessed `_listener` in src/code/tui.js, but
 * built on ink's useInput. Cursor math is delegated to src/ui/format so the
 * legacy and ink editors stay in sync (and so the existing jest coverage of
 * those helpers protects this component too).
 *
 * Props:
 *   value (string)              text contents (controlled)
 *   onChange(nextValue)         called when value changes
 *   onSubmit(value)             Enter pressed without modifiers, no trailing `\`
 *   onCancel()                  Esc pressed; the parent decides what to do
 *                               (e.g. abort an in-flight task). The component
 *                               does NOT mutate `value` on cancel.
 *   onArrowUpAtTop(value)       cursor on the first visual row, Up pressed
 *   onArrowDownAtBottom(value)  cursor on the last visual row, Down pressed
 *   onArrowLeftAtEmpty(value)   Left pressed while value is empty
 *   onArrowRightAtEmpty(value)  Right pressed while value is empty
 *   width (number)              wrap width in display cells
 *   interactive (boolean)       gates useInput; pass false for non-TTY mounts
 *   interceptArrowsAndEnter (boolean)
 *                               when true, Up/Down/Left/Right/Return are
 *                               suppressed inside the editor so a parent
 *                               component (e.g. completion popup) can
 *                               handle them. Plain editing keys still work.
 *   placeholder (string)        rendered in gray when value is empty
 *
 * Newlines: Enter submits. Use Alt+Enter (delivered as meta+Return) or end the
 * line with `\` (the legacy continuation trick) to insert a literal newline.
 * We do NOT rely on Shift+Enter — many terminals don't distinguish it from
 * plain Enter, so it would silently submit.
 *
 * Bracketed paste arrives as a multi-byte `input` chunk in useInput; we route
 * it through insertText, so multi-line paste already works without extra code.
 */

const fmt = require("../format");

function createMultilineInput({ React, ink }) {
  const { useState, useCallback, useMemo } = React;
  const { Box, Text, useInput } = ink;
  const h = React.createElement;

  return function MultilineInput({
    value = "",
    onChange = () => {},
    onSubmit = () => {},
    onCancel = () => {},
    onArrowUpAtTop,
    onArrowDownAtBottom,
    onArrowLeftAtEmpty,
    onArrowRightAtEmpty,
    width = 80,
    interactive = true,
    interceptArrowsAndEnter = false,
    placeholder = "",
    promptPrefix = "› ",
    promptColor = "magenta",
    borderColor = "gray",
  }) {
    // Cursor is owned by this component. preferredCol tracks the visual
    // column we want to keep when bouncing across lines of different widths
    // via Up/Down.
    const [cursorState, setCursorState] = useState(() => String(value || "").length);
    const [preferredCol, setPreferredCol] = useState(null);
    const cursorPos = fmt.clampCursorPos(cursorState, value);

    const wrapWidth = Math.max(1, Math.floor(Number(width) || 80));

    const setCursor = useCallback((next) => {
      setCursorState(fmt.clampCursorPos(next, value));
    }, [value]);
    const resetPreferredCol = useCallback(() => setPreferredCol(null), []);

    const change = useCallback((nextValue, nextCursor) => {
      const clamped = fmt.clampCursorPos(nextCursor, nextValue);
      setCursorState(clamped);
      onChange(nextValue);
    }, [onChange]);

    const insertText = useCallback((text) => {
      const before = value.slice(0, cursorPos);
      const after = value.slice(cursorPos);
      change(`${before}${text}${after}`, cursorPos + text.length);
      setPreferredCol(null);
    }, [value, cursorPos, change]);

    const replaceRange = useCallback((start, end, text) => {
      const safeStart = Math.max(0, Math.min(value.length, start));
      const safeEnd = Math.max(safeStart, Math.min(value.length, end));
      const next = `${value.slice(0, safeStart)}${text}${value.slice(safeEnd)}`;
      change(next, safeStart + text.length);
      setPreferredCol(null);
    }, [value, change]);

    const deleteBefore = useCallback(() => {
      if (cursorPos <= 0) return;
      replaceRange(cursorPos - 1, cursorPos, "");
    }, [cursorPos, replaceRange]);

    const deleteAt = useCallback(() => {
      if (cursorPos >= value.length) return;
      replaceRange(cursorPos, cursorPos + 1, "");
    }, [cursorPos, value.length, replaceRange]);

    const deleteToBoundary = useCallback((boundary) => {
      const target = fmt.moveCursorToVisualLineBoundary({
        cursorPos,
        inputValue: value,
        width: wrapWidth,
        boundary,
      });
      const start = Math.min(cursorPos, target);
      const end = Math.max(cursorPos, target);
      if (start === end) return;
      replaceRange(start, end, "");
    }, [cursorPos, value, wrapWidth, replaceRange]);

    const deleteWordBefore = useCallback(() => {
      const next = fmt.deleteWordBeforeCursor(value, cursorPos);
      change(next.value, next.cursorPos);
      setPreferredCol(null);
    }, [value, cursorPos, change]);

    const deleteWordAfter = useCallback(() => {
      const end = fmt.moveCursorByWord(value, cursorPos, "forward");
      replaceRange(cursorPos, end, "");
    }, [value, cursorPos, replaceRange]);

    useInput((input, key) => {
      // Let the parent absorb arrow keys + Enter when a popup (e.g. the
      // completion list) is open. We still process plain text input so
      // typing continues to filter the popup live.
      if (interceptArrowsAndEnter && (
        key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.return
      )) {
        return;
      }
      // Submit: Enter without modifiers, except after a trailing backslash
      // (which is the legacy "\\\n" continuation trick). Alt+Enter inserts
      // a literal newline. Shift+Enter is intentionally NOT used: many
      // terminals don't distinguish it from plain Enter.
      if (key.return) {
        if (key.meta) {
          insertText("\n");
          return;
        }
        if (cursorPos > 0 && value[cursorPos - 1] === "\\") {
          replaceRange(cursorPos - 1, cursorPos, "\n");
          return;
        }
        onSubmit(value);
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.ctrl) {
        if (input === "a") {
          setCursor(fmt.moveCursorToVisualLineBoundary({
            cursorPos, inputValue: value, width: wrapWidth, boundary: "start",
          }));
          resetPreferredCol();
          return;
        }
        if (input === "e") {
          setCursor(fmt.moveCursorToVisualLineBoundary({
            cursorPos, inputValue: value, width: wrapWidth, boundary: "end",
          }));
          resetPreferredCol();
          return;
        }
        if (input === "b") {
          setCursor(fmt.moveCursorHorizontally(cursorPos, value, "left"));
          resetPreferredCol();
          return;
        }
        if (input === "f") {
          setCursor(fmt.moveCursorHorizontally(cursorPos, value, "right"));
          resetPreferredCol();
          return;
        }
        if (input === "d") { deleteAt(); return; }
        if (input === "h") { deleteBefore(); return; }
        if (input === "k") { deleteToBoundary("end"); return; }
        if (input === "u") { deleteToBoundary("start"); return; }
        if (input === "w") { deleteWordBefore(); return; }
        // Ctrl+C is parent's responsibility (typically exits the app).
        return;
      }
      if (key.meta) {
        if (input === "b") {
          setCursor(fmt.moveCursorByWord(value, cursorPos, "backward"));
          resetPreferredCol();
          return;
        }
        if (input === "f") {
          setCursor(fmt.moveCursorByWord(value, cursorPos, "forward"));
          resetPreferredCol();
          return;
        }
        if (input === "d") { deleteWordAfter(); return; }
      }
      if (key.backspace) {
        if (key.meta || key.ctrl) deleteWordBefore();
        else deleteBefore();
        return;
      }
      if (key.delete) {
        // ink reports key.delete for the 0x7F byte that most terminals send
        // when the user presses the top-left Delete key (a.k.a. Backspace on
        // non-Mac keyboards). Treat it as "delete the character before the
        // cursor" by default. Real forward-delete (Fn+Delete on macOS) sends
        // an escape sequence and ink also sets key.delete with no leading
        // input — we can't reliably tell them apart, so favour the much
        // more common backspace semantics. Meta+Delete still maps to
        // delete-to-line-end as before.
        if (key.meta) deleteToBoundary("end");
        else deleteBefore();
        return;
      }
      if (key.leftArrow) {
        if (!value && typeof onArrowLeftAtEmpty === "function") {
          onArrowLeftAtEmpty(value);
          return;
        }
        setCursor(fmt.moveCursorHorizontally(cursorPos, value, "left"));
        resetPreferredCol();
        return;
      }
      if (key.rightArrow) {
        if (!value && typeof onArrowRightAtEmpty === "function") {
          onArrowRightAtEmpty(value);
          return;
        }
        setCursor(fmt.moveCursorHorizontally(cursorPos, value, "right"));
        resetPreferredCol();
        return;
      }
      if (key.upArrow) {
        if (value) {
          const move = fmt.moveCursorVertically({
            cursorPos, inputValue: value, width: wrapWidth,
            direction: "up", preferredCol,
          });
          setPreferredCol(move.preferredCol);
          if (move.moved) {
            setCursor(move.nextCursorPos);
            return;
          }
        }
        if (typeof onArrowUpAtTop === "function") onArrowUpAtTop(value);
        return;
      }
      if (key.downArrow) {
        if (value) {
          const move = fmt.moveCursorVertically({
            cursorPos, inputValue: value, width: wrapWidth,
            direction: "down", preferredCol,
          });
          setPreferredCol(move.preferredCol);
          if (move.moved) {
            setCursor(move.nextCursorPos);
            return;
          }
        }
        if (typeof onArrowDownAtBottom === "function") onArrowDownAtBottom(value);
        return;
      }

      // Plain character / paste. Filter control bytes.
      if (input && !key.ctrl && !key.meta) {
        const filtered = input.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
        if (filtered) insertText(filtered);
      }
    }, { isActive: interactive });

    // Render: split into logical lines, then split each into visual rows by
    // wrap width. Highlight one cell at the cursor location. With a
    // placeholder, we still draw the cursor (visible at offset 0) and append
    // the placeholder text in gray after it.
    const showPlaceholder = !value && !!placeholder;
    const visualRows = useMemo(
      () => layoutRows(value, wrapWidth, cursorPos),
      [value, wrapWidth, cursorPos]
    );

    return h(Box, {
      borderStyle: "single",
      borderTop: true,
      borderBottom: true,
      borderLeft: false,
      borderRight: false,
      borderColor,
      flexDirection: "column",
      width: "100%",
    },
      ...visualRows.map((row, idx) =>
        h(Box, { key: `row-${idx}` },
          idx === 0 ? h(Text, { color: promptColor }, promptPrefix) : h(Text, null, "  "),
          ...row.segments.map((seg, segIdx) =>
            h(Text, {
              key: `s-${segIdx}`,
              inverse: seg.cursor,
              color: showPlaceholder && idx === 0 && segIdx === 0 ? "gray" : undefined,
            }, seg.text)
          ),
          showPlaceholder && idx === 0
            ? h(Text, { color: "gray" }, placeholder)
            : null,
        )
      ),
    );
  };
}

/**
 * Lay out `value` into visual rows respecting `width`, and mark the cell at
 * `cursor` so the renderer can invert it. Returns:
 *   [{ segments: [{ text, cursor }] }, ...]
 *
 * Cursor at end-of-input is rendered as an inverted space appended to the
 * final row. Newlines split rows but never appear in segments. Pass
 * `cursor < 0` to suppress the cursor entirely (used in placeholder mode).
 */
function layoutRows(value, width, cursor) {
  const text = String(value == null ? "" : value);
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const rawCursor = Number(cursor);
  const showCursor = Number.isFinite(rawCursor) && rawCursor >= 0;
  const cursorIdx = showCursor
    ? Math.min(text.length, Math.floor(rawCursor))
    : -1;

  const rows = [];
  let row = { segments: [], cellsUsed: 0, cursorPlaced: false };
  const pushRow = () => {
    rows.push(row);
    row = { segments: [], cellsUsed: 0, cursorPlaced: false };
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      if (cursorIdx === i && !row.cursorPlaced) {
        row.segments.push({ text: " ", cursor: true });
        row.cursorPlaced = true;
      }
      pushRow();
      continue;
    }
    const w = fmt.displayCellWidth(ch);
    if (row.cellsUsed + w > safeWidth) pushRow();
    if (cursorIdx === i) {
      row.segments.push({ text: ch, cursor: true });
      row.cursorPlaced = true;
    } else {
      row.segments.push({ text: ch, cursor: false });
    }
    row.cellsUsed += w;
  }
  if (cursorIdx === text.length && !row.cursorPlaced) {
    row.segments.push({ text: " ", cursor: true });
  }
  rows.push(row);
  return rows;
}

module.exports = {
  createMultilineInput,
  layoutRows,
};

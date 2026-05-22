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

// IME cursor parking interacts with ink's frame rendering. Two facts about
// ink make the naive "move cursor up in useEffect" approach insufficient:
//
//   1. ink throttles onRender to 32ms (ink.js:39), so frame writes happen
//      AFTER our useEffect, not before — anything we wrote in useEffect ends
//      up getting overwritten by ink's parking cursor at the bottom of the
//      next frame, which is what the user sees as "光标被结尾抢走".
//
//   2. ink's log-update emits ansi-escapes.eraseLines(N) before each frame:
//      a sequence of `eraseLine + cursorUp` pairs starting from "wherever
//      the cursor currently is". If our IME hack left the cursor mid-frame,
//      ink's relative cursorUp walks past the top of the frame and tramples
//      lines above it.
//
// Fix: wrap stdout.write once. Before any frame-shaped write (starts with
// ESC[2K from eraseLines, or ESC[2J from full-screen rerender), push the
// cursor back DOWN to the parking row so ink's math is restored. AFTER the
// frame write, if the IME park target is active, re-emit the cursor-up +
// CHA so the hardware cursor follows the inverse caret again. This way the
// caret stays parked at the IME-visible row even when ink's throttled write
// fires long after React commit.
const __imeStdoutState = new WeakSet();
const __imeCursor = {
  active: false,
  // Where to park the cursor: rowsUp above ink's "row after last frame line"
  // anchor, and 0-based terminal column.
  parkRowsUp: 0,
  parkCol: 0,
  // How many rows up we last actually moved the cursor — used to undo the
  // move before ink runs its relative eraseLines. ALWAYS matches the move
  // we last wrote, regardless of whether that was through the patched
  // stdout write or the useEffect path.
  movedUpRows: 0,
  // Tracks whether the LAST frame ink wrote ended with '\n' (the log-update
  // path) or not (the full-screen path). The anchor row is one row higher
  // when there's no trailing newline, which shifts subsequent restore-down
  // math by one. Without this flag, useEffect after a full-screen frame
  // restores down too far and overshoots upward → a "ghost caret" sits one
  // or more rows above the real caret.
  lastFrameHadNewline: true,
};

function isFrameWrite(chunk) {
  if (typeof chunk !== "string" && !(chunk instanceof String)) return false;
  const str = String(chunk);
  // eraseLines(N>0) starts with ESC[2K; full-screen clear starts with ESC[2J.
  return str.startsWith("\x1b[2K") || str.startsWith("\x1b[2J");
}

// Compute "rows up from the current anchor to the caret". The anchor sits
// one row below the last frame line when the frame ended with '\n', and AT
// the last frame line otherwise — so a frame with no trailing newline needs
// one fewer row up to land on the caret.
function rowsUpFromAnchor() {
  const base = __imeCursor.parkRowsUp;
  return __imeCursor.lastFrameHadNewline ? base : Math.max(0, base - 1);
}

function applyParkSequence(parkRowsUp) {
  if (!__imeCursor.active) return "";
  const up = parkRowsUp > 0 ? `\x1b[${parkRowsUp}A` : "";
  const col = `\x1b[${__imeCursor.parkCol + 1}G`; // CHA is 1-based
  __imeCursor.movedUpRows = parkRowsUp;
  return `\x1b[?25h${up}${col}`;
}

function patchStdoutForIME(out) {
  if (!out || typeof out.write !== "function" || __imeStdoutState.has(out)) {
    return;
  }
  __imeStdoutState.add(out);
  const originalWrite = out.write.bind(out);
  out.write = function patchedWrite(chunk, encoding, callback) {
    if (!isFrameWrite(chunk) || (typeof chunk !== "string" && !(chunk instanceof String))) {
      return originalWrite(chunk, encoding, callback);
    }
    // Combine "hide cursor + restore-to-anchor + ink's frame + reposition +
    // show cursor" into a SINGLE write so the terminal processes the whole
    // transition atomically. With ink's eraseLines walking the cursor up
    // through the frame mid-write, even one stray byte between escape
    // sequences can leave the hardware cursor visible on an intermediate
    // row for a frame — exactly the "faint cursor above the real one"
    // ghost the user reports.
    const str = String(chunk);
    let prefix = "\x1b[?25l"; // hide cursor for the whole transition
    if (__imeCursor.movedUpRows > 0) {
      // Push the cursor back down to ink's "after last frame line" anchor
      // so the relative cursorUp inside eraseLines walks the right rows.
      prefix += `\x1b[${__imeCursor.movedUpRows}B`;
      __imeCursor.movedUpRows = 0;
    }
    // Record which ink path this frame took so subsequent restores-down know
    // where the anchor actually sits.
    __imeCursor.lastFrameHadNewline = str.endsWith("\n");
    const suffix = applyParkSequence(rowsUpFromAnchor()) || "\x1b[?25l";
    return originalWrite(prefix + str + suffix, encoding, callback);
  };
}

function createMultilineInput({ React, ink }) {
  const { useState, useCallback, useMemo, useEffect } = React;
  const { Box, Text, useInput, useStdout } = ink;
  const h = React.createElement;

  return function MultilineInput({
    value = "",
    valueVersion = 0,
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
    // How many terminal rows of UI sit *below* the bottom of this input box
    // (status line, dashboard rows, etc.). The component uses this to compute
    // how far up the hardware cursor needs to be moved after each render so
    // the IME composition window pops up at the visible (inverse) cursor
    // instead of at the bottom of the screen.
    linesBelowInput = 0,
  }) {
    // Cursor is owned by this component. preferredCol tracks the visual
    // column we want to keep when bouncing across lines of different widths
    // via Up/Down.
    const [cursorState, setCursorState] = useState(() => String(value || "").length);
    const [preferredCol, setPreferredCol] = useState(null);
    const cursorPos = fmt.clampCursorPos(cursorState, value);

    // When the parent forces a new value via valueVersion (e.g. accepting
    // a completion), park the cursor at the end of the freshly inserted
    // text so the user can keep typing without arrow-keying back to the
    // tail.
    useEffect(() => {
      setCursorState(String(value || "").length);
      setPreferredCol(null);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [valueVersion]);

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

    // Hardware-cursor parking for IME support. ink hides the terminal cursor
    // by default and parks it after the last frame line; macOS/Linux IMEs
    // (Pinyin, kkc, etc.) anchor the candidate window to the *hardware*
    // cursor, so without this hack Chinese input pops up at the bottom-right
    // instead of next to the inverse-block caret. We compute the row offset
    // of the inverse caret from the bottom of ink's rendered frame and emit
    // ANSI cursor-position escapes after every render.
    //
    //   ink frame layout (top→bottom)
    //     ... chat log ...
    //     ┌── input border top ──┐         <- visualRows[0]
    //     │ › row 0              │
    //     │   row 1              │
    //     └── input border bot ──┘
    //     status line                       <- linesBelowInput rows
    //     dashboard row(s)
    //     <ink parks cursor here>
    const { stdout } = useStdout() || {};
    // Find the visual (row, col) of the cursor inside the wrapped layout.
    let cursorVisualRow = 0;
    let cursorVisualCol = 0;
    {
      let placed = false;
      for (let r = 0; r < visualRows.length && !placed; r += 1) {
        const row = visualRows[r];
        let col = 0;
        for (const seg of row.segments) {
          if (seg.cursor) {
            cursorVisualRow = r;
            cursorVisualCol = col;
            placed = true;
            break;
          }
          col += fmt.displayCellWidth(seg.text);
        }
      }
      if (!placed) {
        // Cursor at end-of-input on a fresh row.
        cursorVisualRow = Math.max(0, visualRows.length - 1);
        cursorVisualCol = 0;
        const lastRow = visualRows[cursorVisualRow];
        if (lastRow) {
          for (const seg of lastRow.segments) {
            if (seg.cursor) break;
            cursorVisualCol += fmt.displayCellWidth(seg.text);
          }
        }
      }
    }
    const promptCols = cursorVisualRow === 0
      ? fmt.displayCellWidth(promptPrefix)
      : 2; // "  " indent on continuation rows
    const cursorTermCol = promptCols + cursorVisualCol; // 0-based column

    // Distance from the cursor's row to the parking row that ink will leave
    // behind: bottom border (1) + linesBelowInput + the trailing newline ink
    // appends to its frame string (1, see ink/log-update.js).
    const rowsBelowCursor = (visualRows.length - 1 - cursorVisualRow)
      + 1 // bottom border row of the input box
      + Math.max(0, Math.floor(Number(linesBelowInput) || 0))
      + 1; // ink appends "\n" after the frame, so the cursor sits one extra
           // line below the last printed row

    useEffect(() => {
      const out = stdout || process.stdout;
      if (!out || typeof out.write !== "function" || !out.isTTY) {
        __imeCursor.active = false;
        return undefined;
      }
      if (!interactive) {
        // Hand the cursor back to ink and stop chasing the caret.
        if (__imeCursor.movedUpRows > 0) {
          out.write(`\x1b[${__imeCursor.movedUpRows}B`);
          __imeCursor.movedUpRows = 0;
        }
        __imeCursor.active = false;
        return undefined;
      }
      patchStdoutForIME(out);
      // Publish the desired park target so the stdout monkey-patch can
      // re-park after every throttled ink frame write.
      __imeCursor.active = true;
      __imeCursor.parkRowsUp = rowsBelowCursor;
      __imeCursor.parkCol = cursorTermCol;
      // Park immediately — covers cases where ink has nothing to render
      // (output unchanged) and won't fire a frame write at all, and keeps
      // the caret visible between frames. Combine hide + restore + park +
      // show into a single write so the terminal never sees the cursor at
      // an intermediate row.
      //
      // CRITICAL: the move-up amount must match the anchor that movedUpRows
      // was measured against. If the last frame ended without '\n' (the
      // full-screen path), the anchor is one row higher than the log-update
      // case, so we use rowsUpFromAnchor() rather than parkRowsUp directly.
      // Otherwise restoring down by movedUpRows then moving up parkRowsUp
      // overshoots by one and leaves the hardware cursor one row above the
      // inverse caret — the residual "ghost cursor" symptom.
      let combined = "\x1b[?25l";
      if (__imeCursor.movedUpRows > 0) {
        combined += `\x1b[${__imeCursor.movedUpRows}B`;
        __imeCursor.movedUpRows = 0;
      }
      combined += applyParkSequence(rowsUpFromAnchor());
      out.write(combined);
      return undefined;
    });

    // On unmount, return the cursor to ink's expected parking row (so the
    // next frame ink renders after us doesn't trample lines above its frame)
    // and re-hide it so the rest of ink's lifetime behaves as before.
    useEffect(() => () => {
      const out = stdout || process.stdout;
      __imeCursor.active = false;
      if (out && typeof out.write === "function" && out.isTTY) {
        const restore = __imeCursor.movedUpRows > 0
          ? `\x1b[${__imeCursor.movedUpRows}B`
          : "";
        __imeCursor.movedUpRows = 0;
        out.write(`${restore}\x1b[?25l`);
      }
    }, [stdout]);

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

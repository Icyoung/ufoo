"use strict";

/**
 * Convert a virtual-terminal screen into ANSI-styled text lines suitable for
 * shipping over `multi.pane.frame`. Rust decodes these with `ansi-to-tui`.
 *
 * The colour/attribute-to-ANSI logic mirrors renderer.js so the rendered
 * frame matches the Ink multi-window presentation.
 */

const MAX_LINE_BYTES = 4096;

function attrToAnsi(attr) {
  const parts = [];
  if (attr.bold) parts.push("1");
  if (attr.dim) parts.push("2");
  if (attr.italic) parts.push("3");
  if (attr.underline) parts.push("4");
  if (attr.inverse) parts.push("7");
  if (attr.fgRgb) {
    parts.push(`38;2;${attr.fgRgb[0]};${attr.fgRgb[1]};${attr.fgRgb[2]}`);
  } else if (attr.fg !== 7) {
    if (attr.fg < 8) parts.push(String(30 + attr.fg));
    else if (attr.fg < 16) parts.push(String(90 + attr.fg - 8));
    else parts.push(`38;5;${attr.fg}`);
  }
  if (attr.bgRgb) {
    parts.push(`48;2;${attr.bgRgb[0]};${attr.bgRgb[1]};${attr.bgRgb[2]}`);
  } else if (attr.bg > 0) {
    if (attr.bg < 8) parts.push(String(40 + attr.bg));
    else if (attr.bg < 16) parts.push(String(100 + attr.bg - 8));
    else parts.push(`48;5;${attr.bg}`);
  }
  return parts.length > 0 ? `\x1b[${parts.join(";")}m` : "";
}

function truncateLineBytes(line, maxBytes) {
  if (!line) return "";
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return line;
  const buf = Buffer.from(line, "utf8");
  return buf.slice(0, maxBytes).toString("utf8");
}

function vtScreenToAnsiLines(vt, options = {}) {
  if (!vt || typeof vt.getScreen !== "function") return [];
  const { buffer, rows, cols, cursorRow, cursorCol } = vt.getScreen();
  const maxRows = Number.isFinite(options.maxRows) && options.maxRows > 0
    ? Math.floor(options.maxRows)
    : rows;
  const maxCols = Number.isFinite(options.maxCols) && options.maxCols > 0
    ? Math.floor(options.maxCols)
    : cols;
  const cursorInverse = Boolean(options.cursorInverse);
  const reset = "\x1b[0m";
  const limit = Math.min(rows, maxRows);
  const out = [];
  for (let r = 0; r < limit; r++) {
    const row = buffer[r] || [];
    let line = "";
    let lastAttr = "";
    let col = 0;
    let c = 0;
    while (col < maxCols && c < cols) {
      const cell = row[c];
      if (!cell) {
        line += " ";
        col += 1;
        c += 1;
        continue;
      }
      if (cell.wideContinuation) {
        c += 1;
        continue;
      }
      const isCursor = cursorInverse && r === cursorRow && c === cursorCol;
      const attr = isCursor ? { ...cell.attr, inverse: !cell.attr.inverse } : cell.attr;
      const ansi = attrToAnsi(attr);
      if (ansi !== lastAttr) {
        if (lastAttr) line += reset;
        line += ansi;
        lastAttr = ansi;
      }
      line += cell.char || " ";
      col += 1;
      c += 1;
    }
    if (lastAttr) line += reset;
    out.push(truncateLineBytes(line, MAX_LINE_BYTES));
  }
  return out;
}

module.exports = { vtScreenToAnsiLines, MAX_LINE_BYTES };

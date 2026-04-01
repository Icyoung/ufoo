const TAB_WIDTH = 4;
const TAB_REPLACEMENT = " ".repeat(TAB_WIDTH);

function expandTabs(value) {
  return String(value || "").replace(/\t/g, TAB_REPLACEMENT);
}

/**
 * Convert a cursor offset in the original text to an offset in the
 * tab-expanded text.
 */
function originalToExpanded(text, pos) {
  let origIdx = 0;
  let expIdx = 0;
  const str = String(text || "");
  while (origIdx < pos && origIdx < str.length) {
    if (str[origIdx] === "\t") {
      expIdx += TAB_WIDTH;
    } else {
      expIdx += str[origIdx].length > 1 ? str[origIdx].length : 1;
    }
    origIdx += 1;
  }
  return expIdx;
}

/**
 * Convert a cursor offset in the tab-expanded text back to an offset
 * in the original text.
 */
function expandedToOriginal(text, expPos) {
  let origIdx = 0;
  let expIdx = 0;
  const str = String(text || "");
  while (expIdx < expPos && origIdx < str.length) {
    if (str[origIdx] === "\t") {
      expIdx += TAB_WIDTH;
    } else {
      expIdx += 1;
    }
    origIdx += 1;
  }
  return origIdx;
}

function safeStrWidth(strWidth, value) {
  if (typeof strWidth === "function") return strWidth(value);
  // Fallback: expand tabs to 4 spaces for width calculation
  const expanded = expandTabs(value);
  return Array.from(expanded).length;
}

function getInnerWidth({ input, screen, promptWidth = 2 }) {
  const lpos = input.lpos || input._getCoords();
  if (lpos && Number.isFinite(lpos.xl) && Number.isFinite(lpos.xi)) {
    return Math.max(1, lpos.xl - lpos.xi);
  }
  if (typeof input.width === "number") return Math.max(1, input.width);
  if (typeof input.width === "string") {
    const match = input.width.match(/^100%-([0-9]+)$/);
    if (match && typeof screen.width === "number") {
      return Math.max(1, screen.width - parseInt(match[1], 10));
    }
  }
  if (typeof screen.width === "number") return Math.max(1, screen.width - promptWidth);
  if (typeof screen.cols === "number") return Math.max(1, screen.cols - promptWidth);
  return 1;
}

function getWrapWidth(input, fallbackWidth) {
  if (input._clines && typeof input._clines.width === "number") {
    return Math.max(1, input._clines.width);
  }
  return Math.max(1, fallbackWidth || 1);
}

/**
 * Simulate blessed's wrapping for a single logical line (no newlines).
 * Returns { rows, lastCol }.
 *
 * Blessed preprocesses double-width chars by inserting a \x03 marker after
 * each one, then wraps at character count = width. This means a double-width
 * char at col (width - 1) overflows by 1 cell — only the \x03 marker wraps
 * to the next line. We replicate this behavior so cursor math matches what
 * blessed actually renders.
 */
function wrapLine(line, width, strWidth) {
  const chars = Array.from(String(line || ""));
  let col = 0;
  let rows = 1;
  for (const ch of chars) {
    const w = safeStrWidth(strWidth, ch);
    if (w === 0) continue;
    if (col >= width) {
      rows += 1;
      col = col - width;
    }
    col += w;
  }
  if (col > width) {
    rows += 1;
    col = col - width;
  } else if (col === width) {
    rows += 1;
    col = 0;
  }
  return { rows, lastCol: col };
}

function countLines(text, width, strWidth) {
  if (width <= 0) return 1;
  // Expand tabs to match blessed's preprocessing
  const expanded = expandTabs(text);
  const lines = expanded.split("\n");
  let total = 0;
  for (const line of lines) {
    const { rows, lastCol } = wrapLine(line, width, strWidth);
    total += (lastCol === 0 && rows > 1) ? rows - 1 : rows;
  }
  return total;
}

/**
 * Convert a cursor offset (pos) in the original text to a visual { row, col }.
 * Expands tabs first to match blessed's wrapping, then simulates wrapping.
 */
function getCursorRowCol(text, pos, width, strWidth) {
  if (width <= 0) return { row: 0, col: 0 };
  const original = String(text || "");
  const expanded = expandTabs(original);
  const expPos = originalToExpanded(original, Math.max(0, pos));
  const before = expanded.slice(0, Math.max(0, expPos));
  const lines = before.split("\n");
  let row = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    if (i < lines.length - 1) {
      const { rows, lastCol } = wrapLine(line, width, strWidth);
      row += (lastCol === 0 && rows > 1) ? rows - 1 : rows;
    } else {
      const chars = Array.from(line);
      let col = 0;
      for (const ch of chars) {
        const w = safeStrWidth(strWidth, ch);
        if (w === 0) continue;
        if (col >= width) {
          row += 1;
          col = col - width;
        }
        col += w;
      }
      if (col > width) {
        row += 1;
        col = col - width;
      } else if (col === width) {
        row += 1;
        col = 0;
      }
      return { row, col };
    }
  }
  return { row, col: 0 };
}

/**
 * Convert a visual { targetRow, targetCol } back to a cursor offset in
 * the original text. Expands tabs first to match blessed's wrapping.
 */
function getCursorPosForRowCol(text, targetRow, targetCol, width, strWidth) {
  if (width <= 0) return 0;
  const original = String(text || "");
  const expanded = expandTabs(original);
  const lines = expanded.split("\n");
  let row = 0;
  let expPos = 0;

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const chars = Array.from(line);
    let col = 0;
    let lineOffset = 0;

    for (const ch of chars) {
      const w = safeStrWidth(strWidth, ch);
      if (w === 0) {
        lineOffset += ch.length;
        continue;
      }
      if (col >= width) {
        row += 1;
        col = col - width;
      }
      if (row === targetRow && col + w > targetCol) {
        return expandedToOriginal(original, expPos + lineOffset);
      }
      col += w;
      lineOffset += ch.length;
      if (col > width) {
        if (row === targetRow) {
          return expandedToOriginal(original, expPos + lineOffset);
        }
        row += 1;
        col = col - width;
      } else if (col === width) {
        if (row === targetRow) {
          return expandedToOriginal(original, expPos + lineOffset);
        }
        row += 1;
        col = 0;
      }
    }

    if (row === targetRow) {
      return expandedToOriginal(original, expPos + lineOffset);
    }
    if (row > targetRow) {
      return expandedToOriginal(original, expPos + lineOffset);
    }

    expPos += line.length + 1;
    row += 1;
  }
  return original.length;
}

function normalizePaste(text) {
  if (!text) return "";
  let normalized = String(text).replace(/\x1b\[200~|\x1b\[201~/g, "");
  normalized = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized;
}

module.exports = {
  getInnerWidth,
  getWrapWidth,
  countLines,
  getCursorRowCol,
  getCursorPosForRowCol,
  normalizePaste,
};

function safeStrWidth(strWidth, value) {
  if (typeof strWidth === "function") return strWidth(value);
  return Array.from(String(value || "")).length;
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

function countLines(text, width, strWidth) {
  if (width <= 0) return 1;
  const lines = String(text || "").split("\n");
  let total = 0;
  for (const line of lines) {
    const lineWidth = safeStrWidth(strWidth, line);
    total += Math.max(1, Math.ceil(lineWidth / width));
  }
  return total;
}

function getCursorRowCol(text, pos, width, strWidth) {
  if (width <= 0) return { row: 0, col: 0 };
  const before = String(text || "").slice(0, Math.max(0, pos));
  const lines = before.split("\n");
  let row = 0;
  for (let i = 0; i < lines.length - 1; i += 1) {
    const lineWidth = safeStrWidth(strWidth, lines[i]);
    row += Math.max(1, Math.ceil(lineWidth / width));
  }
  const lastLine = lines[lines.length - 1] || "";
  const lastWidth = safeStrWidth(strWidth, lastLine);
  row += Math.floor(lastWidth / width);
  const col = lastWidth % width;
  return { row, col };
}

function getLinePosForCol(line, targetCol, strWidth) {
  if (targetCol <= 0) return 0;
  let col = 0;
  let offset = 0;
  for (const ch of Array.from(String(line || ""))) {
    const w = safeStrWidth(strWidth, ch);
    if (col + w > targetCol) return offset;
    col += w;
    offset += ch.length;
  }
  return offset;
}

function getCursorPosForRowCol(text, targetRow, targetCol, width, strWidth) {
  if (width <= 0) return 0;
  const source = String(text || "");
  const lines = source.split("\n");
  let row = 0;
  let pos = 0;
  for (const line of lines) {
    const lineWidth = safeStrWidth(strWidth, line);
    const wrappedRows = Math.max(1, Math.ceil(lineWidth / width));
    if (targetRow < row + wrappedRows) {
      const rowInLine = targetRow - row;
      const visualCol = rowInLine * width + Math.max(0, targetCol);
      return pos + getLinePosForCol(line, visualCol, strWidth);
    }
    pos += line.length + 1;
    row += wrappedRows;
  }
  return source.length;
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

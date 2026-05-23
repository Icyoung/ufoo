const DEFAULT_ATTR = { fg: 7, bg: 0, bold: false, dim: false, italic: false, underline: false, inverse: false };

function createCell(char = " ", attr = DEFAULT_ATTR) {
  return { char, attr: { ...attr } };
}

function createVirtualTerminal(cols = 80, rows = 24) {
  let buffer = [];
  let cursorRow = 0;
  let cursorCol = 0;
  let savedCursor = { row: 0, col: 0 };
  let currentAttr = { ...DEFAULT_ATTR };
  let scrollTop = 0;
  let scrollBottom = rows - 1;
  let dirty = true;

  function initBuffer() {
    buffer = [];
    for (let r = 0; r < rows; r++) {
      buffer.push(createRow(cols));
    }
  }

  function createRow(width) {
    const row = [];
    for (let c = 0; c < width; c++) {
      row.push(createCell());
    }
    return row;
  }

  function clamp() {
    if (cursorRow < 0) cursorRow = 0;
    if (cursorRow >= rows) cursorRow = rows - 1;
    if (cursorCol < 0) cursorCol = 0;
    if (cursorCol >= cols) cursorCol = cols - 1;
  }

  function scrollUp(top = scrollTop, bottom = scrollBottom) {
    buffer.splice(top, 1);
    buffer.splice(bottom, 0, createRow(cols));
    dirty = true;
  }

  function scrollDown(top = scrollTop, bottom = scrollBottom) {
    buffer.splice(bottom, 1);
    buffer.splice(top, 0, createRow(cols));
    dirty = true;
  }
  function putChar(ch) {
    if (cursorCol >= cols) {
      cursorCol = 0;
      cursorRow++;
      if (cursorRow > scrollBottom) {
        cursorRow = scrollBottom;
        scrollUp();
      }
    }
    if (buffer[cursorRow]) {
      buffer[cursorRow][cursorCol] = createCell(ch, currentAttr);
    }
    cursorCol++;
    dirty = true;
  }

  function eraseLine(mode, row) {
    if (!buffer[row]) return;
    if (mode === 0) {
      for (let c = cursorCol; c < cols; c++) buffer[row][c] = createCell();
    } else if (mode === 1) {
      for (let c = 0; c <= cursorCol; c++) buffer[row][c] = createCell();
    } else {
      for (let c = 0; c < cols; c++) buffer[row][c] = createCell();
    }
    dirty = true;
  }

  function eraseDisplay(mode) {
    if (mode === 0) {
      eraseLine(0, cursorRow);
      for (let r = cursorRow + 1; r < rows; r++) buffer[r] = createRow(cols);
    } else if (mode === 1) {
      for (let r = 0; r < cursorRow; r++) buffer[r] = createRow(cols);
      eraseLine(1, cursorRow);
    } else {
      for (let r = 0; r < rows; r++) buffer[r] = createRow(cols);
      cursorRow = 0;
      cursorCol = 0;
    }
    dirty = true;
  }

  function applySGR(params) {
    for (let i = 0; i < params.length; i++) {
      const p = params[i];
      if (p === 0) { Object.assign(currentAttr, DEFAULT_ATTR); }
      else if (p === 1) { currentAttr.bold = true; }
      else if (p === 2) { currentAttr.dim = true; }
      else if (p === 3) { currentAttr.italic = true; }
      else if (p === 4) { currentAttr.underline = true; }
      else if (p === 7) { currentAttr.inverse = true; }
      else if (p === 22) { currentAttr.bold = false; currentAttr.dim = false; }
      else if (p === 23) { currentAttr.italic = false; }
      else if (p === 24) { currentAttr.underline = false; }
      else if (p === 27) { currentAttr.inverse = false; }
      else if (p >= 30 && p <= 37) { currentAttr.fg = p - 30; }
      else if (p === 38 && params[i + 1] === 5) { currentAttr.fg = params[i + 2] || 0; i += 2; }
      else if (p === 39) { currentAttr.fg = 7; }
      else if (p >= 40 && p <= 47) { currentAttr.bg = p - 40; }
      else if (p === 48 && params[i + 1] === 5) { currentAttr.bg = params[i + 2] || 0; i += 2; }
      else if (p === 49) { currentAttr.bg = 0; }
      else if (p >= 90 && p <= 97) { currentAttr.fg = p - 90 + 8; }
      else if (p >= 100 && p <= 107) { currentAttr.bg = p - 100 + 8; }
    }
    dirty = true;
  }

  function handleCSI(params, code) {
    const p = params.length > 0 ? params : [0];
    switch (code) {
      case "A": cursorRow -= (p[0] || 1); break;
      case "B": cursorRow += (p[0] || 1); break;
      case "C": cursorCol += (p[0] || 1); break;
      case "D": cursorCol -= (p[0] || 1); break;
      case "E": cursorRow += (p[0] || 1); cursorCol = 0; break;
      case "F": cursorRow -= (p[0] || 1); cursorCol = 0; break;
      case "G": cursorCol = (p[0] || 1) - 1; break;
      case "H": case "f":
        cursorRow = (p[0] || 1) - 1;
        cursorCol = (p.length > 1 ? (p[1] || 1) : 1) - 1;
        break;
      case "J": eraseDisplay(p[0] || 0); break;
      case "K": eraseLine(p[0] || 0, cursorRow); break;
      case "L": {
        const n = p[0] || 1;
        for (let i = 0; i < n; i++) scrollDown(cursorRow, scrollBottom);
        break;
      }
      case "M": {
        const n = p[0] || 1;
        for (let i = 0; i < n; i++) scrollUp(cursorRow, scrollBottom);
        break;
      }
      case "S": { const n = p[0] || 1; for (let i = 0; i < n; i++) scrollUp(); break; }
      case "T": { const n = p[0] || 1; for (let i = 0; i < n; i++) scrollDown(); break; }
      case "d": cursorRow = (p[0] || 1) - 1; break;
      case "m": applySGR(p); break;
      case "r":
        scrollTop = (p[0] || 1) - 1;
        scrollBottom = (p.length > 1 ? (p[1] || rows) : rows) - 1;
        cursorRow = 0; cursorCol = 0;
        break;
      case "s": savedCursor = { row: cursorRow, col: cursorCol }; break;
      case "u": cursorRow = savedCursor.row; cursorCol = savedCursor.col; break;
    }
    clamp();
    dirty = true;
  }
  function write(data) {
    const str = typeof data === "string" ? data : data.toString("utf8");
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (ch === "\x1b") {
        if (str[i + 1] === "[") {
          i += 2;
          let paramStr = "";
          while (i < str.length && str[i] >= "\x20" && str[i] <= "\x3f") {
            paramStr += str[i++];
          }
          const code = str[i++] || "";
          const params = paramStr ? paramStr.split(";").map(Number) : [];
          handleCSI(params, code);
        } else if (str[i + 1] === "7") {
          savedCursor = { row: cursorRow, col: cursorCol };
          i += 2;
        } else if (str[i + 1] === "8") {
          cursorRow = savedCursor.row;
          cursorCol = savedCursor.col;
          i += 2;
        } else if (str[i + 1] === "M") {
          scrollUp();
          i += 2;
        } else if (str[i + 1] === "D") {
          cursorRow++;
          if (cursorRow > scrollBottom) {
            cursorRow = scrollBottom;
            scrollUp();
          }
          i += 2;
        } else {
          i += 2;
        }
      } else if (ch === "\r") {
        cursorCol = 0;
        i++;
      } else if (ch === "\n") {
        cursorRow++;
        if (cursorRow > scrollBottom) {
          cursorRow = scrollBottom;
          scrollUp();
        }
        i++;
      } else if (ch === "\b") {
        if (cursorCol > 0) cursorCol--;
        i++;
      } else if (ch === "\t") {
        cursorCol = Math.min(cols - 1, (Math.floor(cursorCol / 8) + 1) * 8);
        i++;
      } else if (ch.charCodeAt(0) < 32) {
        i++;
      } else {
        putChar(ch);
        i++;
      }
    }
  }

  function getScreen() {
    return { buffer, rows, cols, cursorRow, cursorCol };
  }

  function getLine(row) {
    if (row < 0 || row >= rows) return "";
    return buffer[row].map((c) => c.char).join("");
  }

  function getCursor() {
    return { row: cursorRow, col: cursorCol };
  }

  function isDirty() {
    return dirty;
  }

  function clearDirty() {
    dirty = false;
  }

  function resize(newCols, newRows) {
    const oldBuffer = buffer;
    const oldRows = rows;
    cols = newCols;
    rows = newRows;
    scrollTop = 0;
    scrollBottom = rows - 1;
    initBuffer();
    const copyRows = Math.min(oldRows, rows);
    for (let r = 0; r < copyRows; r++) {
      const copyLen = Math.min(oldBuffer[r].length, cols);
      for (let c = 0; c < copyLen; c++) {
        buffer[r][c] = oldBuffer[r][c];
      }
    }
    clamp();
    dirty = true;
  }

  initBuffer();

  return {
    write,
    getScreen,
    getLine,
    getCursor,
    isDirty,
    clearDirty,
    resize,
  };
}

module.exports = { createVirtualTerminal, DEFAULT_ATTR };

const BOX = { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", t: "┬", b: "┴", l: "├", r: "┤", x: "┼" };

function createRenderer(options = {}) {
  const {
    write: rawWrite = process.stdout.write.bind(process.stdout),
  } = options;

  function write(data) {
    try { rawWrite(data); } catch {}
  }

  function moveTo(row, col) {
    return `\x1b[${row + 1};${col + 1}H`;
  }

  function attrToAnsi(attr) {
    const parts = [];
    if (attr.bold) parts.push("1");
    if (attr.dim) parts.push("2");
    if (attr.italic) parts.push("3");
    if (attr.underline) parts.push("4");
    if (attr.inverse) parts.push("7");
    if (attr.fg < 8) parts.push(String(30 + attr.fg));
    else if (attr.fg < 16) parts.push(String(90 + attr.fg - 8));
    else parts.push(`38;5;${attr.fg}`);
    if (attr.bg > 0) {
      if (attr.bg < 8) parts.push(String(40 + attr.bg));
      else if (attr.bg < 16) parts.push(String(100 + attr.bg - 8));
      else parts.push(`48;5;${attr.bg}`);
    }
    return parts.length > 0 ? `\x1b[${parts.join(";")}m` : "";
  }

  function renderPane(vt, pane, focused, label) {
    const { buffer, rows, cols } = vt.getScreen();
    const { top, left, width, height } = pane;

    let out = "";
    const borderColor = focused ? "\x1b[1;36m" : "\x1b[90m";
    const reset = "\x1b[0m";

    // Top border with label
    const labelText = label ? ` ${label} ` : "";
    const topLine = BOX.tl + labelText +
      BOX.h.repeat(Math.max(0, width - 2 - labelText.length)) + BOX.tr;
    out += moveTo(top, left) + borderColor + topLine + reset;
    // Content rows
    const innerWidth = width - 2;
    const innerHeight = height - 2;
    for (let r = 0; r < innerHeight; r++) {
      out += moveTo(top + 1 + r, left) + borderColor + BOX.v + reset;
      const bufRow = r < rows ? buffer[r] : null;
      let lastAttr = null;
      for (let c = 0; c < innerWidth; c++) {
        if (bufRow && c < cols) {
          const cell = bufRow[c];
          const ansi = attrToAnsi(cell.attr);
          if (ansi !== lastAttr) {
            out += reset + ansi;
            lastAttr = ansi;
          }
          out += cell.char;
        } else {
          if (lastAttr) { out += reset; lastAttr = null; }
          out += " ";
        }
      }
      out += reset + borderColor + BOX.v + reset;
    }

    // Bottom border
    const botLine = BOX.bl + BOX.h.repeat(Math.max(0, width - 2)) + BOX.br;
    out += moveTo(top + height - 1, left) + borderColor + botLine + reset;

    write(out);
  }

  function renderChatLog(pane, lines) {
    const { top, left, width, height } = pane;
    const innerWidth = width - 1;
    let out = "";
    const dim = "\x1b[90m";
    const reset = "\x1b[0m";

    for (let r = 0; r < height; r++) {
      out += moveTo(top + r, left);
      const line = r < lines.length ? lines[lines.length - height + r] || "" : "";
      const truncated = line.slice(0, innerWidth);
      out += truncated + " ".repeat(Math.max(0, innerWidth - truncated.length));
      out += dim + BOX.v + reset;
    }
    write(out);
  }

  function hideCursor() { write("\x1b[?25l"); }
  function showCursor() { write("\x1b[?25h"); }
  function clear() { write("\x1b[2J\x1b[H"); }

  return { renderPane, renderChatLog, hideCursor, showCursor, clear, moveTo };
}

module.exports = { createRenderer };

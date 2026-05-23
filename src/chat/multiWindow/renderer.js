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

  function isWide(ch) {
    const code = ch.codePointAt(0);
    if (code < 0x1100) return false;
    return (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd) ||
      (code >= 0x1f300 && code <= 0x1f9ff)
    );
  }

  function renderPane(vt, pane, focused, label) {
    const { buffer, rows, cols, cursorRow, cursorCol } = vt.getScreen();
    const { top, left, width, height } = pane;

    let out = "";
    const borderColor = focused ? "\x1b[1;36m" : "\x1b[90m";
    const reset = "\x1b[0m";

    const labelText = label ? ` ${label} ` : "";
    const topLine = BOX.tl + labelText +
      BOX.h.repeat(Math.max(0, width - 2 - labelText.length)) + BOX.tr;
    out += moveTo(top, left) + borderColor + topLine + reset;

    const innerWidth = width - 2;
    const innerHeight = height - 2;
    for (let r = 0; r < innerHeight; r++) {
      out += moveTo(top + 1 + r, left) + borderColor + BOX.v + reset;
      const bufRow = r < rows ? buffer[r] : null;
      let lastAttr = "";
      let col = 0;
      let c = 0;
      while (col < innerWidth && c < (bufRow ? cols : 0)) {
        const cell = bufRow[c];
        if (cell.wideContinuation) {
          c++;
          continue;
        }
        const atCursor = focused && r === cursorRow && c === cursorCol;
        const w = isWide(cell.char) ? 2 : 1;
        if (col + w > innerWidth) break;
        const attr = atCursor ? { ...cell.attr, inverse: !cell.attr.inverse } : cell.attr;
        const ansi = attrToAnsi(attr);
        if (ansi !== lastAttr) {
          out += reset + ansi;
          lastAttr = ansi;
        }
        out += cell.char || " ";
        col += w;
        c++;
      }
      if (lastAttr) out += reset;
      if (col < innerWidth) out += " ".repeat(innerWidth - col);
      out += borderColor + BOX.v + reset;
    }

    const botLine = BOX.bl + BOX.h.repeat(Math.max(0, width - 2)) + BOX.br;
    out += moveTo(top + height - 1, left) + borderColor + botLine + reset;

    write(out);
  }

  function renderCells(cells, maxWidth, cursorCol = -1) {
    let out = "";
    let lastAttr = "";
    let col = 0;
    let c = 0;
    while (col < maxWidth && c < cells.length) {
      const cell = cells[c];
      if (cell.wideContinuation) {
        c++;
        continue;
      }
      const w = isWide(cell.char) ? 2 : 1;
      if (col + w > maxWidth) break;
      const atCursor = c === cursorCol;
      const attr = atCursor ? { ...cell.attr, inverse: !cell.attr.inverse } : cell.attr;
      const ansi = attrToAnsi(attr);
      if (ansi !== lastAttr) {
        out += "\x1b[0m" + ansi;
        lastAttr = ansi;
      }
      out += cell.char || " ";
      col += w;
      c++;
    }
    if (lastAttr) out += "\x1b[0m";
    if (col < maxWidth) out += " ".repeat(maxWidth - col);
    return out;
  }

  function renderPlainLine(text, width, color = "") {
    const reset = "\x1b[0m";
    const raw = String(text || "");
    const truncated = truncateVisible(raw, width);
    const pad = Math.max(0, width - visibleLength(truncated));
    return `${color}${truncated}${" ".repeat(pad)}${reset}`;
  }

  function renderInternalPane(vt, pane, focused, info = {}) {
    const { buffer, rows, cols } = vt.getScreen();
    const { top, left, width, height } = pane;

    let out = "";
    const borderColor = focused ? "\x1b[1;36m" : "\x1b[90m";
    const reset = "\x1b[0m";
    const cyan = "\x1b[36m";
    const gray = "\x1b[90m";
    const red = "\x1b[31m";
    const magenta = "\x1b[35m";

    const label = info.label || "";
    const labelText = label ? ` ${label} ` : "";
    const topLine = BOX.tl + labelText +
      BOX.h.repeat(Math.max(0, width - 2 - labelText.length)) + BOX.tr;
    out += moveTo(top, left) + borderColor + topLine + reset;

    const innerWidth = width - 2;
    const innerHeight = height - 2;
    const chromeRows = innerHeight >= 6 ? 3 : 0;
    const logHeight = Math.max(1, innerHeight - chromeRows);
    let lastContentRow = -1;
    for (let r = rows - 1; r >= 0; r--) {
      const line = buffer[r] || [];
      const hasContent = line.some((cell) => cell && !cell.wideContinuation && cell.char && cell.char !== " ");
      if (hasContent) {
        lastContentRow = r;
        break;
      }
    }
    const sourceStart = lastContentRow >= 0
      ? Math.max(0, lastContentRow - logHeight + 1)
      : Math.max(0, rows - logHeight);

    for (let r = 0; r < logHeight; r++) {
      const bufRow = buffer[sourceStart + r] || [];
      out += moveTo(top + 1 + r, left) + borderColor + BOX.v + reset;
      out += renderCells(bufRow, innerWidth);
      out += borderColor + BOX.v + reset;
    }

    if (chromeRows > 0) {
      const status = String(info.status || "ready").toLowerCase();
      const detail = String(info.detail || "").trim();
      const statusColor = status === "blocked" || status === "error" ? red : (status === "ready" || status === "idle" ? gray : cyan);
      const statusLabel = status === "idle" ? "ready" : status;
      const statusText = `ufoo · ${label || "agent"} · ${statusLabel}${detail ? ` · ${detail}` : ""}`;
      const input = String(info.input || "");
      const inputCursor = Number.isFinite(info.cursor) ? Math.max(0, Math.min(input.length, info.cursor)) : input.length;
      const before = input.slice(0, inputCursor);
      const cursorChar = inputCursor < input.length ? input[inputCursor] : " ";
      const after = inputCursor < input.length ? input.slice(inputCursor + 1) : "";
      const baseRow = top + 1 + logHeight;

      out += moveTo(baseRow, left) + borderColor + BOX.v + reset +
        renderPlainLine(statusText, innerWidth, statusColor) +
        borderColor + BOX.v + reset;
      out += moveTo(baseRow + 1, left) + borderColor + BOX.v + reset +
        gray + BOX.h.repeat(innerWidth) + reset +
        borderColor + BOX.v + reset;
      out += moveTo(baseRow + 2, left) + borderColor + BOX.v + reset +
        renderPlainLine(`${magenta}› ${reset}${before}\x1b[7m${cursorChar}${reset}${after}`, innerWidth) +
        borderColor + BOX.v + reset;
    }

    const botLine = BOX.bl + BOX.h.repeat(Math.max(0, width - 2)) + BOX.br;
    out += moveTo(top + height - 1, left) + borderColor + botLine + reset;

    write(out);
  }

  function stripControl(str) {
    return str.replace(/[\x00-\x08\x0a-\x1f]/g, "");
  }

  function visibleLength(str) {
    return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").length;
  }

  function truncateVisible(str, maxWidth) {
    let visible = 0;
    let i = 0;
    while (i < str.length && visible < maxWidth) {
      if (str[i] === "\x1b" && str[i + 1] === "[") {
        const start = i;
        i += 2;
        while (i < str.length && str[i] >= "\x20" && str[i] <= "\x3f") i++;
        if (i < str.length) i++;
        continue;
      }
      visible++;
      i++;
    }
    return str.slice(0, i);
  }

  function classifyLogLine(raw = "") {
    const clean = stripControl(raw)
      .replace(/\{\/?[^{}\n]+\}/g, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
    const trimmed = clean.trim();
    if (!trimmed) return { kind: "spacer", text: " " };
    if (/^[█▀▄ ]+$/.test(trimmed) || /^ufoo chat/i.test(trimmed)) return { kind: "banner", text: clean };
    if (/^───.*───$/.test(trimmed)) return { kind: "divider", text: clean };
    if (/^(error:|✗|failed\b)/i.test(trimmed)) return { kind: "error", marker: "!", speaker: "error", body: clean.replace(/^(error:\s*)/i, "") };
    if (/^(✓|✔|done\b|closed\b)/i.test(trimmed)) return { kind: "success", marker: "✓", body: clean.replace(/^[✓✔]\s*/, "") };
    const dot = clean.match(/^([^·:\n]{1,34})\s+·\s+(.*)$/);
    if (dot) {
      const speaker = dot[1].trim();
      return {
        kind: speaker.toLowerCase() === "ufoo" ? "assistant" : "agent",
        marker: speaker.toLowerCase() === "ufoo" ? "◆" : "●",
        speaker,
        body: dot[2] || " ",
      };
    }
    const colon = clean.match(/^([A-Za-z0-9_.:@/-]{1,34}):\s+(.*)$/);
    if (colon) return { kind: "agent", marker: "●", speaker: colon[1], body: colon[2] || " " };
    return { kind: "plain", marker: "│", body: clean };
  }

  function formatChatLogLine(raw = "", width = 80) {
    const row = classifyLogLine(raw);
    const reset = "\x1b[0m";
    if (row.kind === "spacer") return " ".repeat(width);
    if (row.kind === "banner") return `\x1b[36;1m${truncateVisible(row.text, width)}${reset}`;
    if (row.kind === "divider") return `\x1b[90m${truncateVisible(row.text, width)}${reset}`;

    const palette = {
      assistant: { marker: "\x1b[36m", speaker: "\x1b[37;1m", body: "" },
      agent: { marker: "\x1b[36m", speaker: "\x1b[36m", body: "" },
      error: { marker: "\x1b[31;1m", speaker: "\x1b[31m", body: "\x1b[31m" },
      success: { marker: "\x1b[32m", speaker: "\x1b[32m", body: "\x1b[32m" },
      plain: { marker: "\x1b[90m", speaker: "\x1b[90m", body: "" },
    };
    const colors = palette[row.kind] || palette.plain;
    const speaker = row.speaker ? `${colors.speaker}${row.speaker}${reset}\x1b[90m · ${reset}` : "";
    const line = `${colors.marker}${row.marker || "│"}${reset} ${speaker}${colors.body || ""}${row.body || row.text || " "}${reset}`;
    return truncateVisible(line, width);
  }

  function renderChatLog(pane, lines) {
    const { top, left, width, height } = pane;
    const innerWidth = width - 1;
    let out = "";
    const dim = "\x1b[90m";
    const reset = "\x1b[0m";

    for (let r = 0; r < height; r++) {
      out += moveTo(top + r, left);
      const idx = lines.length - height + r;
      const raw = (idx >= 0 && idx < lines.length) ? lines[idx] || "" : "";
      const truncated = formatChatLogLine(raw, innerWidth);
      const pad = Math.max(0, innerWidth - visibleLength(truncated));
      out += truncated + reset + " ".repeat(pad);
      out += dim + BOX.v + reset;
    }
    write(out);
  }

  function renderSeparator(pane, highlighted) {
    const { top, left, width } = pane;
    const reset = "\x1b[0m";
    const color = highlighted ? "\x1b[36m" : "\x1b[90m";
    write(moveTo(top, left) + color + "─".repeat(width) + reset);
  }

  function renderStatusLine(pane, text) {
    const { top, left, width } = pane;
    const reset = "\x1b[0m";
    const dim = "\x1b[90m";
    const truncated = truncateVisible(text || "", width);
    const pad = Math.max(0, width - visibleLength(truncated));
    write(moveTo(top, left) + dim + truncated + " ".repeat(pad) + reset);
  }

  function renderDashboard(pane, lines) {
    const { top, left, width } = pane;
    const reset = "\x1b[0m";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || "";
      const pad = Math.max(0, width - visibleLength(line));
      write(moveTo(top + i, left) + line + " ".repeat(pad) + reset);
    }
  }

  function renderInputPrompt(pane, prefix, draft, cursor) {
    const { top, left, width } = pane;
    const reset = "\x1b[0m";
    const cyan = "\x1b[36m";
    const inverse = "\x1b[7m";
    const prefixStr = prefix || "› ";
    const text = draft || "";
    const cursorPos = typeof cursor === "number" ? Math.max(0, Math.min(text.length, cursor)) : text.length;
    const before = text.slice(0, cursorPos);
    const cursorChar = cursorPos < text.length ? text[cursorPos] : " ";
    const after = cursorPos < text.length ? text.slice(cursorPos + 1) : "";
    const promptLine = cyan + prefixStr + reset + before + inverse + cursorChar + reset + after;
    const truncated = truncateVisible(promptLine, width);
    const pad = Math.max(0, width - visibleLength(truncated));
    write(moveTo(top, left) + truncated + " ".repeat(pad) + reset);
  }

  function hideCursor() { write("\x1b[?25l"); }
  function showCursor() { write("\x1b[?25h"); }
  function clear() { write("\x1b[2J\x1b[H"); }

  function clearRows(top, count, width, left = 0) {
    const rows = Math.max(0, Number(count) || 0);
    const cols = Math.max(0, Number(width) || 0);
    if (rows === 0 || cols === 0) return;
    let out = "";
    const blank = " ".repeat(cols);
    for (let i = 0; i < rows; i++) {
      out += moveTo(top + i, left) + blank;
    }
    write(out);
  }

  return {
    renderPane,
    renderInternalPane,
    renderChatLog,
    renderSeparator,
    renderStatusLine,
    renderDashboard,
    renderInputPrompt,
    hideCursor,
    showCursor,
    clear,
    clearRows,
    moveTo,
    write,
    visibleLength,
  };
}

module.exports = { createRenderer };

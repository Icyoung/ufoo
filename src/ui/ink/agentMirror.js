"use strict";

/**
 * Raw PTY passthrough for the internal-agent view.
 *
 * Ink can't usefully render arbitrary ANSI inside a Box (it would lose
 * cursor positioning, scroll regions and curses-style redraws), so this
 * helper takes over stdout/stdin while the user is "inside" an agent.
 * The strategy mirrors the blessed implementation:
 *   - clear the screen, set a scroll region with a 1-line bottom bar
 *   - stream agentSockets data straight to process.stdout
 *   - forward raw stdin bytes to agentSockets.sendRaw
 *   - on Esc, run the cleanup callback and let ChatApp re-render
 *
 * Returns a stop() function that the caller invokes on exit.
 */

const { createAgentSockets } = require("../../app/chat/agentSockets");
const { loadInternalAgentLogHistory } = require("../../app/chat/internalAgentLogHistory");
const { IPC_REQUEST_TYPES, IPC_RESPONSE_TYPES } = require("../../runtime/contracts/eventContract");
const { getUfooPaths } = require("../../coordination/state/paths");
const os = require("os");
const path = require("path");
const readline = require("readline");

function stripAnsi(text = "") {
  return String(text || "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function decodeEscapedNewlines(text = "") {
  return String(text || "").replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n");
}

function charDisplayWidth(char = "") {
  if (!char) return 0;
  const code = char.codePointAt(0) || 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)) {
    return 0;
  }
  if ((code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)) {
    return 2;
  }
  return 1;
}

function displayWidth(text = "") {
  return Array.from(stripAnsi(String(text || ""))).reduce((sum, char) => sum + charDisplayWidth(char), 0);
}

function padToWidth(text = "", width = 1) {
  const cells = displayWidth(text);
  return String(text || "") + " ".repeat(Math.max(0, width - cells));
}

function truncateToWidth(text = "", width = 1) {
  const target = Math.max(1, width);
  let out = "";
  let cells = 0;
  for (const char of Array.from(stripAnsi(String(text || "")))) {
    const charWidth = charDisplayWidth(char);
    if (cells + charWidth > target) break;
    out += char;
    cells += charWidth;
  }
  return padToWidth(out, target);
}

function fitText(text = "", width = 1) {
  const normalizedWidth = Math.max(1, width);
  const clean = stripAnsi(String(text || "")).replace(/\r/g, "");
  if (displayWidth(clean) <= normalizedWidth) {
    return padToWidth(clean, normalizedWidth);
  }
  if (normalizedWidth <= 1) return truncateToWidth(clean, normalizedWidth);
  return `${truncateToWidth(clean, normalizedWidth - 1).trimEnd()}…`;
}

function horizontalLine(width = 80) {
  return "─".repeat(Math.max(1, width));
}

function sliceDisplayCells(text = "", startCell = 0, maxCells = 1) {
  const targetStart = Math.max(0, startCell);
  const targetWidth = Math.max(1, maxCells);
  let out = "";
  let cells = 0;
  let started = false;
  for (const char of Array.from(String(text || ""))) {
    const charWidth = charDisplayWidth(char);
    const nextCells = cells + charWidth;
    if (!started) {
      if (nextCells <= targetStart) {
        cells = nextCells;
        continue;
      }
      started = true;
    }
    if (displayWidth(out) + charWidth > targetWidth) break;
    out += char;
    cells = nextCells;
  }
  return out;
}

function wrapTextLine(text = "", width = 80) {
  const inner = Math.max(1, width);
  const clean = stripAnsi(String(text || ""));
  if (!clean) return [""];
  const lines = [];
  let current = "";
  let cells = 0;
  for (const char of Array.from(clean)) {
    const charWidth = charDisplayWidth(char);
    if (cells > 0 && cells + charWidth > inner) {
      lines.push(current);
      current = "";
      cells = 0;
    }
    current += char;
    cells += charWidth;
  }
  lines.push(current);
  return lines;
}

function inputBoundaries(text = "") {
  const source = String(text || "");
  if (!source) return [0];
  try {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const boundaries = [0];
      for (const part of segmenter.segment(source)) {
        boundaries.push(part.index + part.segment.length);
      }
      return Array.from(new Set(boundaries)).sort((a, b) => a - b);
    }
  } catch {
    // Fall through to code point boundaries.
  }
  const boundaries = [0];
  let offset = 0;
  for (const char of Array.from(source)) {
    offset += char.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function compactProjectPath(projectRoot = "") {
  const raw = String(projectRoot || process.cwd() || "").trim();
  const home = os.homedir();
  if (home && (raw === home || raw.startsWith(`${home}/`))) {
    return `~${raw.slice(home.length)}`;
  }
  return raw || ".";
}

function parseBusDisplayMessage(raw = "") {
  let displayMessage = String(raw || "");
  let streamPayload = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.reply) {
      displayMessage = parsed.reply;
    } else if (parsed && typeof parsed === "object" && parsed.stream) {
      streamPayload = parsed;
    }
  } catch {
    // Not JSON.
  }
  return {
    displayMessage: decodeEscapedNewlines(displayMessage),
    streamPayload,
  };
}

function normalizeActivityState(value = "") {
  const state = String(value || "").trim().toLowerCase();
  if (state === "waiting") return "waiting_input";
  if (state === "busy" || state === "processing") return "working";
  return state;
}

function activityLabel(state = "") {
  if (state === "waiting_input") return "waiting";
  if (state === "idle" || state === "ready") return "ready";
  return state || "ready";
}

function startAgentMirror({
  agentId,
  projectRoot,
  onExit = () => {},
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!agentId) throw new Error("startAgentMirror requires agentId");

  const cols = stdout.columns || 80;
  const rows = stdout.rows || 24;

  // Mirror the daemon socket lookup:
  // <bus-queues-dir>/<safeName>/inject.sock.
  const safeName = String(agentId || "").replace(/[^A-Za-z0-9_-]/g, "_");
  const sockPath = path.join(
    getUfooPaths(projectRoot || process.cwd()).busQueuesDir,
    safeName,
    "inject.sock"
  );

  const writeOut = (text) => stdout.write(text);

  const sockets = createAgentSockets({
    onTermWrite: (text) => writeOut(text),
    onPlaceCursor: (cursor) => {
      if (!cursor) return;
      const row = Math.max(1, (cursor.row || 0) + 1);
      const col = Math.max(1, (cursor.col || 0) + 1);
      writeOut(`\x1b[${row};${col}H`);
    },
    isAgentView: () => true,
    isBusMode: () => false,
    getViewingAgent: () => agentId,
    sendBusRaw: () => {},
  });

  // Clear screen + reserve a 1-line bar at the bottom for our exit hint.
  writeOut("\x1b[2J\x1b[H");
  writeOut(`\x1b[1;${Math.max(1, rows - 1)}r`);
  writeOut(`\x1b[${rows};1H\x1b[7m esc esc \x1b[0m return to chat · attached to ${agentId}`);
  writeOut("\x1b[H");

  sockets.connectOutput(sockPath);
  sockets.connectInput(sockPath);
  sockets.sendResize(cols, Math.max(1, rows - 1));

  let stopped = false;
  const wasRaw = Boolean(stdin.isRaw);
  if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
  stdin.resume();

  let escCount = 0;
  let escTimer = null;

  const onData = (chunk) => {
    if (stopped) return;
    if (chunk.length === 1 && chunk[0] === 0x1b) {
      escCount += 1;
      if (escCount >= 2) {
        clearTimeout(escTimer);
        escCount = 0;
        stop();
        return;
      }
      escTimer = setTimeout(() => { escCount = 0; }, 300);
      return;
    }
    if (escCount > 0) {
      clearTimeout(escTimer);
      escCount = 0;
      sockets.sendRaw(Buffer.concat([Buffer.from([0x1b]), chunk]));
      return;
    }
    sockets.sendRaw(chunk);
  };

  const onResize = () => {
    if (stopped) return;
    const cols2 = stdout.columns || 80;
    const rows2 = stdout.rows || 24;
    writeOut(`\x1b[1;${Math.max(1, rows2 - 1)}r`);
    sockets.sendResize(cols2, Math.max(1, rows2 - 1));
  };

  stdin.on("data", onData);
  stdout.on && stdout.on("resize", onResize);

  function stop() {
    if (stopped) return;
    stopped = true;
    stdin.off("data", onData);
    if (stdout.off) stdout.off("resize", onResize);
    sockets.disconnectOutput();
    sockets.disconnectInput();
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
    // Reset scroll region + clear screen so the next ink mount has a
    // clean canvas.
    writeOut(`\x1b[1;${stdout.rows || 24}r`);
    writeOut("\x1b[2J\x1b[H");
    onExit();
  }

  return stop;
}

function startInternalAgentMirror({
  agentId,
  agentLabel = "",
  agentAliases = [],
  projectRoot,
  daemonConnection = null,
  setDaemonMessageHandler = () => {},
  onExit = () => {},
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!agentId) throw new Error("startInternalAgentMirror requires agentId");

  const label = String(agentLabel || agentId);
  let inputValue = "";
  let inputCursor = 0;
  let logLines = [];
  let replyActive = false;
  let stopped = false;
  let statusState = "ready";
  let statusDetail = "";

  const writeOut = (text) => stdout.write(text);
  const cols = () => Math.max(20, stdout.columns || 80);
  const rows = () => Math.max(8, stdout.rows || 24);
  const aliases = new Set([String(agentId), label].concat(agentAliases || []).filter(Boolean).map(String));

  function writeAt(row, content = "") {
    writeOut(`\x1b[${row};1H\x1b[2K${content}`);
  }

  function buildStartupLines(width) {
    return [
      fitText(`ufoo internal agent · ${label}`, width),
      fitText(`agent: ${agentId}`, width),
      fitText(`directory: ${compactProjectPath(projectRoot)}`, width),
      "",
    ];
  }

  function resetLogLines() {
    let history = [];
    try {
      history = loadInternalAgentLogHistory(projectRoot || process.cwd(), agentId, {
        maxEvents: 400,
        maxLines: 1000,
      });
    } catch {
      history = [];
    }
    logLines = buildStartupLines(cols()).concat(history.length > 0 ? history : [""]);
  }

  function trimLogLines() {
    if (logLines.length > 1000) logLines = logLines.slice(-1000);
  }

  function appendLog(text = "") {
    const clean = stripAnsi(String(text || "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (logLines.length === 0) logLines.push("");
    for (const char of clean) {
      if (char === "\n") {
        logLines.push("");
      } else {
        logLines[logLines.length - 1] += char;
      }
    }
    trimLogLines();
    if (clean.endsWith("\n")) replyActive = false;
  }

  function ensureReplyPrefix(prefix = "* ") {
    if (logLines.length === 0) {
      logLines.push(prefix);
      return;
    }
    if (logLines[logLines.length - 1] === "") {
      logLines[logLines.length - 1] = prefix;
      return;
    }
    logLines.push(prefix);
  }

  function appendAgentReply(text = "") {
    const clean = stripAnsi(String(text || "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!clean) return;
    for (const char of clean) {
      if (char === "\n") {
        logLines.push("");
        replyActive = false;
        continue;
      }
      if (!replyActive) {
        ensureReplyPrefix("* ");
        replyActive = true;
      } else if (logLines.length === 0 || logLines[logLines.length - 1] === "") {
        ensureReplyPrefix("  ");
      }
      logLines[logLines.length - 1] += char;
    }
    trimLogLines();
  }

  function previousBoundary(pos = inputCursor) {
    const boundaries = inputBoundaries(inputValue);
    const target = Math.max(0, Math.min(inputValue.length, pos));
    let prev = 0;
    for (const boundary of boundaries) {
      if (boundary < target) prev = boundary;
      else break;
    }
    return prev;
  }

  function nextBoundary(pos = inputCursor) {
    const boundaries = inputBoundaries(inputValue);
    const target = Math.max(0, Math.min(inputValue.length, pos));
    for (const boundary of boundaries) {
      if (boundary > target) return boundary;
    }
    return inputValue.length;
  }

  function insertInput(text = "") {
    const value = String(text || "");
    if (!value) return;
    inputValue = inputValue.slice(0, inputCursor) + value + inputValue.slice(inputCursor);
    inputCursor += value.length;
    render();
  }

  function getInputViewport(width) {
    const inner = Math.max(1, width - 2);
    const value = String(inputValue || "").replace(/\n/g, "⏎");
    const beforeCursor = String(inputValue || "").slice(0, inputCursor).replace(/\n/g, "⏎");
    const cursorCells = displayWidth(beforeCursor);
    let startCell = 0;
    if (cursorCells >= inner) startCell = cursorCells - inner + 1;
    return {
      text: sliceDisplayCells(value, startCell, inner),
      cursorCol: Math.max(0, cursorCells - startCell),
    };
  }

  function buildStatusLine(width) {
    const labelText = activityLabel(statusState);
    const detail = statusDetail ? ` · ${statusDetail}` : "";
    return fitText(`ufoo · ${labelText} · Enter send · Esc back${detail}`, width);
  }

  function getVisibleLogLines(width, height) {
    const wrapped = [];
    for (const line of logLines) wrapped.push(...wrapTextLine(line, width));
    return wrapped.slice(-Math.max(1, height));
  }

  function render() {
    if (stopped) return;
    const width = cols();
    const height = rows();
    const inputTop = Math.max(4, height - 3);
    const logRows = Math.max(1, inputTop - 2);
    const visible = getVisibleLogLines(width, logRows);

    writeOut("\x1b[?25l");
    for (let i = 0; i < logRows; i += 1) {
      writeAt(1 + i, fitText(visible[i] || "", width));
    }
    writeAt(inputTop - 1, buildStatusLine(width));
    writeAt(inputTop, horizontalLine(width));
    const viewport = getInputViewport(width);
    writeAt(inputTop + 1, fitText(`> ${viewport.text}`, width));
    writeAt(inputTop + 2, horizontalLine(width));
    writeAt(height, fitText(`esc return to chat · internal bus · ${label}`, width));
    writeOut(`\x1b[${inputTop + 1};${Math.max(1, Math.min(width, 3 + viewport.cursorCol))}H\x1b[?25h`);
  }

  function isAlias(value) {
    return aliases.has(String(value || ""));
  }

  function updateStatusFromMeta(meta = {}) {
    const nextState = normalizeActivityState(meta.activity_state || meta.state || "");
    const nextDetail = String(meta.activity_detail || meta.detail || meta.status_text || "").trim();
    if (!nextState && !nextDetail) return;
    const normalized = nextState || statusState || "ready";
    if (normalized !== statusState || nextDetail !== statusDetail) {
      statusState = normalized;
      statusDetail = nextDetail;
    }
  }

  function handleStatusMessage(msg) {
    const data = msg && msg.data && typeof msg.data === "object" ? msg.data : {};
    const metaList = Array.isArray(data.active_meta) ? data.active_meta : [];
    for (const meta of metaList) {
      const metaId = meta && (meta.fullId || meta.subscriber_id || meta.id) ? String(meta.fullId || meta.subscriber_id || meta.id) : "";
      if (isAlias(metaId) || isAlias(`${meta.type || ""}:${meta.id || ""}`)) {
        updateStatusFromMeta(meta);
        break;
      }
    }
    render();
  }

  function handleBusMessage(msg) {
    const data = msg && msg.data && typeof msg.data === "object" ? msg.data : {};
    if (data.event === "activity_state_changed") {
      const actor = String(data.subscriber || data.publisher || "").trim();
      if (isAlias(actor)) {
        updateStatusFromMeta({
          activity_state: data.state || data.activity_state,
          activity_detail: data.detail || (data.data && data.data.detail) || data.message || "",
        });
        render();
      }
      return;
    }

    const publisher = String(data.publisher || (data.event === "broadcast" ? "broadcast" : "bus"));
    const target = String(data.target || data.subscriber || "");
    const fromAgent = isAlias(publisher);
    const toAgent = isAlias(target);
    if (!fromAgent && !toAgent) return;

    const rawMessage = String(data.message || "");
    const { displayMessage, streamPayload } = parseBusDisplayMessage(rawMessage);
    if (data.silent && !streamPayload) return;

    const ownPrompt = data.source === "chat-internal-agent-view" && toAgent && !fromAgent;
    if (ownPrompt) return;

    if (streamPayload) {
      if (fromAgent) {
        const delta = typeof streamPayload.delta === "string"
          ? decodeEscapedNewlines(streamPayload.delta)
          : "";
        if (delta) appendAgentReply(delta);
        if (streamPayload.done) replyActive = false;
        render();
      }
      return;
    }

    if (!displayMessage) return;
    if (fromAgent) {
      appendAgentReply(`${displayMessage}\n`);
    } else if (toAgent) {
      appendLog(`> ${displayMessage}\n`);
    }
    render();
  }

  function handleDaemonMessage(msg) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === IPC_RESPONSE_TYPES.STATUS) {
      handleStatusMessage(msg);
    } else if (msg.type === IPC_RESPONSE_TYPES.BUS) {
      handleBusMessage(msg);
    } else if (msg.type === IPC_RESPONSE_TYPES.ERROR) {
      appendLog(`[Error] ${msg.error || "unknown error"}\n`);
      render();
    } else if (msg.type === IPC_RESPONSE_TYPES.BUS_SEND_OK) {
      statusState = "ready";
      statusDetail = "";
      render();
    }
    return false;
  }

  function send(req) {
    if (!daemonConnection || typeof daemonConnection.send !== "function") {
      appendLog("[Error] daemon connection unavailable\n");
      render();
      return;
    }
    daemonConnection.send(req);
  }

  function submitInput() {
    const text = String(inputValue || "").trim();
    if (!text) {
      render();
      return;
    }
    appendLog(`> ${text}\n`);
    replyActive = false;
    inputValue = "";
    inputCursor = 0;
    statusState = "working";
    statusDetail = "";
    send({
      type: IPC_REQUEST_TYPES.BUS_SEND,
      target: agentId,
      message: text,
      injection_mode: "immediate",
      source: "chat-internal-agent-view",
    });
    render();
  }

  const onKeypress = (str, key = {}) => {
    if (stopped) return;
    const name = key && key.name;
    if (name === "escape" || (key && key.ctrl && name === "c")) {
      stop();
      return;
    }
    if (name === "return" || name === "enter") {
      if (key && (key.shift || key.meta)) insertInput("\n");
      else submitInput();
      return;
    }
    if (key && key.ctrl && name === "u") {
      inputValue = "";
      inputCursor = 0;
      render();
      return;
    }
    if (key && key.ctrl && name === "a") {
      inputCursor = 0;
      render();
      return;
    }
    if (key && key.ctrl && name === "e") {
      inputCursor = inputValue.length;
      render();
      return;
    }
    if (name === "left") {
      inputCursor = previousBoundary();
      render();
      return;
    }
    if (name === "right") {
      inputCursor = nextBoundary();
      render();
      return;
    }
    if (name === "home") {
      inputCursor = 0;
      render();
      return;
    }
    if (name === "end") {
      inputCursor = inputValue.length;
      render();
      return;
    }
    if (name === "backspace") {
      if (inputCursor > 0) {
        const prev = previousBoundary();
        inputValue = inputValue.slice(0, prev) + inputValue.slice(inputCursor);
        inputCursor = prev;
        render();
      }
      return;
    }
    if (name === "delete") {
      if (inputCursor < inputValue.length) {
        const next = nextBoundary();
        inputValue = inputValue.slice(0, inputCursor) + inputValue.slice(next);
        render();
      }
      return;
    }
    if (str && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]+$/.test(str)) {
      insertInput(str.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    }
  };

  const onResize = () => render();
  const wasRaw = Boolean(stdin.isRaw);
  resetLogLines();

  writeOut("\x1b[2J\x1b[H");
  writeOut(`\x1b[1;${Math.max(1, rows() - 1)}r`);
  setDaemonMessageHandler(handleDaemonMessage);
  try {
    if (daemonConnection && typeof daemonConnection.connect === "function") {
      Promise.resolve(daemonConnection.connect()).catch((err) => {
        appendLog(`[Error] ${err && err.message ? err.message : err}\n`);
        render();
      });
    }
  } catch (err) {
    appendLog(`[Error] ${err && err.message ? err.message : err}\n`);
  }
  send({ type: IPC_REQUEST_TYPES.BUS_WATCH, agent_id: agentId, enabled: true });
  send({ type: IPC_REQUEST_TYPES.STATUS });
  render();

  if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
  stdin.resume();
  readline.emitKeypressEvents(stdin);
  stdin.on("keypress", onKeypress);
  stdout.on && stdout.on("resize", onResize);

  function stop() {
    if (stopped) return;
    stopped = true;
    send({ type: IPC_REQUEST_TYPES.BUS_WATCH, agent_id: agentId, enabled: false });
    setDaemonMessageHandler(() => {});
    if (stdin.off) stdin.off("keypress", onKeypress);
    else if (stdin.removeListener) stdin.removeListener("keypress", onKeypress);
    if (stdout.off) stdout.off("resize", onResize);
    else if (stdout.removeListener) stdout.removeListener("resize", onResize);
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
    writeOut(`\x1b[1;${stdout.rows || 24}r`);
    writeOut("\x1b[2J\x1b[H\x1b[?25h");
    onExit();
  }

  return stop;
}

module.exports = { startAgentMirror, startInternalAgentMirror };

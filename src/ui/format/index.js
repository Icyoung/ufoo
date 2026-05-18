"use strict";

/**
 * Pure formatting + input-math helpers shared between the legacy blessed TUI
 * (src/code/tui.js, src/chat/index.js) and the new ink-based TUIs under
 * src/ui/components/. No blessed import allowed in this module.
 *
 * Anything that touches a blessed widget (escapeBlessedLiteral, the blessed
 * banner builder, resolveLogContentWidth) stays in src/code/tui.js.
 */

const chalk = require("chalk");
const pkg = require("../../../package.json");

const UCODE_BANNER_LINES = [
  "█ █ █▀▀ █▀█ █▀▄ █▀▀",
  "█ █ █   █ █ █ █ █▀ ",
  "▀▀▀ ▀▀▀ ▀▀▀ ▀▀  ▀▀▀",
];

const UCODE_VERSION = String((pkg && pkg.version) || "dev");

const STATUS_INDICATORS = {
  thinking: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  typing: ["◐", "◓", "◑", "◒"],
  waiting: ["∙", "∙∙", "∙∙∙", "∙∙", "∙"],
};

const ANSI_PATTERN = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

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

function displayCellWidth(text = "") {
  return Array.from(String(text || "").replace(ANSI_PATTERN, "")).reduce(
    (sum, char) => sum + charDisplayWidth(char),
    0
  );
}

// NOTE: returns a blessed-flavoured tag string ("{cyan-bg}{white-fg}...").
// Used by the legacy blessed TUI; ink callers should not render this directly
// (the tags would show up as literal text). When P1 needs the same output for
// ink, add a sibling helper that emits chalk/ANSI instead.
function formatHighlightedUserInput(text = "", {
  width = 80,
  escapeText = (value) => String(value || ""),
} = {}) {
  const plain = String(text || "").trim();
  if (!plain) return "";
  const targetWidth = Math.max(1, Math.floor(Number(width) || 80) - 1);
  const prefix = " → ";
  const suffix = " ";
  const contentWidth = displayCellWidth(`${prefix}${plain}${suffix}`);
  const pad = " ".repeat(Math.max(0, targetWidth - contentWidth));
  return `{cyan-bg}{white-fg}${prefix}${escapeText(plain)}${suffix}${pad}{/white-fg}{/cyan-bg}`;
}

class StreamBuffer {
  constructor(writer, options = {}) {
    this.writer = writer;
    this.buffer = "";
    this.delay = options.delay || 8;
    this.chunkSize = options.chunkSize || 3;
    this.isStreaming = false;
    this.streamPromise = null;
  }

  async write(text) {
    this.buffer += text;
    if (!this.isStreaming) {
      this.isStreaming = true;
      this.streamPromise = this.flush();
    }
    return this.streamPromise;
  }

  async flush() {
    while (this.buffer.length > 0) {
      const chunk = this.buffer.slice(0, this.chunkSize);
      this.buffer = this.buffer.slice(this.chunkSize);
      this.writer(chunk);
      if (this.buffer.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delay));
      }
    }
    this.isStreaming = false;
  }

  async finish() {
    if (this.isStreaming) {
      await this.streamPromise;
    }
    if (this.buffer.length > 0) {
      this.writer(this.buffer);
      this.buffer = "";
    }
  }
}

function normalizeModelLabel(model = "") {
  const text = String(model || "").trim();
  if (text) return text;
  return "default";
}

function buildUcodeBannerLines({ model = "", engine = "ufoo-core", nickname = "", agentId = "", workspaceRoot = "", sessionId = "", width = 0 } = {}) {
  const modelLabel = normalizeModelLabel(model);
  void width;
  void engine;
  void nickname;
  void agentId;

  const path = require("path");
  const os = require("os");
  const currentDir = workspaceRoot || process.cwd();
  const homeDir = os.homedir();

  let shortPath = currentDir;
  if (currentDir.startsWith(homeDir)) {
    shortPath = currentDir.replace(homeDir, "~");
  }
  shortPath = path.normalize(shortPath);

  const logoLines = UCODE_BANNER_LINES.map((line) => chalk.cyan(line));
  const infoLines = [];
  infoLines.push(`${chalk.dim("Version:")} ${chalk.cyan.bold(UCODE_VERSION)}`);
  infoLines.push(`${chalk.dim("Model:")} ${chalk.yellow(modelLabel)}`);
  infoLines.push(`${chalk.dim("Dictionary:")} ${chalk.gray(shortPath)}`);
  const normalizedSessionId = String(sessionId || "").trim();
  if (normalizedSessionId) {
    infoLines.push(`${chalk.dim("Session:")} ${chalk.gray(normalizedSessionId)}`);
  }
  const logoPadding = " ".repeat(
    UCODE_BANNER_LINES.reduce((max, line) => Math.max(max, String(line || "").length), 0)
  );
  const rows = Math.max(logoLines.length, infoLines.length);

  return Array.from({ length: rows }, (_, index) => {
    const logoLine = logoLines[index] || logoPadding;
    const info = infoLines[index] || "";
    return `  ${logoLine}  ${info}`;
  });
}

function shouldUseUcodeTui({ stdin, stdout, jsonOutput, forceTui = false, disableTui = false } = {}) {
  if (disableTui) return false;
  if (jsonOutput) return false;
  if (forceTui) return true;
  return Boolean(stdin && stdin.isTTY && stdout && stdout.isTTY);
}

function parseActiveAgentsFromBusStatus(busStatus = "") {
  const lines = String(busStatus || "").replace(ANSI_PATTERN, "").split(/\r?\n/);
  const agents = [];
  let inOnlineSection = false;

  for (const line of lines) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;

    if (/^Online agents:\s*$/i.test(trimmed)) {
      inOnlineSection = true;
      continue;
    }
    if (!inOnlineSection) continue;

    if (/^\(none\)$/i.test(trimmed)) {
      continue;
    }

    if (/^[A-Za-z][A-Za-z ]+:\s*$/.test(trimmed)) {
      break;
    }

    const rawId = trimmed.replace(/\s+\([^)]+\)\s*$/, "");
    if (!rawId) continue;
    const [type, ...idParts] = rawId.split(":");
    const id = idParts.join(":");
    if (!type) continue;

    agents.push({
      type,
      id,
      status: "active",
      fullId: rawId,
      nickname: (trimmed.match(/\(([^)]+)\)\s*$/) || [])[1] || "",
    });
  }

  if (agents.length === 0) {
    for (const line of lines) {
      const trimmed = String(line || "").trim();
      const match = trimmed.match(/^([a-z-]+):([a-f0-9]+)\s+\((active|idle)\)$/);
      if (!match) continue;
      agents.push({
        type: match[1],
        id: match[2],
        status: match[3],
        fullId: `${match[1]}:${match[2]}`,
        nickname: "",
      });
    }
  }

  return agents;
}

function loadActiveAgents(workspaceRoot) {
  try {
    const { execSync } = require("child_process");
    const busStatus = execSync("ufoo bus status", {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    return parseActiveAgentsFromBusStatus(busStatus);
  } catch {
    return [];
  }
}

function renderLogLinesWithMarkdown(text = "", state = {}, escapeFn = (value) => String(value || "")) {
  const { renderMarkdownLines } = require("../../shared/markdownRenderer");
  return renderMarkdownLines(text, state, escapeFn);
}

function shouldEnterAgentSelection(inputValue = "") {
  const text = String(inputValue || "");
  const trimmed = text.trim();
  return !trimmed;
}

function resolveAgentSelectionOnDown({
  agentSelectionMode = false,
  selectedAgentIndex = -1,
  totalAgents = 0,
} = {}) {
  const total = Number.isFinite(totalAgents) ? Math.max(0, Math.floor(totalAgents)) : 0;
  if (total <= 0) return { action: "none", index: -1 };
  if (agentSelectionMode) {
    const keep = selectedAgentIndex >= 0 && selectedAgentIndex < total ? selectedAgentIndex : 0;
    return { action: "hold", index: keep };
  }
  const enter = selectedAgentIndex >= 0 && selectedAgentIndex < total ? selectedAgentIndex : 0;
  return { action: "enter", index: enter };
}

function cycleAgentSelectionIndex(selectedAgentIndex = -1, totalAgents = 0, direction = "right") {
  const total = Number.isFinite(totalAgents) ? Math.max(0, Math.floor(totalAgents)) : 0;
  if (total <= 0) return -1;
  const current = selectedAgentIndex >= 0 && selectedAgentIndex < total ? selectedAgentIndex : 0;
  if (direction === "left") {
    return (current - 1 + total) % total;
  }
  return (current + 1) % total;
}

function shouldClearAgentSelectionOnUp({
  agentSelectionMode = false,
  inputValue = "",
} = {}) {
  return Boolean(agentSelectionMode && shouldEnterAgentSelection(inputValue));
}

function moveCursorHorizontally(cursorPos = 0, inputValue = "", direction = "right") {
  const text = String(inputValue || "");
  const max = text.length;
  const pos = Number.isFinite(cursorPos) ? Math.max(0, Math.floor(cursorPos)) : 0;
  if (direction === "left") return Math.max(0, pos - 1);
  return Math.min(max, pos + 1);
}

function clampCursorPos(cursorPos = 0, inputValue = "") {
  const text = String(inputValue || "");
  const pos = Number.isFinite(cursorPos) ? Math.floor(cursorPos) : 0;
  return Math.max(0, Math.min(text.length, pos));
}

function findLogicalLineStart(inputValue = "", cursorPos = 0) {
  const text = String(inputValue || "");
  const pos = clampCursorPos(cursorPos, text);
  const prevNewline = text.lastIndexOf("\n", Math.max(0, pos - 1));
  return prevNewline === -1 ? 0 : prevNewline + 1;
}

function findLogicalLineEnd(inputValue = "", cursorPos = 0) {
  const text = String(inputValue || "");
  const pos = clampCursorPos(cursorPos, text);
  const nextNewline = text.indexOf("\n", pos);
  return nextNewline === -1 ? text.length : nextNewline;
}

function moveCursorToVisualLineBoundary({
  cursorPos = 0,
  inputValue = "",
  width = 80,
  boundary = "start",
  strWidth,
} = {}) {
  const inputMath = require("../../chat/inputMath");
  const text = String(inputValue || "");
  const normalizedWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const pos = clampCursorPos(cursorPos, text);
  const { row } = inputMath.getCursorRowCol(text, pos, normalizedWidth, strWidth);
  if (boundary === "end") {
    return inputMath.getCursorPosForRowCol(text, row, normalizedWidth, normalizedWidth, strWidth);
  }
  return inputMath.getCursorPosForRowCol(text, row, 0, normalizedWidth, strWidth);
}

function moveCursorVertically({
  cursorPos = 0,
  inputValue = "",
  width = 80,
  direction = "down",
  preferredCol = null,
  strWidth,
} = {}) {
  const inputMath = require("../../chat/inputMath");
  const text = String(inputValue || "");
  const normalizedWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
  const pos = clampCursorPos(cursorPos, text);
  const { row, col } = inputMath.getCursorRowCol(text, pos, normalizedWidth, strWidth);
  const totalRows = inputMath.countLines(text, normalizedWidth, strWidth);
  const targetCol = Number.isFinite(preferredCol) ? preferredCol : col;

  if (direction === "up") {
    if (row <= 0) {
      return { moved: false, nextCursorPos: pos, preferredCol: targetCol, boundary: "top" };
    }
    return {
      moved: true,
      nextCursorPos: inputMath.getCursorPosForRowCol(text, row - 1, targetCol, normalizedWidth, strWidth),
      preferredCol: targetCol,
      boundary: "",
    };
  }

  if (row >= totalRows - 1) {
    return { moved: false, nextCursorPos: pos, preferredCol: targetCol, boundary: "bottom" };
  }
  return {
    moved: true,
    nextCursorPos: inputMath.getCursorPosForRowCol(text, row + 1, targetCol, normalizedWidth, strWidth),
    preferredCol: targetCol,
    boundary: "",
  };
}

function deleteWordBeforeCursor(inputValue = "", cursorPos = 0) {
  const text = String(inputValue || "");
  const pos = clampCursorPos(cursorPos, text);
  if (pos <= 0) return { value: text, cursorPos: pos };
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const match = before.match(/\s*\S+\s*$/);
  const start = match ? pos - match[0].length : Math.max(0, pos - 1);
  return {
    value: before.slice(0, start) + after,
    cursorPos: start,
  };
}

function moveCursorByWord(inputValue = "", cursorPos = 0, direction = "forward") {
  const text = String(inputValue || "");
  const pos = clampCursorPos(cursorPos, text);
  if (direction === "backward") {
    const before = text.slice(0, pos);
    const trimmedEnd = before.search(/\S\s*$/) >= 0 ? before.replace(/\s+$/, "") : before;
    const match = trimmedEnd.match(/\S+$/);
    return match ? trimmedEnd.length - match[0].length : 0;
  }
  const after = text.slice(pos);
  const match = after.match(/^\s*\S+/);
  return match ? Math.min(text.length, pos + match[0].length) : text.length;
}

function resolveHistoryDownTransition({
  inputHistory = [],
  historyIndex = 0,
  currentValue = "",
} = {}) {
  const history = Array.isArray(inputHistory) ? inputHistory : [];
  if (history.length <= 0) {
    return {
      moved: false,
      nextHistoryIndex: Number.isFinite(historyIndex) ? Math.max(0, Math.floor(historyIndex)) : 0,
      nextValue: String(currentValue || ""),
    };
  }
  const currentIndex = Number.isFinite(historyIndex) ? Math.max(0, Math.floor(historyIndex)) : 0;
  const nextHistoryIndex = Math.min(history.length, currentIndex + 1);
  const nextValue = nextHistoryIndex >= history.length ? "" : String(history[nextHistoryIndex] || "");
  const moved = nextHistoryIndex !== currentIndex || nextValue !== String(currentValue || "");
  return {
    moved,
    nextHistoryIndex,
    nextValue,
  };
}

function filterSelectableAgents(agents = [], selfSubscriberId = "") {
  const selfId = String(selfSubscriberId || "").trim();
  const list = Array.isArray(agents) ? agents : [];
  if (!selfId) {
    return list.filter((agent) => {
      const fullId = String(agent && agent.fullId ? agent.fullId : "").trim();
      const type = String(agent && agent.type ? agent.type : "").trim();
      if (fullId === "ufoo-agent") return false;
      if (type === "ufoo-agent") return false;
      return true;
    });
  }
  return list.filter((agent) => {
    const fullId = String(agent && agent.fullId ? agent.fullId : "").trim();
    const type = String(agent && agent.type ? agent.type : "").trim();
    if (!fullId) return true;
    if (fullId === "ufoo-agent") return false;
    if (type === "ufoo-agent") return false;
    return fullId !== selfId;
  });
}

function stripLeakedEscapeTags(text = "") {
  const source = String(text == null ? "" : text);
  const withoutClosedTags = source.replace(/\{[^{}\n]*escape[^{}\n]*\}/gi, "");
  const withoutDanglingEscape = withoutClosedTags.replace(/\{\s*\/?\s*escape[\s\S]*$/gi, "");
  return withoutDanglingEscape.replace(/\{\s*\/?\s*e?s?c?a?p?e?[^{}\n]*$/gi, "");
}

function findTrailingEscapeTagPrefix(text = "") {
  const raw = String(text == null ? "" : text);
  if (!raw) return "";
  const windowSize = 40;
  const tail = raw.slice(Math.max(0, raw.length - windowSize));
  const braceIndex = tail.lastIndexOf("{");
  if (braceIndex < 0) return "";
  const suffix = tail.slice(braceIndex);
  if (suffix.includes("}")) return "";

  const compact = suffix.toLowerCase().replace(/\s+/g, "");
  if (!compact.startsWith("{")) return "";
  if (/^\{\/?e?s?c?a?p?e?[^}]*$/.test(compact)) {
    return suffix;
  }
  return "";
}

function createEscapeTagStripper() {
  let carry = "";

  return {
    write(chunk = "") {
      const incoming = String(chunk == null ? "" : chunk);
      if (!incoming && !carry) return "";
      const combined = `${carry}${incoming}`;
      const trailing = findTrailingEscapeTagPrefix(combined);
      const safeText = trailing
        ? combined.slice(0, combined.length - trailing.length)
        : combined;
      carry = trailing;
      return stripLeakedEscapeTags(safeText);
    },
    flush() {
      if (!carry) return "";
      const rest = "";
      carry = "";
      return rest;
    },
  };
}

function formatPendingElapsed(ms = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  return `${totalSeconds} s`;
}

function normalizeBashToolCommand(args = {}, payload = {}) {
  const argObj = args && typeof args === "object" ? args : {};
  const resObj = payload && typeof payload === "object" ? payload : {};
  const command = String(argObj.command || argObj.cmd || "").trim();
  const code = Number.isFinite(resObj.code) ? `exit ${resObj.code}` : "";
  return [command, code].filter(Boolean).join(" · ");
}

function normalizeToolMergeEntry(entry = {}) {
  const source = entry && typeof entry === "object" ? entry : {};
  const tool = String(source.tool || "").trim().toLowerCase() || "tool";
  const detail = String(source.detail || "").trim();
  const isError = Boolean(source.isError);
  const errorText = String(source.errorText || "").trim();
  const summary = [tool, detail].filter(Boolean).join(" · ") || tool;
  return {
    tool,
    detail,
    isError,
    errorText,
    summary,
  };
}

function buildMergedToolSummaryText(entries = []) {
  const list = Array.isArray(entries)
    ? entries.map((item) => normalizeToolMergeEntry(item))
    : [];
  const count = list.length;
  if (count <= 0) return "Ran tool";
  const first = list[0];
  if (count === 1) return `Ran ${first.summary}`;
  const errorCount = list.filter((item) => item.isError).length;
  const errorSuffix = errorCount > 0 ? ` · ${errorCount} error${errorCount === 1 ? "" : "s"}` : "";
  return `Ran ${first.summary} · … +${count - 1} calls${errorSuffix}`;
}

function buildMergedToolExpandedLines(entries = []) {
  const list = Array.isArray(entries)
    ? entries.map((item) => normalizeToolMergeEntry(item))
    : [];
  const maxLength = 120;
  return list.map((item) => {
    const base = item.summary;
    let line;
    if (!item.isError) {
      line = base;
    } else {
      line = item.errorText ? `${base} · error: ${item.errorText}` : `${base} · error`;
    }
    if (line.length > maxLength) {
      return line.slice(0, maxLength - 3) + "...";
    }
    return line;
  });
}

module.exports = {
  ANSI_PATTERN,
  STATUS_INDICATORS,
  StreamBuffer,
  UCODE_BANNER_LINES,
  UCODE_VERSION,
  buildMergedToolExpandedLines,
  buildMergedToolSummaryText,
  buildUcodeBannerLines,
  charDisplayWidth,
  clampCursorPos,
  createEscapeTagStripper,
  cycleAgentSelectionIndex,
  deleteWordBeforeCursor,
  displayCellWidth,
  filterSelectableAgents,
  findLogicalLineEnd,
  findLogicalLineStart,
  findTrailingEscapeTagPrefix,
  formatHighlightedUserInput,
  formatPendingElapsed,
  loadActiveAgents,
  moveCursorByWord,
  moveCursorHorizontally,
  moveCursorToVisualLineBoundary,
  moveCursorVertically,
  normalizeBashToolCommand,
  normalizeModelLabel,
  normalizeToolMergeEntry,
  parseActiveAgentsFromBusStatus,
  renderLogLinesWithMarkdown,
  resolveAgentSelectionOnDown,
  resolveHistoryDownTransition,
  shouldClearAgentSelectionOnUp,
  shouldEnterAgentSelection,
  shouldUseUcodeTui,
  stripLeakedEscapeTags,
};

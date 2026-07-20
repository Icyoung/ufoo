"use strict";

/**
 * Pure formatting + input-math helpers for the ink-based TUIs under
 * src/ui/ink/. No terminal widget import is allowed in this module.
 */

const chalk = require("chalk");
const pkg = require("../../../package.json");

const UCODE_BANNER_LINES = [
  "█ █ █▀▀ █▀█ █▀▄ █▀▀",
  "█ █ █   █ █ █ █ █▀ ",
  "▀▀▀ ▀▀▀ ▀▀▀ ▀▀  ▀▀▀",
];

const UCODE_VERSION = String((pkg && pkg.version) || "dev");

// Flying-saucer patrol for busy/loading states: the 🛸 drifts left-right
// inside a fixed 6-cell field (three emoji slots), so the status text after
// it stays anchored instead of shifting with the saucer.
const UFO_FIELD_CELLS = 6;
const UFO_FRAMES = [];
for (let i = 0; i <= UFO_FIELD_CELLS - 2; i += 1) {
  UFO_FRAMES.push(`${" ".repeat(i)}🛸${" ".repeat(UFO_FIELD_CELLS - 2 - i)}`);
}
for (let i = UFO_FIELD_CELLS - 3; i > 0; i -= 1) {
  UFO_FRAMES.push(`${" ".repeat(i)}🛸${" ".repeat(UFO_FIELD_CELLS - 2 - i)}`);
}

const STATUS_INDICATORS = {
  thinking: UFO_FRAMES,
  typing: UFO_FRAMES,
  waiting: ["∙", "∙∙", "∙∙∙", "∙∙", "∙"],
};

// Friendly labels for the tool-call events surfaced in the status line.
// Keep this list in sync with the keys handled by buildMergedToolSummaryText.
const TOOL_LABELS = {
  read: "Reading file",
  write: "Writing file",
  edit: "Editing file",
  bash: "Running command",
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
  const { renderMarkdownLines } = require("./markdownRenderer");
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
  const inputMath = require("../../app/chat/inputMath");
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
  const inputMath = require("../../app/chat/inputMath");
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
  if (currentIndex >= history.length) {
    return {
      moved: false,
      nextHistoryIndex: history.length,
      nextValue: String(currentValue || ""),
    };
  }
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

function appendToolMergeEntry(currentMerge = null, entry = {}, scope = 0, nextId = 1) {
  const toolEntry = normalizeToolMergeEntry(entry);
  const current = currentMerge && typeof currentMerge === "object" ? currentMerge : null;
  const normalizedScope = Number.isFinite(Number(scope)) ? Number(scope) : 0;
  if (current && current.scope === normalizedScope && Array.isArray(current.entries)) {
    return {
      ...current,
      entries: current.entries.concat([toolEntry]),
    };
  }
  return {
    id: Number.isFinite(Number(nextId)) ? Number(nextId) : 1,
    scope: normalizedScope,
    entries: [toolEntry],
    expanded: false,
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

function splitStreamingLogChunk(buffer = "", chunk = "", options = {}) {
  const previous = String(buffer || "");
  const text = String(chunk || "");
  const combined = `${previous}${text}`;
  const parts = combined.split(/\r?\n/);
  const lines = parts.slice(0, -1);
  const dropLeadingBlank = Boolean(options.dropLeadingBlank) && previous === "";

  if (dropLeadingBlank) {
    while (lines.length > 0 && lines[0] === "") {
      lines.shift();
    }
  }

  return {
    lines,
    buffer: parts[parts.length - 1] || "",
    sawVisible: /[^\s]/.test(text),
  };
}

// Composed live-row text for an in-flight tool group: shows the merged
// summary, plus a "(Ctrl+O expand)" hint once at least two entries are
// present.
function buildToolMergeRowText(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const summary = buildMergedToolSummaryText(list);
  if (list.length >= 2) return `· ${summary} (Ctrl+O expand)`;
  return `· ${summary}`;
}

/**
 * Lay out the global-mode project rail inside a single line. Like
 * planAgentsFooter, but with two differences:
 *   - the caller provides `windowStart` so the rail can scroll horizontally
 *     under cursor control rather than dropping items at the end;
 *   - we normally avoid truncating individual labels, but the selected
 *     project is always represented by at least one visible chip.
 *
 * Returns { items, windowStart, leftMore, rightMore } where items is the
 * sub-array of `labels` that fits and windowStart is the (possibly
 * adjusted) starting index after clamping for the selection cursor.
 */
function planProjectsRail({
  labels = [],
  selectedIndex = -1,
  windowStart = 0,
  maxCells = 80,
} = {}) {
  const items = Array.isArray(labels) ? labels.map(String) : [];
  if (items.length === 0) {
    return { items: [], windowStart: 0, leftMore: false, rightMore: false };
  }
  const budget = Math.max(1, Math.floor(Number(maxCells) || 0));
  const sepWidth = displayCellWidth("  ");
  const moreLeft = "< ";
  const moreRight = " >";
  const moreLeftWidth = displayCellWidth(moreLeft);
  const moreRightWidth = displayCellWidth(moreRight);
  const overflowMarker = "...";

  const truncateToCells = (label = "", cells = 1) => {
    const limit = Math.max(1, Math.floor(Number(cells) || 0));
    const text = String(label || "");
    if (displayCellWidth(text) <= limit) return text;
    const markerWidth = displayCellWidth(overflowMarker);
    if (limit <= markerWidth) return overflowMarker.slice(0, limit);
    let out = "";
    let used = 0;
    const bodyLimit = limit - markerWidth;
    for (const ch of text) {
      const width = displayCellWidth(ch);
      if (used + width > bodyLimit) break;
      out += ch;
      used += width;
    }
    return `${out || text.slice(0, 1)}${overflowMarker}`;
  };

  // Clamp the requested windowStart so the cursor is visible.
  let start = Math.max(0, Math.min(items.length - 1, Math.floor(Number(windowStart) || 0)));
  if (selectedIndex >= 0 && selectedIndex < items.length && selectedIndex < start) {
    start = selectedIndex;
  }

  // Greedy fit forward from `start`, reserving room for the < and > arrows
  // when we can't fit everything.
  const tryFit = (s) => {
    const out = [];
    let used = 0;
    for (let i = s; i < items.length; i += 1) {
      const label = items[i];
      const labelWidth = displayCellWidth(label);
      const lead = out.length === 0 ? 0 : sepWidth;
      const reserveLeft = s > 0 ? moreLeftWidth : 0;
      const reserveRight = i < items.length - 1 ? moreRightWidth : 0;
      if (used + lead + labelWidth + reserveLeft + reserveRight > budget) break;
      out.push({ index: i, label });
      used += lead + labelWidth;
    }
    return out;
  };

  let visible = tryFit(start);
  // If the selected index would fall past the end of the visible window,
  // slide forward until it's covered.
  if (selectedIndex >= 0) {
    while (visible.length > 0 && visible[visible.length - 1].index < selectedIndex && start < items.length - 1) {
      start += 1;
      visible = tryFit(start);
    }
  }
  // Never let the window slide so far that the selection drops off.
  if (selectedIndex >= 0 && visible.length > 0 && visible[0].index > selectedIndex) {
    start = selectedIndex;
    visible = tryFit(start);
  }

  if (visible.length === 0) {
    const fallbackIndex = selectedIndex >= 0 && selectedIndex < items.length ? selectedIndex : start;
    start = fallbackIndex;
    const reserveLeft = start > 0 ? moreLeftWidth : 0;
    const reserveRight = fallbackIndex < items.length - 1 ? moreRightWidth : 0;
    const labelBudget = Math.max(1, budget - reserveLeft - reserveRight);
    visible = [{
      index: fallbackIndex,
      label: truncateToCells(items[fallbackIndex], labelBudget),
    }];
  }

  return {
    items: visible.map((v) => ({ label: v.label, absoluteIndex: v.index })),
    windowStart: start,
    leftMore: start > 0,
    rightMore: visible.length > 0 && visible[visible.length - 1].index < items.length - 1,
  };
}

/**
 * Lay out the Agents footer inside a fixed cell budget. Returns:
 *   { items: [{ label, selected, truncated }], overflowed, hint }
 *
 * `hint` is the rendered "+N more" suffix (or "" when nothing was dropped),
 * already including its leading separator. Callers should render
 * items[0..n-1] separated by "  " then append hint with no extra spacing.
 *
 * The planner reserves room for the worst-case hint width up front so the
 * trailing label never has to be removed once we decide to print "+N more".
 *
 * `labels` is the array of strings to render (already prefixed with "@").
 * `selectedIndex` is the agent under the selection cursor (or -1).
 * `maxCells` is the total visual width available for the agent strip,
 * separators included.
 */
function planAgentsFooter(labels = [], selectedIndex = -1, maxCells = 80) {
  const items = Array.isArray(labels) ? labels.map(String) : [];
  const budget = Math.max(1, Math.floor(Number(maxCells) || 0));
  const sepText = " ";
  const sepWidth = displayCellWidth(sepText);
  const overflowMarker = "...";
  const overflowMarkerWidth = displayCellWidth(overflowMarker);

  // Reserve worst-case "+N more" width once, where N can be at most
  // labels.length. We treat this as a hard upper bound so we never have
  // to backtrack and pop a label after committing to it.
  const worstCaseHint = items.length > 0
    ? ` +${items.length} more`
    : "";
  const worstCaseHintWidth = displayCellWidth(worstCaseHint);

  const out = [];
  let used = 0;
  let firstOverflowAt = -1;

  for (let i = 0; i < items.length; i += 1) {
    const label = items[i];
    const labelWidth = displayCellWidth(label);
    const lead = out.length === 0 ? 0 : sepWidth;
    const remainingItems = items.length - i - 1;
    // Always keep room for the hint when there's at least one item that
    // might not fit later. When this is the last label, the hint is empty
    // so no reservation is needed.
    const reserveHint = remainingItems > 0 ? worstCaseHintWidth : 0;

    if (used + lead + labelWidth + reserveHint <= budget) {
      out.push({ label, selected: i === selectedIndex, truncated: false });
      used += lead + labelWidth;
      continue;
    }

    // Try to fit a truncated version: room for "..." + at least 1 cell.
    const reserveForCurrent = remainingItems > 0 ? worstCaseHintWidth : 0;
    const remaining = budget - used - lead - overflowMarkerWidth - reserveForCurrent;
    if (remaining > 0) {
      let acc = "";
      let accWidth = 0;
      for (const ch of label) {
        const w = displayCellWidth(ch);
        if (accWidth + w > remaining) break;
        acc += ch;
        accWidth += w;
      }
      if (acc) {
        out.push({
          label: `${acc}${overflowMarker}`,
          selected: i === selectedIndex,
          truncated: true,
        });
        used += lead + accWidth + overflowMarkerWidth;
        firstOverflowAt = i + 1;
        break;
      }
    }
    firstOverflowAt = i;
    break;
  }

  const overflowed = firstOverflowAt < 0 ? 0 : items.length - firstOverflowAt;
  const hint = overflowed > 0 ? ` +${overflowed} more` : "";
  return { items: out, overflowed, hint };
}

/**
 * Build a list of inline-completion suggestions for the current input.
 * Returns at most `limit` items; an empty list means "no popup".
 *
 * Triggers:
 *   "/<prefix>"             top-level slash commands matching <prefix>
 *   "/<cmd> <prefix>"       sub-commands of <cmd> matching <prefix>
 *   "/<cmd> <sub> <prefix>" sub-sub-commands (e.g. /settings agent set)
 *   "@<prefix>"             known agent ids/labels matching <prefix>
 * Anything else returns no suggestions.
 */
function buildCompletions({
  text = "",
  agents = [],
  agentLabels = [],
  commands = [],
  commandTree = null,
  groupTemplates = [],
  soloProfiles = [],
  limit = 8,
} = {}) {
  const raw = String(text || "");
  if (!raw) return [];
  const trimmed = raw.trimStart();
  const endsWithWhitespace = /\s$/.test(trimmed);

  if (trimmed.startsWith("/")) {
    const parts = trimmed.split(/\s+/);
    const head = parts[0]; // "/launch"
    const tail = parts.slice(1);

    // Dynamic argument completion for /group run <alias> and
    // /solo run <profile>. These pull from runtime sources (group
    // templates, prompt-profile registry) rather than COMMAND_TREE.
    const dynList = (head === "/group" && tail[0] === "run")
      ? groupTemplates
      : (head === "/solo" && tail[0] === "run")
          ? soloProfiles
          : null;
    if (dynList && (tail.length >= 2 || trimmed.endsWith(" "))) {
      const partial = String(tail[1] || "").toLowerCase();
      const out = [];
      for (const item of (Array.isArray(dynList) ? dynList : [])) {
        const id = String((item && (item.alias || item.cmd || item.id || item.name)) || "");
        if (!id) continue;
        if (partial && !id.toLowerCase().startsWith(partial)) continue;
        const desc = String((item && (item.desc || item.summary || item.description || item.source)) || "");
        out.push({
          kind: "argument",
          label: `${head} ${tail[0]} ${id}`,
          replace: `${head} ${tail[0]} ${id} `,
          description: desc,
          hasChildren: false,
        });
        if (out.length >= limit) break;
      }
      if (partial && out.length === 1) {
        const candidate = String(out[0].replace || "").trim().split(/\s+/).pop() || "";
        if (candidate.toLowerCase() === partial && !out[0].hasChildren) return [];
      }
      return out;
    }

    // Sub-command completion: "/cmd <prefix>" or "/cmd sub <prefix>".
    if (tail.length >= 1 && commandTree) {
      const headKey = head.startsWith("/") ? head : `/${head}`;
      let node = commandTree[headKey];
      if (!node || typeof node !== "object") return [];
      // Walk into nested children for everything but the last token.
      for (let i = 0; i < tail.length - 1; i += 1) {
        const segment = tail[i];
        if (!segment) return [];
        const next = node && node.children && node.children[segment];
        if (!next) return [];
        node = next;
      }
      const children = node && node.children;
      if (!children || typeof children !== "object") return [];
      const partial = String(tail[tail.length - 1] || "").toLowerCase();
      const prefixSoFar = `${head} ${tail.slice(0, -1).join(" ")}`.replace(/\s+$/, "");
      // Sort by `order` (when present) then alphabetically — matches the
      // sortCommands helper used by the blessed completion popup.
      const entries = Object.keys(children).map((name) => ({
        name,
        ...children[name],
      }));
      entries.sort((a, b) => {
        const orderA = Number.isFinite(a.order) ? a.order : 999;
        const orderB = Number.isFinite(b.order) ? b.order : 999;
        if (orderA !== orderB) return orderA - orderB;
        return a.name.localeCompare(b.name);
      });
      const out = [];
      for (const entry of entries) {
        if (!entry.name.toLowerCase().startsWith(partial)) continue;
        const hasDynamicArguments = (head === "/group" && entry.name === "run")
          || (head === "/solo" && entry.name === "run");
        out.push({
          kind: "subcommand",
          label: `${prefixSoFar} ${entry.name}`.trim(),
          replace: `${prefixSoFar} ${entry.name} `.replace(/^\s+/, ""),
          description: String(entry.desc || entry.summary || entry.description || ""),
          hasChildren: Boolean((entry.children && typeof entry.children === "object") || hasDynamicArguments),
        });
        if (out.length >= limit) break;
      }
      if (!endsWithWhitespace && out.length === 1) {
        const candidate = String(out[0].replace || "").trim().split(/\s+/).pop() || "";
        if (candidate.toLowerCase() === partial && !out[0].hasChildren) return [];
      }
      return out;
    }

    // Top-level command completion.
    const after = trimmed.slice(1);
    const prefix = after.toLowerCase();
    const list = Array.isArray(commands) ? commands : [];
    const out = [];
    for (const item of list) {
      // Registry entries already include the leading '/' in `cmd`. Strip
      // it before matching the user's prefix and put it back when we
      // render so we don't end up with '//cron'.
      const rawName = String((item && item.cmd) || item || "");
      const bare = rawName.startsWith("/") ? rawName.slice(1) : rawName;
      const lower = bare.toLowerCase();
      if (!bare) continue;
      if (!lower.startsWith(prefix)) continue;
      out.push({
        kind: "command",
        label: `/${bare}`,
        replace: `/${bare} `,
        description: String((item && (item.desc || item.summary || item.description)) || ""),
        hasChildren: Boolean(commandTree && commandTree[`/${bare}`] && commandTree[`/${bare}`].children),
      });
      if (out.length >= limit) break;
    }
    if (!endsWithWhitespace && out.length === 1) {
      const candidate = String(out[0].replace || "").trim().replace(/^\//, "").toLowerCase();
      if (candidate === prefix && !out[0].hasChildren) return [];
    }
    return out;
  }

  if (trimmed.startsWith("@")) {
    const after = trimmed.slice(1);
    if (after.includes(" ")) return [];
    const prefix = after.toLowerCase();
    const idList = Array.isArray(agents) ? agents : [];
    const labelList = Array.isArray(agentLabels) ? agentLabels : [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < idList.length; i += 1) {
      const id = String(idList[i] || "");
      const label = String((labelList[i] != null ? labelList[i] : id) || "");
      if (!id) continue;
      if (seen.has(id)) continue;
      const idMatch = id.toLowerCase().startsWith(prefix);
      const labelMatch = label.toLowerCase().startsWith(prefix);
      if (!idMatch && !labelMatch) continue;
      seen.add(id);
      out.push({
        kind: "agent",
        label: `@${label}`,
        replace: `@${label} `,
        description: id !== label ? id : "",
      });
      if (out.length >= limit) break;
    }
    if (out.length === 1) {
      const candidate = String(out[0].label || "").replace(/^@/, "").toLowerCase();
      if (candidate === prefix) return [];
    }
    return out;
  }

  return [];
}

module.exports = {
  ANSI_PATTERN,
  STATUS_INDICATORS,
  StreamBuffer,
  TOOL_LABELS,
  UCODE_BANNER_LINES,
  UCODE_VERSION,
  appendToolMergeEntry,
  buildMergedToolExpandedLines,
  buildMergedToolSummaryText,
  buildToolMergeRowText,
  buildCompletions,
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
  planAgentsFooter,
  planProjectsRail,
  renderLogLinesWithMarkdown,
  resolveAgentSelectionOnDown,
  resolveHistoryDownTransition,
  shouldClearAgentSelectionOnUp,
  shouldEnterAgentSelection,
  shouldUseUcodeTui,
  splitStreamingLogChunk,
  stripLeakedEscapeTags,
};

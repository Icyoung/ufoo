const chalk = require("chalk");
const pkg = require("../../package.json");

const UCODE_BANNER_LINES = [
  "█ █ █▀▀ █▀█ █▀▄ █▀▀",
  "█ █ █   █ █ █ █ █▀ ",
  "▀▀▀ ▀▀▀ ▀▀▀ ▀▀  ▀▀▀",
];

const UCODE_VERSION = String((pkg && pkg.version) || "dev");

// Status indicators
const STATUS_INDICATORS = {
  thinking: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  typing: ["◐", "◓", "◑", "◒"],
  waiting: ["∙", "∙∙", "∙∙∙", "∙∙", "∙"],
};

const ANSI_PATTERN = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

// Stream buffer for smooth output
class StreamBuffer {
  constructor(writer, options = {}) {
    this.writer = writer;
    this.buffer = "";
    this.delay = options.delay || 8; // ms between chunks
    this.chunkSize = options.chunkSize || 3; // chars per chunk
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
        await new Promise(resolve => setTimeout(resolve, this.delay));
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
  void engine; // Not using engine anymore
  void nickname;
  void agentId;

  // Get current working directory with ~ for home
  const path = require("path");
  const os = require("os");
  const currentDir = workspaceRoot || process.cwd();
  const homeDir = os.homedir();

  // Replace home directory with ~
  let shortPath = currentDir;
  if (currentDir.startsWith(homeDir)) {
    shortPath = currentDir.replace(homeDir, "~");
  }

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

function escapeBlessedLiteral(text) {
  const raw = String(text == null ? "" : text);
  const safe = raw.replace(/\{\/escape\}/g, "{open}/escape{close}");
  return `{escape}${safe}{/escape}`;
}

function buildUcodeBannerBlessedLines({
  model = "",
  engine = "ufoo-core",
  nickname = "",
  agentId = "",
  workspaceRoot = "",
  sessionId = "",
  width = 0,
} = {}) {
  const modelLabel = normalizeModelLabel(model);
  void width;
  void engine; // Not using engine anymore
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

  const logoLines = UCODE_BANNER_LINES.map(
    (line) => `{cyan-fg}${escapeBlessedLiteral(line)}{/cyan-fg}`
  );
  const infoLines = [
    `{gray-fg}Version:{/gray-fg} {cyan-fg}{bold}${escapeBlessedLiteral(UCODE_VERSION)}{/bold}{/cyan-fg}`,
    `{gray-fg}Model:{/gray-fg} {yellow-fg}${escapeBlessedLiteral(modelLabel)}{/yellow-fg}`,
    `{gray-fg}Dictionary:{/gray-fg} {gray-fg}${escapeBlessedLiteral(shortPath)}{/gray-fg}`,
  ];
  const normalizedSessionId = String(sessionId || "").trim();
  if (normalizedSessionId) {
    infoLines.push(`{gray-fg}Session:{/gray-fg} {gray-fg}${escapeBlessedLiteral(normalizedSessionId)}{/gray-fg}`);
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

// Helper function to load agents from bus
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

    // Next heading means we have left the online agents section
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

  // Fallback for legacy output: "type:id (active|idle)"
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
  const renderState = state && typeof state === "object" ? state : {};
  if (typeof renderState.inCodeBlock !== "boolean") {
    renderState.inCodeBlock = false;
  }

  const renderInlineCode = (input = "") => {
    const source = String(input || "");
    if (!source) return "";
    if (!source.includes("`")) return escapeFn(source);

    let out = "";
    let cursor = 0;
    const pattern = /`([^`\n]+)`/g;
    let match = pattern.exec(source);
    while (match) {
      const index = Number(match.index) || 0;
      if (index > cursor) {
        out += escapeFn(source.slice(cursor, index));
      }
      out += `{yellow-fg}${escapeFn(match[1])}{/yellow-fg}`;
      cursor = index + match[0].length;
      match = pattern.exec(source);
    }
    if (cursor < source.length) {
      out += escapeFn(source.slice(cursor));
    }
    return out;
  };

  const lines = String(text || "").split(/\r?\n/);
  const out = [];

  for (const line of lines) {
    const raw = stripLeakedEscapeTags(String(line || ""));
    const fenceMatch = raw.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      if (!renderState.inCodeBlock) {
        const language = String(fenceMatch[3] || "").trim();
        const label = language
          ? `┌ code:${escapeFn(language)}`
          : "┌ code";
        out.push(`{gray-fg}${label}{/gray-fg}`);
        renderState.inCodeBlock = true;
      } else {
        out.push("{gray-fg}└{/gray-fg}");
        renderState.inCodeBlock = false;
      }
      continue;
    }

    if (renderState.inCodeBlock) {
      out.push(`{gray-fg}│{/gray-fg} {white-fg}${escapeFn(raw)}{/white-fg}`);
    } else {
      const headingMatch = raw.match(/^(\s*)(#{1,6})\s+(.*)$/);
      if (headingMatch) {
        const indent = escapeFn(headingMatch[1] || "");
        const marks = escapeFn(headingMatch[2] || "");
        const content = renderInlineCode(headingMatch[3] || "");
        out.push(`${indent}{cyan-fg}${marks}{/cyan-fg} {bold}${content}{/bold}`);
        continue;
      }

      const quoteMatch = raw.match(/^(\s*)>\s?(.*)$/);
      if (quoteMatch) {
        const indent = escapeFn(quoteMatch[1] || "");
        const content = renderInlineCode(quoteMatch[2] || "");
        out.push(`${indent}{gray-fg}▍{/gray-fg} ${content}`);
        continue;
      }

      const bulletMatch = raw.match(/^(\s*)([-*+])\s+(.*)$/);
      if (bulletMatch) {
        const indent = escapeFn(bulletMatch[1] || "");
        const content = renderInlineCode(bulletMatch[3] || "");
        out.push(`${indent}{gray-fg}•{/gray-fg} ${content}`);
        continue;
      }

      const orderedMatch = raw.match(/^(\s*)(\d+)\.\s+(.*)$/);
      if (orderedMatch) {
        const indent = escapeFn(orderedMatch[1] || "");
        const order = escapeFn(orderedMatch[2] || "");
        const content = renderInlineCode(orderedMatch[3] || "");
        out.push(`${indent}{gray-fg}${order}.{/gray-fg} ${content}`);
        continue;
      }

      const errorMatch = raw.match(/^(\s*)(Error:\s+.*)$/i);
      if (errorMatch) {
        const indent = escapeFn(errorMatch[1] || "");
        const content = renderInlineCode(errorMatch[2] || "");
        out.push(`${indent}{red-fg}${content}{/red-fg}`);
        continue;
      }

      out.push(renderInlineCode(raw));
    }
  }

  return out;
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
      // carry only stores trailing prefixes of escape tags; do not emit it
      // to avoid leaking partial markers like "{/escape" at stream end.
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
  const maxLength = 120; // Max length for expanded lines
  return list.map((item, index) => {
    const base = item.summary;
    let line;
    if (!item.isError) {
      line = base;
    } else {
      line = item.errorText ? `${base} · error: ${item.errorText}` : `${base} · error`;
    }
    // Truncate long lines
    if (line.length > maxLength) {
      return line.slice(0, maxLength - 3) + "...";
    }
    return line;
  });
}

function runUcodeTui({
  stdin = process.stdin,
  stdout = process.stdout,
  runSingleCommand = () => ({ kind: "empty" }),
  runNaturalLanguageTask = async () => ({ ok: true, summary: "ok" }),
  runUbusCommand = async () => ({ ok: false, error: "ubus unsupported", summary: "" }),
  formatNlResult = () => "ok",
  workspaceRoot = process.cwd(),
  state = {},
  resumeSessionState = () => ({ ok: false, error: "resume unsupported", sessionId: "", restoredMessages: 0 }),
  persistSessionState = () => ({ ok: true }),
  autoBus = {},
} = {}) {
  return new Promise((resolve) => {
    const blessed = require("blessed");
    const { execSync } = require("child_process");
    const { createChatLayout } = require("../chat/layout");
    const { computeDashboardContent } = require("../chat/dashboardView");
    const { escapeBlessed, stripBlessedTags } = require("../chat/text");
    const currentSubscriberId = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
    const autoBusEnabled = Boolean(autoBus && autoBus.enabled);
    const autoBusSubscriberId = String((autoBus && autoBus.subscriberId) || currentSubscriberId || "").trim();
    const getAutoBusPendingCount = typeof (autoBus && autoBus.getPendingCount) === "function"
      ? autoBus.getPendingCount
      : () => 0;

    let closing = false;
    let chain = Promise.resolve();
    let statusInterval = null;
    let statusIndex = 0;
    let activeAgents = [];
    let activeAgentMetaMap = new Map();
    let targetAgent = null;
    let selectedAgentIndex = -1;
    let agentListWindowStart = 0;
    let agentSelectionMode = false;
    let pendingTask = null;
    const logRenderState = { inCodeBlock: false };
    const inputHistory = [];
    let historyIndex = -1;
    let activeToolMerge = null;
    let lastMergedToolGroup = null;
    let toolMergeId = 0;
    let cursorPos = 0;
    let autoBusTimer = null;
    let autoBusQueued = false;
    let autoBusError = "";
    const inputMath = require("../chat/inputMath");

    const {
      screen,
      logBox,
      statusLine,
      completionPanel,
      dashboard,
      promptBox,
      input,
    } = createChatLayout({
      blessed,
      currentInputHeight: 4,
      version: UCODE_VERSION,
    });

    if (completionPanel && typeof completionPanel.hide === "function") {
      completionPanel.hide();
    }

    const getAgentTag = (agent) => {
      if (!agent) return "";
      if (agent.id) return `${agent.type}:${agent.id.slice(0, 6)}`;
      return agent.type;
    };

    const getAgentLabel = (id) => {
      const meta = activeAgentMetaMap.get(id);
      if (!meta) return id;
      if (meta.nickname) return meta.nickname;
      return getAgentTag(meta);
    };

    const refreshAgents = () => {
      const list = filterSelectableAgents(
        loadActiveAgents(workspaceRoot),
        currentSubscriberId
      );
      activeAgents = list.map((agent) => agent.fullId);
      activeAgentMetaMap = new Map(list.map((agent) => [agent.fullId, agent]));
      if (targetAgent && !activeAgentMetaMap.has(targetAgent)) {
        targetAgent = null;
      }
      selectedAgentIndex = targetAgent ? activeAgents.indexOf(targetAgent) : -1;
    };

    const setPrompt = () => {
      const content = targetAgent ? `>@${getAgentLabel(targetAgent)}` : ">";
      promptBox.setContent(content);
      const plain = stripBlessedTags(content);
      promptBox.width = Math.max(2, plain.length + 1);
      input.left = promptBox.width;
      input.width = `100%-${promptBox.width}`;
    };

    // --- Cursor position helpers (mirrors chat inputListenerController) ---
    const getInnerWidth = () => {
      const promptWidth = typeof promptBox.width === "number" ? promptBox.width : 2;
      return inputMath.getInnerWidth({ input, screen, promptWidth });
    };

    const getWrapWidth = () => inputMath.getWrapWidth(input, getInnerWidth());

    const ensureInputCursorVisible = () => {
      const innerWidth = getInnerWidth();
      if (innerWidth <= 0) return;
      const totalRows = inputMath.countLines(input.value || "", innerWidth, (v) => input.strWidth(v));
      const visibleRows = Math.max(1, input.height || 1);
      const { row } = inputMath.getCursorRowCol(input.value || "", cursorPos, innerWidth, (v) => input.strWidth(v));
      let base = input.childBase || 0;
      const maxBase = Math.max(0, totalRows - visibleRows);
      if (row < base) base = row;
      else if (row >= base + visibleRows) base = row - visibleRows + 1;
      if (base > maxBase) base = maxBase;
      if (base < 0) base = 0;
      if (base !== input.childBase) {
        input.childBase = base;
        if (typeof input.scrollTo === "function") input.scrollTo(base);
      }
    };

    // Override _updateCursor to use our tracked cursorPos
    input._updateCursor = function () {
      if (this.screen.focused !== this) return;
      let lpos;
      try { lpos = this._getCoords(); } catch { return; }
      if (!lpos) return;
      const innerWidth = getWrapWidth();
      if (innerWidth <= 0) return;
      ensureInputCursorVisible();
      const { row, col } = inputMath.getCursorRowCol(this.value || "", cursorPos, innerWidth, (v) => this.strWidth(v));
      const scrollOffset = this.childBase || 0;
      const displayRow = row - scrollOffset;
      const safeCol = Math.min(Math.max(0, col), innerWidth - 1);
      const cy = lpos.yi + displayRow;
      const cx = lpos.xi + safeCol;
      this.screen.program.cup(cy, cx);
      this.screen.program.showCursor();
    };

    // Override _listener to support cursor-aware editing
    const origDone = input._done ? input._done.bind(input) : null;
    input._listener = function (ch, key) {
      const keyName = key && key.name;

      // Let enter/return/escape pass through to blessed key handlers
      if (keyName === "return" || keyName === "enter" || keyName === "escape") return;

      // Arrow keys handled by input.key() handlers below
      if (keyName === "left" || keyName === "right" || keyName === "up" || keyName === "down") return;

      if (keyName === "backspace") {
        if (cursorPos > 0 && this.value) {
          this.value = this.value.slice(0, cursorPos - 1) + this.value.slice(cursorPos);
          cursorPos -= 1;
          ensureInputCursorVisible();
          this._updateCursor();
          this.screen.render();
        }
        return;
      }

      if (keyName === "delete") {
        if (this.value && cursorPos < this.value.length) {
          this.value = this.value.slice(0, cursorPos) + this.value.slice(cursorPos + 1);
          ensureInputCursorVisible();
          this._updateCursor();
          this.screen.render();
        }
        return;
      }

      if (keyName === "home") {
        cursorPos = 0;
        ensureInputCursorVisible();
        this._updateCursor();
        this.screen.render();
        return;
      }

      if (keyName === "end") {
        cursorPos = (this.value || "").length;
        ensureInputCursorVisible();
        this._updateCursor();
        this.screen.render();
        return;
      }

      // Normal character insertion at cursor position
      const insertChar = (ch && ch.length === 1) ? ch : (keyName && keyName.length === 1 ? keyName : null);
      if (insertChar && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(insertChar)) {
        this.value = (this.value || "").slice(0, cursorPos) + insertChar + (this.value || "").slice(cursorPos);
        cursorPos += 1;
        ensureInputCursorVisible();
        this._updateCursor();
        this.screen.render();
      }
    };

    // Helper to set input value and reset cursor to end
    const setInputValue = (value) => {
      input.setValue(value || "");
      cursorPos = (value || "").length;
      ensureInputCursorVisible();
      input._updateCursor();
      screen.render();
    };

    const renderDashboard = () => {
      let hint = "No target agents";
      if (activeAgents.length > 0) {
        if (targetAgent) {
          hint = `↓ select ${getAgentLabel(targetAgent)} · ←/→ switch · ↑ clear`;
        } else {
          hint = "↓ select target · ←/→ switch";
        }
      }
      const computed = computeDashboardContent({
        focusMode: "dashboard",
        dashboardView: "agents",
        activeAgents,
        selectedAgentIndex,
        agentListWindowStart,
        maxAgentWindow: 4,
        getAgentLabel,
        dashHints: { agents: hint, agentsEmpty: hint },
      });
      agentListWindowStart = computed.windowStart;
      dashboard.setContent(computed.content);
      screen.render();
    };

    const logText = (text = "") => {
      activeToolMerge = null;
      firstToolInGroup = true; // Reset tool group flag when switching back to text
      const sanitized = stripLeakedEscapeTags(text);
      const lines = renderLogLinesWithMarkdown(
        sanitized,
        logRenderState,
        escapeBlessed
      );
      for (const line of lines) {
        logBox.log(line);
      }
      screen.render();
    };

    const logUserInput = (text = "") => {
      activeToolMerge = null;
      const plain = String(text || "").trim();
      if (!plain) return;
      const content = ` → ${escapeBlessed(plain)} `;
      const visibleLen = plain.length + 4; // " → " + text + " "
      const boxWidth = (logBox.width || 80) - 2; // subtract border/padding
      const pad = boxWidth > visibleLen ? " ".repeat(boxWidth - visibleLen) : "";
      logBox.log(`{cyan-bg}{white-fg}${content}${pad}{/white-fg}{/cyan-bg}`);
      logBox.log(""); // Add line break after user input
      screen.render();
    };

    const logControlAction = (text = "") => {
      activeToolMerge = null;
      const plain = String(text || "").trim();
      if (!plain) return;
      logBox.log(`{gray-fg}⚙{/gray-fg} ${escapeBlessed(plain)}`);
      screen.render();
    };

    const summarizeToolDetail = (tool = "", args = {}, payload = {}) => {
      const toolName = String(tool || "").trim().toLowerCase();
      const argObj = args && typeof args === "object" ? args : {};
      const resObj = payload && typeof payload === "object" ? payload : {};

      if (toolName === "read") {
        const target = String(resObj.path || argObj.path || argObj.file || "").trim();
        const lineInfo = Number.isFinite(resObj.totalLines) ? `${resObj.totalLines} lines` : "";
        return [target, lineInfo].filter(Boolean).join(" · ");
      }
      if (toolName === "write") {
        const target = String(resObj.path || argObj.path || argObj.file || "").trim();
        const mode = String(resObj.mode || argObj.mode || (argObj.append ? "append" : "overwrite")).trim();
        const bytes = Number.isFinite(resObj.bytes) ? `${resObj.bytes} bytes` : "";
        return [target, mode, bytes].filter(Boolean).join(" · ");
      }
      if (toolName === "edit") {
        const target = String(resObj.path || argObj.path || argObj.file || "").trim();
        const replacements = Number.isFinite(resObj.replacements) ? `${resObj.replacements} replacements` : "";
        return [target, replacements].filter(Boolean).join(" · ");
      }
      if (toolName === "bash") {
        return normalizeBashToolCommand(argObj, resObj);
      }
      return "";
    };

    const truncateText = (text = "", maxLength = 80) => {
      const str = String(text || "");
      if (str.length <= maxLength) return str;
      return str.slice(0, maxLength - 3) + "...";
    };

    const renderSingleToolEntryLine = (entry = {}) => {
      const item = normalizeToolMergeEntry(entry);
      const marker = item.isError ? "{red-fg}•{/red-fg}" : "{cyan-fg}•{/cyan-fg}";
      const summary = buildMergedToolSummaryText([item]);
      const truncated = truncateText(summary, 100);
      return `${marker} ${escapeBlessed(truncated)}`;
    };

    const renderCollapsedToolMergeLine = (entries = []) => {
      const summary = buildMergedToolSummaryText(entries);
      const hasError = entries.some((item) => normalizeToolMergeEntry(item).isError);
      const marker = hasError ? "{red-fg}•{/red-fg}" : "{cyan-fg}•{/cyan-fg}";
      return `${marker} ${escapeBlessed(summary)} {gray-fg}(Ctrl+O expand){/gray-fg}`;
    };

    let firstToolInGroup = true;

    const logToolHint = (entry = {}, payload = {}) => {
      const tool = String(entry.tool || "").trim().toLowerCase();
      if (!tool) return;
      const resObj = payload && typeof payload === "object" ? payload : {};
      const isError = String(entry.phase || "").trim().toLowerCase() === "error" || resObj.ok === false;
      const detail = summarizeToolDetail(tool, entry.args, resObj);
      const errorText = String(entry.error || resObj.error || "").trim();

      const toolEntry = normalizeToolMergeEntry({
        tool,
        detail,
        isError,
        errorText,
      });

      if (activeToolMerge) {
        activeToolMerge.entries.push(toolEntry);
        // Only show collapsed format for 2+ tool calls
        if (activeToolMerge.entries.length === 2) {
          // Convert first single line to collapsed format
          logBox.setLine(activeToolMerge.lineIndex, renderCollapsedToolMergeLine(activeToolMerge.entries));
        } else if (activeToolMerge.entries.length > 2) {
          logBox.setLine(activeToolMerge.lineIndex, renderCollapsedToolMergeLine(activeToolMerge.entries));
        }
        if (activeToolMerge.entries.length > 1) {
          lastMergedToolGroup = activeToolMerge;
        }
      } else {
        // Add line break before first tool call
        if (firstToolInGroup) {
          logBox.log("");
          firstToolInGroup = false;
        }
        logBox.log(renderSingleToolEntryLine(toolEntry));
        activeToolMerge = {
          id: ++toolMergeId,
          lineIndex: logBox.getLines().length - 1,
          entries: [toolEntry],
          expanded: false,
        };
      }
      screen.render();
    };

    const renderSingleMarkdownLine = (rawLine = "", options = {}) => {
      const preview = Boolean(options.preview);
      const renderState = preview
        ? { inCodeBlock: Boolean(logRenderState.inCodeBlock) }
        : logRenderState;
      const rendered = renderLogLinesWithMarkdown(rawLine, renderState, escapeBlessed);
      return rendered[0] || "";
    };

    const createNlStreamState = () => {
      activeToolMerge = null;
      firstToolInGroup = true; // Reset flag for new response
      logBox.log(""); // Add empty line to start the response
      return {
        lineIndex: logBox.getLines().length - 1,
        buffer: "",
        full: "",
        seenVisibleContent: false,
      };
    };

    const appendNlStreamDelta = (streamState, delta) => {
      if (!streamState) return;
      const chunk = stripLeakedEscapeTags(String(delta || ""));
      if (!chunk) return;

      streamState.full += chunk;
      streamState.buffer += chunk;

      const parts = streamState.buffer.split("\n");
      if (parts.length > 1) {
        const completed = parts.slice(0, -1);
        for (const line of completed) {
          const hasVisible = /[^\s]/.test(line);
          if (!streamState.seenVisibleContent && !hasVisible) {
            continue;
          }
          if (hasVisible) {
            streamState.seenVisibleContent = true;
          }
          const rendered = renderSingleMarkdownLine(line);
          logBox.setLine(streamState.lineIndex, rendered);
          logBox.pushLine("");
          streamState.lineIndex = logBox.getLines().length - 1;
        }
        streamState.buffer = parts[parts.length - 1];
      }

      const previewHasVisible = /[^\s]/.test(streamState.buffer);
      if (!streamState.seenVisibleContent && !previewHasVisible) {
        return;
      }
      if (previewHasVisible) {
        streamState.seenVisibleContent = true;
      }
      const previewLine = renderSingleMarkdownLine(streamState.buffer, { preview: true });
      logBox.setLine(streamState.lineIndex, previewLine);
      screen.render();
    };

    const finalizeNlStream = (streamState) => {
      if (!streamState) return { lastChar: "" };
      streamState.buffer = stripLeakedEscapeTags(streamState.buffer);
      const rendered = renderSingleMarkdownLine(streamState.buffer);
      logBox.setLine(streamState.lineIndex, rendered);
      screen.render();
      const full = String(streamState.full || "");
      return { lastChar: full ? full.charAt(full.length - 1) : "" };
    };

    const updateStatus = (message = "", type = "thinking", options = {}) => {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      if (!message) {
        statusLine.setContent("{bold}UCODE{/bold} · Ready");
        screen.render();
        return;
      }
      const showTimer = Boolean(options.showTimer);
      const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now();
      const indicators = STATUS_INDICATORS[type] || STATUS_INDICATORS.thinking;
      statusIndex = 0;
      const draw = () => {
        const indicator = indicators[statusIndex % indicators.length];
        const timerText = showTimer
          ? ` (${formatPendingElapsed(Date.now() - startedAt)}，esc cancel)`
          : "";
        statusLine.setContent(escapeBlessed(`${indicator} ${message}${timerText}`));
        statusIndex += 1;
        screen.render();
      };
      draw();
      if (type !== "none") {
        statusInterval = setInterval(draw, 100);
      }
    };

    const closeWithCode = (code = 0) => {
      if (closing) return;
      closing = true;
      if (autoBusTimer) {
        clearInterval(autoBusTimer);
        autoBusTimer = null;
      }
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
      }
      if (pendingTask && pendingTask.abortController && !pendingTask.abortController.signal.aborted) {
        try {
          pendingTask.abortController.abort();
        } catch {
          // ignore
        }
      }
      try {
        screen.destroy();
      } catch {
        // ignore
      }
      resolve({ code });
    };

    const runAutoBusOnce = async () => {
      if (!autoBusEnabled || closing || pendingTask) return;
      if (Number(getAutoBusPendingCount()) <= 0) {
        autoBusError = "";
        return;
      }
      const ubusResult = await runUbusCommand(state, {
        workspaceRoot,
        subscriberId: autoBusSubscriberId,
        onMessageReceived: (msg) => {
          // Display the incoming message immediately
          const { extractAgentNickname } = require("./agent");
          const nickname = extractAgentNickname(msg.from) || msg.from;
          logText(`${nickname}: ${msg.task}`);
        },
      });
      if (!ubusResult.ok) {
        const nextError = String(ubusResult.error || "ubus failed");
        if (nextError !== autoBusError) {
          autoBusError = nextError;
          logText(`Error: ${nextError}`);
        }
        return;
      }
      autoBusError = "";
      if (ubusResult.handled > 0) {
        // Display only the replies (tasks were already shown via onMessageReceived)
        if (ubusResult.messageExchanges && ubusResult.messageExchanges.length > 0) {
          const { extractAgentNickname } = require("./agent");
          for (const exchange of ubusResult.messageExchanges) {
            const nickname = extractAgentNickname(exchange.from) || exchange.from;
            // Only show the reply since task was already displayed
            logText(`@${nickname} ${exchange.reply}`);
          }
        }
        const persisted = persistSessionState(state);
        if (!persisted || persisted.ok === false) {
          logText(`Error: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}`);
        }
      }
    };

    const scheduleAutoBus = () => {
      if (!autoBusEnabled || closing || autoBusQueued || pendingTask) return;
      if (Number(getAutoBusPendingCount()) <= 0) return;
      autoBusQueued = true;
      chain = chain
        .then(() => runAutoBusOnce())
        .catch(() => {})
        .finally(() => {
          autoBusQueued = false;
        });
    };

    const resolveTargetToken = (token = "") => {
      const text = String(token || "").trim();
      if (!text) return "";

      if (text.includes(":")) {
        const match = activeAgents.find((id) => id === text || id.startsWith(text));
        if (match) return match;
      }

      const normalized = text.toLowerCase();
      for (const id of activeAgents) {
        const meta = activeAgentMetaMap.get(id);
        if (!meta) continue;
        const nick = String(meta.nickname || "").toLowerCase();
        if (nick && (nick === normalized || nick.startsWith(normalized))) return id;
      }
      return "";
    };

    const executeLine = async (line) => {
      const normalizedLine = String(line || "").replace(/\r?\n/g, " ").trim();
      if (!normalizedLine) return;
      logUserInput(normalizedLine);

      refreshAgents();

      let actualLine = normalizedLine;
      let isBusMessage = false;

      if (targetAgent) {
        isBusMessage = true;
      }

      const mentionMatch = normalizedLine.match(/^@(\S+)\s+(.+)$/);
      if (mentionMatch) {
        const [, token, message] = mentionMatch;
        const resolved = resolveTargetToken(token);
        if (resolved) {
          isBusMessage = true;
          actualLine = message;
          targetAgent = resolved;
          selectedAgentIndex = activeAgents.indexOf(resolved);
          setPrompt();
          renderDashboard();
        }
      }

      if (isBusMessage && targetAgent) {
        updateStatus("Sending message...", "typing");
        try {
          execSync(`ufoo bus send "${targetAgent}" "${actualLine.replace(/"/g, '\\"')}"`, {
            cwd: workspaceRoot,
            encoding: "utf8",
          });
          updateStatus("", "none");
          logText(`✓ Message sent to ${getAgentLabel(targetAgent)}`);
        } catch (err) {
          updateStatus("", "none");
          const msg = err && err.message ? err.message : "unknown error";
          logText(`Failed to send message: ${msg}`);
        }
        targetAgent = null;
        selectedAgentIndex = -1;
        agentSelectionMode = false;
        setPrompt();
        renderDashboard();
        return;
      }

      const runtimeWorkspace = String((state && state.workspaceRoot) || workspaceRoot || process.cwd());
      const result = runSingleCommand(actualLine, runtimeWorkspace);
      if (result.kind === "empty") return;
      if (result.kind === "exit") {
        closeWithCode(0);
        return;
      }
      if (result.kind === "tool") {
        const payload = result.result && typeof result.result === "object" ? result.result : {};
        logToolHint({
          tool: result.tool,
          args: result.args,
          phase: payload.ok === false ? "error" : "end",
          error: payload.error || "",
        }, payload);
        return;
      }
      if (result.kind === "help" || result.kind === "probe" || result.kind === "error") {
        logText(result.output || "");
        return;
      }
      if (result.kind === "ubus") {
        updateStatus("Checking bus messages...", "typing");
        const ubusResult = await runUbusCommand(state, {
          workspaceRoot,
          onMessageReceived: (msg) => {
            // Display the incoming message immediately
            const { extractAgentNickname } = require("./agent");
            const nickname = extractAgentNickname(msg.from) || msg.from;
            logText(`${nickname}: ${msg.task}`);
          },
        });
        updateStatus("", "none");
        if (!ubusResult.ok) {
          logText(`Error: ${ubusResult.error}`);
          return;
        }

        // Display only the replies (tasks were already shown via onMessageReceived)
        if (ubusResult.messageExchanges && ubusResult.messageExchanges.length > 0) {
          const { extractAgentNickname } = require("./agent");
          for (const exchange of ubusResult.messageExchanges) {
            const nickname = extractAgentNickname(exchange.from) || exchange.from;
            // Only show the reply since task was already displayed
            logText(`@${nickname} ${exchange.reply}`);
          }
        } else if (ubusResult.handled === 0) {
          logText("ubus: no pending messages.");
        }
        const persisted = persistSessionState(state);
        if (!persisted || persisted.ok === false) {
          logText(`Error: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}`);
        }
        return;
      }
      if (result.kind === "resume") {
        const resumed = resumeSessionState(state, result.sessionId, workspaceRoot);
        if (!resumed.ok) {
          logText(`Error: ${resumed.error}`);
          return;
        }
        logText(`Resumed session ${resumed.sessionId} (${resumed.restoredMessages} messages).`);
        return;
      }

      if (result.kind === "nl") {
        const statusMessages = [
          "Thinking...",
          "Processing your request...",
          "Analyzing...",
          "Working on it...",
        ];
        const randomStatus = statusMessages[Math.floor(Math.random() * statusMessages.length)];
        const abortController = new AbortController();
        const escapeStripper = createEscapeTagStripper();
        pendingTask = {
          abortController,
          startedAt: Date.now(),
        };
        updateStatus(randomStatus, "thinking", {
          showTimer: true,
          startedAt: pendingTask.startedAt,
        });
        let streamState = null;
        let renderedToolLogCount = 0;
        const nlResult = await runNaturalLanguageTask(result.task, state, {
          signal: abortController.signal,
          onDelta: (delta) => {
            const text = escapeStripper.write(String(delta || ""));
            if (!text) return;
            if (!streamState) {
              streamState = createNlStreamState();
            }
            appendNlStreamDelta(streamState, text);
          },
          onToolLog: (entry) => {
            renderedToolLogCount += 1;
            logToolHint(entry);
          },
        });
        const tail = escapeStripper.flush();
        if (tail) {
          if (!streamState) {
            streamState = createNlStreamState();
          }
          appendNlStreamDelta(streamState, tail);
        }
        pendingTask = null;
        updateStatus("", "none");
        let finalStreamInfo = { lastChar: "" };
        if (streamState) {
          finalStreamInfo = finalizeNlStream(streamState);
        }
        if (Array.isArray(nlResult && nlResult.logs) && nlResult.logs.length > renderedToolLogCount) {
          for (const entry of nlResult.logs.slice(renderedToolLogCount)) {
            logToolHint(entry);
          }
        }
        const streamed = Boolean(nlResult && nlResult.streamed);
        const hasVisibleStreamText = Boolean(
          streamState
          && typeof streamState.full === "string"
          && /[^\s]/.test(streamState.full)
        );
        const streamLastChar = nlResult && typeof nlResult.streamLastChar === "string"
          ? nlResult.streamLastChar.slice(-1)
          : finalStreamInfo.lastChar;
        if (streamed && hasVisibleStreamText && streamLastChar !== "\n") {
          logBox.log("");
          screen.render();
        }
        const shouldSkipSummary = Boolean(streamed && nlResult && nlResult.ok && hasVisibleStreamText);
        if (!shouldSkipSummary) {
          logText(formatNlResult(nlResult, false));
        }
        const persisted = persistSessionState(state);
        if (!persisted || persisted.ok === false) {
          logText(`Error: failed to persist session ${state.sessionId}: ${(persisted && persisted.error) || "unknown error"}`);
        }
      }
    };

    const submitInput = (value = "") => {
      const raw = String(value || "");
      const trimmed = raw.trim();
      input.setValue("");
      cursorPos = 0;
      screen.render();
      agentSelectionMode = false;

      if (trimmed) {
        inputHistory.push(trimmed);
      }
      historyIndex = inputHistory.length;

      chain = chain
        .then(() => executeLine(raw))
        .catch((err) => {
          updateStatus("", "none");
          logText(`Error: ${err && err.message ? err.message : "agent loop failed"}`);
        })
        .finally(() => {
          if (closing) return;
          refreshAgents();
          setPrompt();
          renderDashboard();
          input.focus();
          screen.render();
        });
    };

    input.key(["enter"], () => {
      submitInput(input.getValue());
      return false;
    });
    input.key(["up"], () => {
      const currentValue = input.getValue();
      if (shouldClearAgentSelectionOnUp({
        agentSelectionMode,
        inputValue: currentValue,
      })) {
        const previousTarget = targetAgent;
        targetAgent = null;
        selectedAgentIndex = -1;
        agentSelectionMode = false;
        setPrompt();
        renderDashboard();
        // Target selection cleared - removed redundant log
        input.focus();
        return false;
      }
      if (inputHistory.length === 0) return;
      historyIndex = Math.max(0, historyIndex - 1);
      setInputValue(inputHistory[historyIndex] || "");
    });
    input.key(["down"], () => {
      const currentValue = input.getValue();
      const historyTransition = resolveHistoryDownTransition({
        inputHistory,
        historyIndex,
        currentValue,
      });
      if (historyTransition.moved) {
        historyIndex = historyTransition.nextHistoryIndex;
        setInputValue(historyTransition.nextValue);
        return false;
      }

      if (shouldEnterAgentSelection(currentValue)) {
        const cachedAgents = Array.isArray(activeAgents) ? activeAgents.slice() : [];
        const cachedMeta = activeAgentMetaMap instanceof Map ? new Map(activeAgentMetaMap) : new Map();
        if (!agentSelectionMode) {
          refreshAgents();
        }
        if (!agentSelectionMode && activeAgents.length === 0 && cachedAgents.length > 0) {
          activeAgents = cachedAgents;
          activeAgentMetaMap = cachedMeta;
        }
        const decision = resolveAgentSelectionOnDown({
          agentSelectionMode,
          selectedAgentIndex,
          totalAgents: activeAgents.length,
        });
        if (decision.action === "enter") {
          selectedAgentIndex = decision.index;
          targetAgent = activeAgents[selectedAgentIndex];
          agentSelectionMode = true;
          setPrompt();
          renderDashboard();
          // Removed redundant target selection log
          input.focus();
          return false;
        }
        if (decision.action === "hold") {
          return false;
        }
      }
      return false;
    });
    input.key(["left"], () => {
      const currentValue = input.getValue();
      if (agentSelectionMode && shouldEnterAgentSelection(currentValue)) {
        if (activeAgents.length === 0) refreshAgents();
        if (activeAgents.length === 0) return false;
        selectedAgentIndex = cycleAgentSelectionIndex(selectedAgentIndex, activeAgents.length, "left");
        targetAgent = activeAgents[selectedAgentIndex];
        setPrompt();
        renderDashboard();
        // Removed redundant target switch log
        input.focus();
        return false;
      }
      const next = moveCursorHorizontally(cursorPos, currentValue, "left");
      if (next !== cursorPos) {
        cursorPos = next;
        ensureInputCursorVisible();
        input._updateCursor();
        screen.render();
      }
      return false;
    });
    input.key(["right"], () => {
      const currentValue = input.getValue();
      if (agentSelectionMode && shouldEnterAgentSelection(currentValue)) {
        if (activeAgents.length === 0) refreshAgents();
        if (activeAgents.length === 0) return false;
        selectedAgentIndex = cycleAgentSelectionIndex(selectedAgentIndex, activeAgents.length, "right");
        targetAgent = activeAgents[selectedAgentIndex];
        setPrompt();
        renderDashboard();
        // Removed redundant target switch log
        input.focus();
        return false;
      }
      const next = moveCursorHorizontally(cursorPos, currentValue, "right");
      if (next !== cursorPos) {
        cursorPos = next;
        ensureInputCursorVisible();
        input._updateCursor();
        screen.render();
      }
      return false;
    });

    screen.key(["tab"], () => {
      refreshAgents();
      if (activeAgents.length === 0) return;
      if (selectedAgentIndex < 0) selectedAgentIndex = 0;
      else selectedAgentIndex = (selectedAgentIndex + 1) % activeAgents.length;
      targetAgent = activeAgents[selectedAgentIndex];
      agentSelectionMode = true;
      setPrompt();
      renderDashboard();
      // Removed redundant target switch log
      input.focus();
    });
    screen.key(["S-tab"], () => {
      refreshAgents();
      if (activeAgents.length === 0) return;
      if (selectedAgentIndex < 0) selectedAgentIndex = 0;
      else selectedAgentIndex = (selectedAgentIndex - 1 + activeAgents.length) % activeAgents.length;
      targetAgent = activeAgents[selectedAgentIndex];
      agentSelectionMode = true;
      setPrompt();
      renderDashboard();
      // Removed redundant target switch log
      input.focus();
    });
    screen.key(["C-o"], () => {
      if (!lastMergedToolGroup || lastMergedToolGroup.expanded) return;
      if (!Array.isArray(lastMergedToolGroup.entries) || lastMergedToolGroup.entries.length < 2) return;
      const lines = buildMergedToolExpandedLines(lastMergedToolGroup.entries);
      for (let i = 0; i < lines.length; i += 1) {
        const branch = i === lines.length - 1 ? "└" : "│";
        logBox.log(`{gray-fg}${branch}{/gray-fg} ${escapeBlessed(lines[i])}`);
      }
      lastMergedToolGroup.expanded = true;
      if (activeToolMerge && activeToolMerge.id === lastMergedToolGroup.id) {
        activeToolMerge = null;
      }
      screen.render();
    });
    input.key(["escape"], () => {
      if (pendingTask && pendingTask.abortController && !pendingTask.abortController.signal.aborted) {
        try {
          pendingTask.abortController.abort();
        } catch {
          // ignore
        }
        logControlAction("Cancellation requested. Stopping the current task...");
        updateStatus("Cancelling...", "waiting", {
          showTimer: true,
          startedAt: pendingTask.startedAt,
        });
        return false;
      }
      const previousTarget = targetAgent;
      targetAgent = null;
      selectedAgentIndex = -1;
      agentSelectionMode = false;
      input.setValue("");
      setPrompt();
      renderDashboard();
      // Target selection cleared - removed redundant log
      input.focus();
      return false;
    });
    screen.key(["C-c"], () => closeWithCode(0));
    screen.on("resize", () => {
      renderDashboard();
      screen.render();
    });

    const nickname = process.env.UFOO_NICKNAME || "";
    const subscriberId = currentSubscriberId;
    const agentId = subscriberId.includes(":") ? subscriberId.split(":")[1] : "";
    const bannerLines = buildUcodeBannerBlessedLines({
      model: state.model || process.env.UFOO_UCODE_MODEL || "",
      engine: state.engine || "ufoo-core",
      nickname,
      agentId,
      workspaceRoot,
      sessionId: state.sessionId || "",
      width: (stdout && stdout.columns) || 80,
    });
    for (const line of bannerLines) {
      logBox.log(String(line || ""));
    }
    logBox.log("");

    refreshAgents();
    setPrompt();
    updateStatus("", "none");
    renderDashboard();
    if (autoBusEnabled) {
      autoBusTimer = setInterval(() => {
        scheduleAutoBus();
      }, 800);
      scheduleAutoBus();
    }
    input.focus();
    screen.render();
  });
}

module.exports = {
  UCODE_BANNER_LINES,
  UCODE_VERSION,
  StreamBuffer,
  buildUcodeBannerLines,
  buildUcodeBannerBlessedLines,
  parseActiveAgentsFromBusStatus,
  shouldUseUcodeTui,
  renderLogLinesWithMarkdown,
  shouldEnterAgentSelection,
  resolveAgentSelectionOnDown,
  cycleAgentSelectionIndex,
  shouldClearAgentSelectionOnUp,
  moveCursorHorizontally,
  resolveHistoryDownTransition,
  filterSelectableAgents,
  stripLeakedEscapeTags,
  createEscapeTagStripper,
  formatPendingElapsed,
  normalizeBashToolCommand,
  normalizeToolMergeEntry,
  buildMergedToolSummaryText,
  buildMergedToolExpandedLines,
  runUcodeTui,
};

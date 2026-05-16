const os = require("os");
const { version: packageVersion } = require("../../package.json");

const ANSI_RESET = "\x1b[0m";
const CLAUDE_ORANGE = "\x1b[38;2;217;119;87m";
const BUS_STATUS_INDICATORS = {
  working: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  starting: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  waiting_input: ["∙", "∙∙", "∙∙∙", "∙∙", "∙"],
  blocked: ["!"],
};

function createAgentViewController(options = {}) {
  const {
    screen,
    input,
    processStdout = process.stdout,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    computeAgentBar = () => ({ bar: "", windowStart: 0 }),
    agentBarHints = { normal: "", dashboard: "" },
    maxAgentWindow = 4,
    getFocusMode = () => "input",
    setFocusMode = () => {},
    getSelectedAgentIndex = () => -1,
    setSelectedAgentIndex = () => {},
    getActiveAgents = () => [],
    getAgentListWindowStart = () => 0,
    setAgentListWindowStart = () => {},
    getAgentLabel = (id) => id,
    getAgentStates = () => ({}),
    getAgentActivityMeta = () => ({}),
    getProjectRoot = () => process.cwd(),
    setDashboardView = () => {},
    setScreenGrabKeys = (value) => {
      if (screen) screen.grabKeys = Boolean(value);
    },
    clearTargetAgent = () => {},
    renderDashboard = () => {},
    focusInput = () => {},
    resizeInput = () => {},
    renderScreen = () => {},
    getInjectSockPath = () => "",
    connectAgentOutput = () => {},
    disconnectAgentOutput = () => {},
    connectAgentInput = () => {},
    disconnectAgentInput = () => {},
    sendRaw = () => {},
    sendBusMessage = () => {},
    sendResize = () => {},
    requestScreenSnapshot = () => {},
    sendBusWatch = () => {},
    getBusLogHistory = () => [],
  } = options;

  if (!screen || typeof screen.render !== "function") {
    throw new Error("createAgentViewController requires screen.render");
  }

  let currentView = "main";
  let viewingAgent = null;
  let agentViewUsesBus = false;
  let agentOutputSuppressed = false;
  let agentBarVisible = false;
  let detachedChildren = null;
  let agentInputSuppressUntil = 0;
  let busInputValue = "";
  let busInputCursor = 0;
  let busLogLines = [];
  let busStartupAgentId = "";
  let busStartupLineCount = 0;
  let busAgentReplyActive = false;
  let busStatusInterval = null;
  let busStatusIndex = 0;
  let busStatusKey = "";
  let busStatusLocalStartedAt = 0;
  const originalRender = screen.render.bind(screen);
  let renderFrozen = false;

  screen.render = function wrappedRender() {
    if (renderFrozen) return;
    return originalRender();
  };

  function getRows() {
    if (Number.isFinite(screen.height) && screen.height > 0) return screen.height;
    if (Number.isFinite(screen.rows) && screen.rows > 0) return screen.rows;
    return processStdout.rows || 24;
  }

  function getCols() {
    if (Number.isFinite(screen.width) && screen.width > 0) return screen.width;
    if (Number.isFinite(screen.cols) && screen.cols > 0) return screen.cols;
    return processStdout.columns || 80;
  }

  function stripAnsi(text = "") {
    return String(text || "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }

  function hasAnsi(text = "") {
    return /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;?]*[ -/]*[@-~])/.test(String(text || ""));
  }

  function clamp(value, min, max) {
    const normalized = Number.isFinite(value) ? Math.floor(value) : min;
    return Math.max(min, Math.min(max, normalized));
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

  function fitAnsiText(text = "", width = 1) {
    const normalizedWidth = Math.max(1, width);
    const raw = String(text || "").replace(/\r/g, "");
    if (!hasAnsi(raw)) return fitText(raw, normalizedWidth);
    if (displayWidth(raw) <= normalizedWidth) {
      return padToWidth(raw, normalizedWidth);
    }
    if (normalizedWidth <= 1) return "…";

    const ansiPattern = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;
    let out = "";
    let cells = 0;
    let index = 0;
    while (index < raw.length && cells < normalizedWidth - 1) {
      ansiPattern.lastIndex = index;
      const match = ansiPattern.exec(raw);
      if (match && match.index === index) {
        out += match[0];
        index += match[0].length;
        continue;
      }
      const char = Array.from(raw.slice(index))[0] || "";
      if (!char) break;
      const charWidth = charDisplayWidth(char);
      if (cells + charWidth > normalizedWidth - 1) break;
      out += char;
      cells += charWidth;
      index += char.length;
    }
    const suffix = `${ANSI_RESET}…`;
    return padToWidth(`${out}${suffix}`, normalizedWidth);
  }

  function horizontalLine(width = 80) {
    return "─".repeat(Math.max(1, width));
  }

  function plainLine(text = "", width = 80) {
    return fitText(text, Math.max(1, width));
  }

  function logLine(text = "", width = 80) {
    const normalizedWidth = Math.max(1, width);
    return hasAnsi(text) ? fitAnsiText(text, normalizedWidth) : plainLine(text, normalizedWidth);
  }

  function parseTimeMs(value) {
    if (Number.isFinite(value)) return Number(value);
    const text = String(value || "").trim();
    if (!text) return NaN;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : NaN;
  }

  function formatElapsed(ms = 0) {
    const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
    return `${totalSeconds} s`;
  }

  function normalizeActivityState(value = "") {
    const state = String(value || "").trim().toLowerCase();
    if (state === "waiting") return "waiting_input";
    if (state === "busy" || state === "processing") return "working";
    return state;
  }

  function getActivityLabel(state = "") {
    if (state === "working") return "working";
    if (state === "waiting_input") return "waiting";
    if (state === "blocked") return "blocked";
    if (state === "starting") return "starting";
    if (state === "idle" || state === "ready") return "ready";
    return state || "ready";
  }

  function isTimedActivityState(state = "") {
    return state === "working"
      || state === "waiting_input"
      || state === "blocked"
      || state === "starting";
  }

  function asActivityObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function pickActivityDetail(meta = {}) {
    const candidates = [
      meta.activity_detail,
      meta.detail,
      meta.status_text,
      meta.command,
      meta.tool_name,
      meta.tool,
    ];
    return String(candidates.find((item) => String(item || "").trim()) || "").trim();
  }

  function getViewingAgentActivity() {
    const states = getAgentStates() || {};
    const stateEntry = viewingAgent && states ? states[viewingAgent] : "";
    const stateObject = asActivityObject(stateEntry);
    const meta = {
      ...(stateObject || {}),
      ...(asActivityObject(getAgentActivityMeta(viewingAgent)) || {}),
    };
    const state = normalizeActivityState(meta.activity_state || meta.state || (stateObject ? "" : stateEntry) || "");
    const detail = pickActivityDetail(meta);
    const sinceMs = parseTimeMs(meta.activity_since || meta.since || meta.updated_at || meta.updatedAt);
    return { state: state || "ready", detail, sinceMs };
  }

  function resolveBusStatus() {
    const activity = getViewingAgentActivity();
    const state = activity.state || "ready";
    const timed = isTimedActivityState(state);
    const key = `${viewingAgent || ""}:${state}:${activity.detail || ""}`;
    if (key !== busStatusKey) {
      busStatusKey = key;
      busStatusIndex = 0;
      busStatusLocalStartedAt = now();
    }
    const startedAt = timed && Number.isFinite(activity.sinceMs)
      ? activity.sinceMs
      : busStatusLocalStartedAt;
    return {
      ...activity,
      state,
      label: getActivityLabel(state),
      timed,
      startedAt,
    };
  }

  function buildBusStatusLine(width = 80, status = resolveBusStatus()) {
    const normalizedWidth = Math.max(1, width);
    const detail = status.detail ? ` · ${status.detail}` : "";
    if (status.timed) {
      const indicators = BUS_STATUS_INDICATORS[status.state] || BUS_STATUS_INDICATORS.working;
      const indicator = indicators[busStatusIndex % indicators.length] || "";
      const elapsed = formatElapsed(now() - status.startedAt);
      return fitText(`${indicator} ${status.label} · ${elapsed}${detail}`, normalizedWidth);
    }
    if (normalizedWidth < 32) return fitText(`ufoo · ${status.label}`, normalizedWidth);
    if (normalizedWidth < 48) return fitText(`ufoo · ${status.label} · Enter send`, normalizedWidth);
    return fitText(`ufoo · ${status.label} · Enter send · Esc back${detail}`, normalizedWidth);
  }

  function stopBusStatusTimer() {
    if (!busStatusInterval) return;
    clearIntervalFn(busStatusInterval);
    busStatusInterval = null;
  }

  function syncBusStatusTimer(status) {
    const shouldTick = currentView === "agent" && agentViewUsesBus && status && status.timed;
    if (!shouldTick) {
      stopBusStatusTimer();
      return;
    }
    if (busStatusInterval) return;
    busStatusInterval = setIntervalFn(() => {
      busStatusIndex += 1;
      renderBusView();
    }, 1000);
    if (busStatusInterval && typeof busStatusInterval.unref === "function") {
      busStatusInterval.unref();
    }
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
    if (hasAnsi(text)) return [String(text || "")];
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

  function getWrappedBusLogLines(width = 80) {
    const inner = Math.max(1, width);
    const wrapped = [];
    for (const line of busLogLines) {
      wrapped.push(...wrapTextLine(line, inner));
    }
    return wrapped;
  }

  function writeAt(row, content = "") {
    processStdout.write(`\x1b[${row};1H\x1b[2K${content}`);
  }

  function forceScreenRepaint() {
    if (typeof screen.realloc === "function") {
      screen.realloc();
    } else if (typeof screen.alloc === "function") {
      screen.alloc(true);
    }
    try {
      originalRender();
    } catch {
      // Ignore repaint failures while restoring from raw agent view.
    }
  }

  function compactProjectPath(projectRoot = "") {
    const raw = String(projectRoot || process.cwd() || "").trim();
    const home = os.homedir();
    if (home && (raw === home || raw.startsWith(`${home}/`))) {
      return `~${raw.slice(home.length)}`;
    }
    return raw || ".";
  }

  function borderedLines(lines = [], innerWidth = 56) {
    const contentWidth = Math.max(1, innerWidth);
    const out = [`╭${"─".repeat(contentWidth + 2)}╮`];
    for (const line of lines) {
      out.push(`│ ${fitText(line, contentWidth)} │`);
    }
    out.push(`╰${"─".repeat(contentWidth + 2)}╯`);
    return out;
  }

  function normalizeAgentKind(agentId = "") {
    const text = String(agentId || "").trim().toLowerCase();
    if (text.startsWith("codex:") || text === "codex") return "codex";
    if (text.startsWith("claude:") || text.startsWith("claude-code:") || text === "claude" || text === "claude-code") {
      return "claude";
    }
    return "internal";
  }

  function buildClaudeStartupLines(agentLabel = "", width = 80) {
    const label = String(agentLabel || "").trim();
    const projectPath = compactProjectPath(getProjectRoot());
    const product = "ClaudeCode";
    const detail = label ? `${label} · managed headless` : "managed headless";
    const iconWidth = 9;
    const iconGap = "  ";
    const iconLine = (icon = "", text = "") => {
      const pad = " ".repeat(Math.max(0, iconWidth - displayWidth(icon)));
      return `${CLAUDE_ORANGE}${icon}${ANSI_RESET}${pad}${iconGap}${text}`;
    };
    const lines = [
      iconLine(" ▐▛███▜▌", `${product}v${packageVersion}`),
      iconLine("▝▜█████▛▘", detail),
      iconLine("  ▘▘ ▝▝  ", projectPath),
      "",
    ];
    if (width < 44) return lines;
    return lines.map((line) => fitAnsiText(line, Math.min(58, Math.max(1, width))));
  }

  function buildCodexStartupLines(agentLabel = "", width = 80) {
    const label = String(agentLabel || "").trim();
    const projectPath = compactProjectPath(getProjectRoot());
    if (width < 36) {
      return [
        `>_ OpenAI Codex`,
        label ? `model: ${label}` : "model: managed headless",
        `directory: ${projectPath}`,
        "",
      ];
    }
    const innerWidth = Math.min(56, Math.max(24, width - 4));
    return [
      ...borderedLines([
        `>_ OpenAI Codex (ufoo v${packageVersion})`,
        "",
        `model:     ${label ? `${label} · managed headless` : "managed headless"}`,
        `directory: ${projectPath}`,
      ], innerWidth),
      "",
    ];
  }

  function buildInternalStartupLines(agentId = "", agentLabel = "", width = 80) {
    const kind = normalizeAgentKind(agentId);
    if (kind === "codex") return buildCodexStartupLines(agentLabel || agentId, width);
    return buildClaudeStartupLines(agentLabel || agentId, width);
  }

  function staticStartupLines(agentId = "", agentLabel = "", width = 80) {
    const lines = buildInternalStartupLines(agentId, agentLabel, width);
    if (lines.length > 0 && String(lines[lines.length - 1] || "") === "") {
      return lines.slice(0, -1);
    }
    return lines;
  }

  function resetBusView(agentId) {
    busInputValue = "";
    busInputCursor = 0;
    busAgentReplyActive = false;
    busStartupAgentId = agentId || "";
    const label = getAgentLabel(agentId);
    const startupLines = staticStartupLines(agentId, label, getCols());
    let historyLines = [];
    try {
      const loaded = getBusLogHistory(agentId);
      historyLines = Array.isArray(loaded) ? loaded : [];
    } catch {
      historyLines = [];
    }
    busLogLines = startupLines.concat("", historyLines);
    busStartupLineCount = startupLines.length;
  }

  function refreshBusStartupLines(width = getCols()) {
    if (!busStartupAgentId || busStartupLineCount <= 0) return;
    const label = getAgentLabel(busStartupAgentId);
    const startupLines = staticStartupLines(busStartupAgentId, label, width);
    const tailLines = busLogLines.slice(busStartupLineCount);
    busLogLines = startupLines.concat(tailLines.length > 0 ? tailLines : [""]);
    busStartupLineCount = startupLines.length;
  }

  function trimBusLogLines() {
    if (busLogLines.length <= 1000) return;
    const removed = busLogLines.length - 1000;
    busLogLines = busLogLines.slice(-1000);
    busStartupLineCount = Math.max(0, busStartupLineCount - removed);
  }

  function appendBusLog(text = "") {
    const clean = stripAnsi(String(text || "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (busLogLines.length === 0) busLogLines.push("");
    for (const char of clean) {
      if (char === "\n") {
        busLogLines.push("");
      } else {
        busLogLines[busLogLines.length - 1] += char;
      }
    }
    trimBusLogLines();
    if (clean.endsWith("\n")) {
      busAgentReplyActive = false;
    }
  }

  function ensureBusLinePrefix(prefix = "") {
    if (busLogLines.length === 0) {
      busLogLines.push(prefix);
      return;
    }
    if (busLogLines[busLogLines.length - 1] === "") {
      busLogLines[busLogLines.length - 1] = prefix;
      return;
    }
    busLogLines.push(prefix);
  }

  function appendBusAgentReply(text = "") {
    const clean = stripAnsi(String(text || "")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!clean) return;
    for (const char of clean) {
      if (char === "\n") {
        busLogLines.push("");
        continue;
      }
      if (!busAgentReplyActive) {
        ensureBusLinePrefix("• ");
        busAgentReplyActive = true;
      } else if (busLogLines.length === 0 || busLogLines[busLogLines.length - 1] === "") {
        ensureBusLinePrefix("  ");
      }
      busLogLines[busLogLines.length - 1] += char;
    }
    trimBusLogLines();
  }

  function getBusInputViewport(width) {
    const inner = Math.max(1, width - 2);
    const value = String(busInputValue || "").replace(/\n/g, "⏎");
    const beforeCursor = String(busInputValue || "").slice(0, busInputCursor).replace(/\n/g, "⏎");
    const cursorCells = displayWidth(beforeCursor);
    let startCell = 0;
    if (cursorCells >= inner) {
      startCell = cursorCells - inner + 1;
    }
    const text = sliceDisplayCells(value, startCell, inner);
    return {
      text,
      cursorCol: Math.max(0, cursorCells - startCell),
    };
  }

  function renderBusView() {
    if (currentView !== "agent" || !agentViewUsesBus) return;
    const rows = getRows();
    const cols = getCols();
    const width = Math.max(20, cols);
    refreshBusStartupLines(width);
    const inputTop = Math.max(4, rows - 3);
    const logContentTop = 1;
    const logContentBottom = Math.max(logContentTop, inputTop - 1);
    const logContentHeight = Math.max(1, logContentBottom - logContentTop + 1);
    const status = resolveBusStatus();
    const logRows = Math.max(0, logContentHeight - 1);
    const statusRow = logContentTop + logRows;

    processStdout.write("\x1b[?25l");
    const visibleLines = getWrappedBusLogLines(width).slice(-logRows);
    for (let i = 0; i < logRows; i += 1) {
      writeAt(logContentTop + i, logLine(visibleLines[i] || "", width));
    }
    writeAt(statusRow, logLine(buildBusStatusLine(width, status), width));

    writeAt(inputTop, horizontalLine(width));
    const viewport = getBusInputViewport(width);
    writeAt(inputTop + 1, plainLine(`> ${viewport.text}`, width));
    writeAt(inputTop + 2, horizontalLine(width));

    renderAgentDashboard();
    const cursorCol = clamp(3 + viewport.cursorCol, 1, width);
    processStdout.write(`\x1b[${inputTop + 1};${cursorCol}H\x1b[?25h`);
    syncBusStatusTimer(status);
  }

  function renderAgentDashboard() {
    if (!agentBarVisible && getFocusMode() !== "dashboard") return;
    const rows = getRows();
    const cols = getCols();
    const hintText = getFocusMode() === "dashboard"
      ? agentBarHints.dashboard
      : agentBarHints.normal;
    const computed = computeAgentBar({
      cols,
      hintText,
      focusMode: getFocusMode(),
      selectedAgentIndex: getSelectedAgentIndex(),
      activeAgents: getActiveAgents(),
      viewingAgent,
      agentListWindowStart: getAgentListWindowStart(),
      maxAgentWindow,
      getAgentLabel,
      agentStates: getAgentStates(),
    });
    setAgentListWindowStart(computed.windowStart);
    processStdout.write(`\x1b7\x1b[${rows};1H${computed.bar}\x1b8`);
  }

  function setAgentBarVisible(visible) {
    const next = Boolean(visible);
    if (agentBarVisible === next) return;
    agentBarVisible = next;
    const rows = getRows();
    if (agentBarVisible) {
      processStdout.write(`\x1b[1;${rows - 1}r`);
      renderAgentDashboard();
    } else {
      processStdout.write(`\x1b[1;${rows}r`);
      processStdout.write(`\x1b7\x1b[${rows};1H\x1b[2K\x1b8`);
    }
  }

  function enterAgentView(agentId, options = {}) {
    if (currentView === "agent" && viewingAgent === agentId) return;
    const wasInAgentView = currentView === "agent";
    if (currentView === "agent") {
      if (agentViewUsesBus && viewingAgent) sendBusWatch(viewingAgent, false);
      disconnectAgentOutput();
      disconnectAgentInput();
      stopBusStatusTimer();
    }

    currentView = "agent";
    viewingAgent = agentId;
    setFocusMode("input");

    if (!wasInAgentView) {
      detachedChildren = [...screen.children];
      for (const child of detachedChildren) screen.remove(child);
    }

    renderFrozen = true;

    const rows = getRows();
    const cols = getCols();
    processStdout.write("\x1b[2J\x1b[H");
    processStdout.write(`\x1b[1;${rows - 1}r`);
    processStdout.write("\x1b[H");
    processStdout.write("\x1b[?25h");
    setAgentBarVisible(true);

    agentInputSuppressUntil = now() + 300;
    agentViewUsesBus = Boolean(options.useBus);
    if (agentViewUsesBus) {
      sendBusWatch(agentId, true);
      resetBusView(agentId);
      renderBusView();
    } else {
      const sockPath = getInjectSockPath(agentId);
      connectAgentOutput(sockPath);
      connectAgentInput(sockPath);
    }

    setTimeoutFn(() => {
      sendResize(cols, Math.max(1, rows - 1));
      requestScreenSnapshot();
    }, 120);
  }

  function exitAgentView() {
    if (currentView !== "agent") return;

    const rows = getRows();
    const cols = getCols();
    sendResize(cols, rows);

    disconnectAgentOutput();
    disconnectAgentInput();
    if (agentViewUsesBus && viewingAgent) sendBusWatch(viewingAgent, false);
    agentViewUsesBus = false;
    agentOutputSuppressed = false;
    agentBarVisible = false;
    stopBusStatusTimer();
    busInputValue = "";
    busInputCursor = 0;
    busLogLines = [];
    busStartupAgentId = "";
    busStartupLineCount = 0;
    busAgentReplyActive = false;

    currentView = "main";
    viewingAgent = null;

    processStdout.write(`\x1b[1;${rows}r`);
    processStdout.write("\x1b[?25h");

    if (detachedChildren) {
      for (const child of detachedChildren) screen.append(child);
      detachedChildren = null;
    }

    renderFrozen = false;
    setFocusMode("input");
    setDashboardView("agents");
    setSelectedAgentIndex(-1);
    setScreenGrabKeys(false);
    clearTargetAgent();
    renderDashboard();
    focusInput();
    resizeInput();
    forceScreenRepaint();
    try {
      if (screen.program && typeof screen.program.showCursor === "function") {
        screen.program.showCursor();
      }
    } catch {
      // Ignore cursor restore errors.
    }
    if (input && typeof input._updateCursor === "function") {
      input._updateCursor();
    }
    renderScreen();
  }

  function enterAgentDashboardMode() {
    setFocusMode("dashboard");
    setDashboardView("agents");
    setSelectedAgentIndex(0);
    setAgentBarVisible(true);
    renderAgentDashboard();
    agentOutputSuppressed = true;
  }

  function insertBusInput(text = "") {
    const value = String(text || "");
    if (!value) return;
    busInputValue = busInputValue.slice(0, busInputCursor) + value + busInputValue.slice(busInputCursor);
    busInputCursor += value.length;
    renderBusView();
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

  function clampInputCursor(pos = busInputCursor) {
    const boundaries = inputBoundaries(busInputValue);
    const target = clamp(pos, 0, busInputValue.length);
    let best = 0;
    for (const boundary of boundaries) {
      if (boundary <= target) best = boundary;
      else break;
    }
    return best;
  }

  function previousInputBoundary(pos = busInputCursor) {
    const boundaries = inputBoundaries(busInputValue);
    const target = clamp(pos, 0, busInputValue.length);
    let prev = 0;
    for (const boundary of boundaries) {
      if (boundary < target) prev = boundary;
      else break;
    }
    return prev;
  }

  function nextInputBoundary(pos = busInputCursor) {
    const boundaries = inputBoundaries(busInputValue);
    const target = clamp(pos, 0, busInputValue.length);
    for (const boundary of boundaries) {
      if (boundary > target) return boundary;
    }
    return busInputValue.length;
  }

  function deleteBusInputBeforeCursor() {
    if (busInputCursor <= 0) return;
    const previous = previousInputBoundary();
    busInputValue = busInputValue.slice(0, previous) + busInputValue.slice(busInputCursor);
    busInputCursor = previous;
    renderBusView();
  }

  function clearBusInput() {
    busInputValue = "";
    busInputCursor = 0;
    renderBusView();
  }

  function submitBusInput() {
    const text = String(busInputValue || "").trim();
    if (!text) {
      renderBusView();
      return;
    }
    appendBusLog(`> ${text}\n`);
    busAgentReplyActive = false;
    busInputValue = "";
    busInputCursor = 0;
    sendBusMessage(viewingAgent, text);
    renderBusView();
  }

  function handleBusAgentKey(ch, key = {}) {
    if (currentView !== "agent" || !agentViewUsesBus) return false;
    const keyName = key && key.name;

    if (keyName === "down") return false;

    if (keyName === "escape") {
      exitAgentView();
      return true;
    }
    if (keyName === "return" || keyName === "enter") {
      if (key && (key.shift || key.meta)) {
        insertBusInput("\n");
      } else {
        submitBusInput();
      }
      return true;
    }
    if (key && key.ctrl && keyName === "u") {
      clearBusInput();
      return true;
    }
    if (key && key.ctrl && keyName === "a") {
      busInputCursor = 0;
      renderBusView();
      return true;
    }
    if (key && key.ctrl && keyName === "e") {
      busInputCursor = busInputValue.length;
      renderBusView();
      return true;
    }
    if (keyName === "left") {
      busInputCursor = previousInputBoundary();
      renderBusView();
      return true;
    }
    if (keyName === "right") {
      busInputCursor = nextInputBoundary();
      renderBusView();
      return true;
    }
    if (keyName === "home") {
      busInputCursor = 0;
      renderBusView();
      return true;
    }
    if (keyName === "end") {
      busInputCursor = busInputValue.length;
      renderBusView();
      return true;
    }
    if (keyName === "backspace") {
      deleteBusInputBeforeCursor();
      return true;
    }
    if (keyName === "delete") {
      if (busInputCursor < busInputValue.length) {
        const next = nextInputBoundary();
        busInputValue = busInputValue.slice(0, busInputCursor) + busInputValue.slice(next);
        busInputCursor = clampInputCursor();
        renderBusView();
      }
      return true;
    }
    if (ch && ch.length > 1 && (!keyName || keyName.length !== 1)) {
      insertBusInput(ch.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
      return true;
    }
    const insertChar = (ch && ch.length === 1)
      ? ch
      : (keyName && keyName.length === 1 ? keyName : "");
    if (insertChar && !/^[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]$/.test(insertChar)) {
      insertBusInput(insertChar);
      return true;
    }
    return true;
  }

  function sendRawToAgent(data) {
    sendRaw(data);
  }

  function sendResizeToAgent(cols, rows) {
    sendResize(cols, rows);
  }

  function requestAgentSnapshot() {
    requestScreenSnapshot();
  }

  function writeToAgentTerm(text) {
    if (!text) return;
    if (currentView !== "agent") return;
    if (agentOutputSuppressed) return;

    const cleaned = text
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[(?:[?>=]?[0-9]*c|[?]?6n|5n)/g, "");
    if (agentViewUsesBus) {
      appendBusAgentReply(cleaned);
      renderBusView();
      return;
    }
    if (cleaned) processStdout.write(cleaned);
    if (agentBarVisible) {
      const rows = getRows();
      processStdout.write("\x1b7");
      processStdout.write(`\x1b[1;${rows - 1}r`);
      processStdout.write("\x1b8");
      renderAgentDashboard();
    }
  }

  function placeAgentCursor(cursor) {
    if (!cursor || currentView !== "agent") return;
    const rows = getRows();
    const cols = getCols();
    const row = Math.max(1, Math.min(rows - 1, (cursor.y || 0) + 1));
    const col = Math.max(1, Math.min(cols, (cursor.x || 0) + 1));
    processStdout.write(`\x1b[${row};${col}H\x1b[?25h`);
  }

  function handleResizeInAgentView() {
    if (currentView !== "agent") return false;
    const rows = getRows();
    const cols = getCols();
    processStdout.write(`\x1b[1;${rows - 1}r`);
    sendResize(cols, Math.max(1, rows - 1));
    if (agentViewUsesBus) {
      renderBusView();
    } else {
      renderAgentDashboard();
    }
    return true;
  }

  function getCurrentView() {
    return currentView;
  }

  function getViewingAgent() {
    return viewingAgent || "";
  }

  function isAgentViewUsesBus() {
    return agentViewUsesBus;
  }

  function getAgentInputSuppressUntil() {
    return agentInputSuppressUntil;
  }

  function getAgentOutputSuppressed() {
    return agentOutputSuppressed;
  }

  function setAgentOutputSuppressed(value) {
    agentOutputSuppressed = Boolean(value);
    if (!agentOutputSuppressed && agentViewUsesBus) {
      renderBusView();
    }
  }

  function refreshAgentView() {
    if (currentView !== "agent") return false;
    if (agentViewUsesBus) {
      renderBusView();
    } else {
      renderAgentDashboard();
    }
    return true;
  }

  function isAgentBarVisible() {
    return agentBarVisible;
  }

  return {
    getCurrentView,
    getViewingAgent,
    isAgentViewUsesBus,
    getAgentInputSuppressUntil,
    getAgentOutputSuppressed,
    setAgentOutputSuppressed,
    refreshAgentView,
    isAgentBarVisible,
    renderAgentDashboard,
    setAgentBarVisible,
    enterAgentView,
    exitAgentView,
    enterAgentDashboardMode,
    sendRawToAgent,
    sendResizeToAgent,
    requestAgentSnapshot,
    writeToAgentTerm,
    placeAgentCursor,
    handleResizeInAgentView,
    handleBusAgentKey,
  };
}

module.exports = {
  createAgentViewController,
};

const path = require("path");
const os = require("os");
const crypto = require("crypto");
const blessed = require("blessed");
const { execSync } = require("child_process");
const fs = require("fs");
const {
  loadConfig,
  saveConfig,
  normalizeLaunchMode,
  normalizeAgentProvider,
} = require("../config");
const { socketPath, isRunning } = require("../daemon");
const UfooInit = require("../init");
const AgentActivator = require("../bus/activate");
const { subscriberToSafeName } = require("../bus/utils");
const { getUfooPaths } = require("../ufoo/paths");
const { startDaemon, stopDaemon, connectWithRetry } = require("./transport");
const { escapeBlessed, stripBlessedTags, truncateText } = require("./text");
const { COMMAND_REGISTRY, parseCommand, parseAtTarget } = require("./commands");
const inputMath = require("./inputMath");
const { createStreamTracker } = require("./streamTracker");
const agentDirectory = require("./agentDirectory");
const { computeAgentBar } = require("./agentBar");
const { createAgentSockets } = require("./agentSockets");
const { createDashboardKeyController } = require("./dashboardKeyController");
const { computeDashboardContent } = require("./dashboardView");
const { createCommandExecutor } = require("./commandExecutor");
const { createInputSubmitHandler } = require("./inputSubmitHandler");
const { keyToRaw } = require("./rawKeyMap");
const { createCompletionController } = require("./completionController");
const { createStatusLineController } = require("./statusLineController");
const { createInputHistoryController } = require("./inputHistoryController");
const { createInputListenerController } = require("./inputListenerController");
const { createDaemonMessageRouter } = require("./daemonMessageRouter");
const { createChatLogController } = require("./chatLogController");
const { createPasteController } = require("./pasteController");
const { createAgentViewController } = require("./agentViewController");
const { createSettingsController } = require("./settingsController");
const { createProjectCloseController } = require("./projectCloseController");
const { createChatLayout } = require("./layout");
const { createDaemonCoordinator } = require("./daemonCoordinator");
const { IPC_REQUEST_TYPES } = require("../shared/eventContract");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");
const { createDaemonTransport } = require("./daemonTransport");
const { listProjectRuntimes, resolveRuntimeDir } = require("../projects/registry");
const { canonicalProjectRoot, buildProjectId } = require("../projects/projectId");
const {
  sortProjectRuntimes,
  parseTimestampMs,
  filterVisibleProjectRuntimes,
} = require("./projectRuntimes");

const MODE_OPTIONS = ["auto", "host", "terminal", "tmux", "internal"];

async function runChat(projectRoot, options = {}) {
  const globalMode = options && options.globalMode === true;
  const DASHBOARD_HEIGHT = globalMode ? 2 : 1;
  let activeProjectRoot = projectRoot;
  try {
    activeProjectRoot = canonicalProjectRoot(projectRoot);
  } catch {
    activeProjectRoot = path.resolve(projectRoot || process.cwd());
  }

  if (!fs.existsSync(getUfooPaths(projectRoot).ufooDir)) {
    const repoRoot = path.join(__dirname, "..", "..");
    const init = new UfooInit(repoRoot);
    await init.init({ modules: "context,bus", project: projectRoot });
  }

  // Ensure subscriber ID exists for chat (persistent across restarts)
  if (!process.env.UFOO_SUBSCRIBER_ID) {
    const sessionFile = path.join(getUfooPaths(projectRoot).ufooDir, "chat", "session-id.txt");
    const sessionDir = path.dirname(sessionFile);
    fs.mkdirSync(sessionDir, { recursive: true });

    let sessionId;
    if (fs.existsSync(sessionFile)) {
      sessionId = fs.readFileSync(sessionFile, "utf8").trim();
    } else {
      sessionId = crypto.randomBytes(4).toString("hex");
      fs.writeFileSync(sessionFile, sessionId, "utf8");
    }
    // Chat 模式默认使用 claude-code 类型
    process.env.UFOO_SUBSCRIBER_ID = `claude-code:${sessionId}`;
  }

  if (!isRunning(projectRoot)) {
    startDaemon(projectRoot);
  }

  const sock = socketPath(projectRoot);
  let daemonCoordinator = null;
  const daemonTransport = createDaemonTransport({
    projectRoot,
    sockPath: sock,
    isRunning,
    startDaemon,
    connectWithRetry,
  });

  const config = loadConfig(projectRoot);
  let launchMode = config.launchMode;
  let agentProvider = config.agentProvider;
  let autoResume = config.autoResume !== false;
  let cronTasks = [];

  // Dynamic input height settings.
  // Layout: dashboard(N) + inputBottom(1) + content + inputTop(1) + status(1)
  const MIN_INPUT_CONTENT_HEIGHT = 1;
  const MAX_INPUT_CONTENT_HEIGHT = 6;
  const MIN_INPUT_HEIGHT = MIN_INPUT_CONTENT_HEIGHT + DASHBOARD_HEIGHT + 2;
  const MAX_INPUT_HEIGHT = MAX_INPUT_CONTENT_HEIGHT + DASHBOARD_HEIGHT + 2;
  let currentInputHeight = MIN_INPUT_HEIGHT;
  const pkg = require("../../package.json");
  const {
    screen,
    logBox,
    statusLine,
    bannerText,
    completionPanel,
    dashboard,
    inputBottomLine,
    promptBox,
    input,
    inputTopLine,
  } = createChatLayout({
    blessed,
    currentInputHeight,
    dashboardHeight: DASHBOARD_HEIGHT,
    version: pkg.version,
  });

  const globalChatRoot = path.join(os.homedir(), ".ufoo", "chat");
  const globalDraftsFile = path.join(globalChatRoot, "global-drafts.json");
  const GLOBAL_DRAFT_PERSIST_DEBOUNCE_MS = 150;
  let globalDraftsLoaded = false;
  let globalDraftPersistTimer = null;
  const globalDraftMap = new Map();

  function safeCanonicalProjectRoot(targetRoot) {
    try {
      return canonicalProjectRoot(targetRoot);
    } catch {
      return path.resolve(targetRoot || process.cwd());
    }
  }

  function resolveHistoryContext(targetProjectRoot) {
    const canonicalRoot = safeCanonicalProjectRoot(targetProjectRoot);
    if (!globalMode) {
      const localHistoryDir = path.join(getUfooPaths(canonicalRoot).ufooDir, "chat");
      return {
        projectRoot: canonicalRoot,
        historyDir: localHistoryDir,
        historyFile: path.join(localHistoryDir, "history.jsonl"),
        inputHistoryDir: localHistoryDir,
        inputHistoryFile: path.join(localHistoryDir, "input-history.jsonl"),
      };
    }
    let projectId = "";
    try {
      projectId = buildProjectId(canonicalRoot);
    } catch {
      projectId = crypto.createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16);
    }
    const globalHistoryDir = path.join(globalChatRoot, "global-history");
    const globalInputHistoryDir = path.join(globalChatRoot, "global-input-history");
    return {
      projectRoot: canonicalRoot,
      projectId,
      historyDir: globalHistoryDir,
      historyFile: path.join(globalHistoryDir, `${projectId}.jsonl`),
      inputHistoryDir: globalInputHistoryDir,
      inputHistoryFile: path.join(globalInputHistoryDir, `${projectId}.jsonl`),
    };
  }

  function loadGlobalDraftsOnce() {
    if (!globalMode || globalDraftsLoaded) return;
    globalDraftsLoaded = true;
    try {
      const raw = fs.readFileSync(globalDraftsFile, "utf8");
      const parsed = JSON.parse(String(raw || "{}"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      Object.entries(parsed).forEach(([projectRootKey, draft]) => {
        if (typeof draft !== "string") return;
        const canonicalKey = safeCanonicalProjectRoot(projectRootKey);
        if (!canonicalKey) return;
        globalDraftMap.set(canonicalKey, draft);
      });
    } catch {
      // Ignore missing/invalid drafts file.
    }
  }

  function writeGlobalDraftsToDisk() {
    if (!globalMode) return;
    const out = {};
    for (const [projectRootKey, draft] of globalDraftMap.entries()) {
      if (!projectRootKey) continue;
      if (typeof draft !== "string" || draft.length === 0) continue;
      out[projectRootKey] = draft;
    }
    try {
      fs.mkdirSync(path.dirname(globalDraftsFile), { recursive: true });
      fs.writeFileSync(globalDraftsFile, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    } catch {
      // Ignore draft persistence failures.
    }
  }

  function persistGlobalDrafts(options = {}) {
    if (!globalMode) return;
    const immediate = Boolean(options.immediate);
    if (immediate) {
      if (globalDraftPersistTimer) {
        clearTimeout(globalDraftPersistTimer);
        globalDraftPersistTimer = null;
      }
      writeGlobalDraftsToDisk();
      return;
    }
    if (globalDraftPersistTimer) {
      clearTimeout(globalDraftPersistTimer);
    }
    globalDraftPersistTimer = setTimeout(() => {
      globalDraftPersistTimer = null;
      writeGlobalDraftsToDisk();
    }, GLOBAL_DRAFT_PERSIST_DEBOUNCE_MS);
  }

  function getProjectDraft(targetProjectRoot) {
    if (!globalMode) return "";
    loadGlobalDraftsOnce();
    const canonicalRoot = safeCanonicalProjectRoot(targetProjectRoot);
    return globalDraftMap.get(canonicalRoot) || "";
  }

  function setProjectDraft(targetProjectRoot, draft, options = {}) {
    if (!globalMode) return;
    loadGlobalDraftsOnce();
    const canonicalRoot = safeCanonicalProjectRoot(targetProjectRoot);
    const text = String(draft || "");
    if (!text) {
      globalDraftMap.delete(canonicalRoot);
    } else {
      globalDraftMap.set(canonicalRoot, text);
    }
    persistGlobalDrafts(options);
  }

  let currentHistoryContext = resolveHistoryContext(activeProjectRoot);

  let chatLogController = createChatLogController({
    logBox,
    fsModule: fs,
    historyDir: currentHistoryContext.historyDir,
    historyFile: currentHistoryContext.historyFile,
  });

  const streamTracker = createStreamTracker({
    logBox,
    writeSpacer: () => chatLogController.writeSpacer(false),
    appendHistory: (...args) => chatLogController.appendHistory(...args),
    escapeBlessed,
    onStreamStart: () => chatLogController.markStreamStart(),
  });

  const beginStream = (...args) => streamTracker.beginStream(...args);
  const appendStreamDelta = (...args) => streamTracker.appendStreamDelta(...args);
  const finalizeStream = (...args) => streamTracker.finalizeStream(...args);
  const markPendingDelivery = (...args) => streamTracker.markPendingDelivery(...args);
  const getPendingState = (...args) => streamTracker.getPendingState(...args);
  const consumePendingDelivery = (...args) => streamTracker.consumePendingDelivery(...args);

  function logMessage(type, text, meta = {}) {
    chatLogController.logMessage(type, text, meta);
  }

  function loadHistory(limit = 2000) {
    chatLogController.loadHistory(limit);
  }

  let inputHistoryController = null;

  function loadInputHistory(limit = 2000) {
    if (!inputHistoryController) return;
    inputHistoryController.loadInputHistory(limit);
  }

  const statusLineController = createStatusLineController({
    statusLine,
    bannerText,
    renderScreen: () => screen.render(),
  });

  const queueStatusLine = (...args) => statusLineController.queueStatusLine(...args);
  const resolveStatusLine = (...args) => statusLineController.resolveStatusLine(...args);
  const enqueueBusStatus = (...args) => statusLineController.enqueueBusStatus(...args);
  const resolveBusStatus = (...args) => statusLineController.resolveBusStatus(...args);

  let agentViewController = null;
  let terminalAdapterRouter = null;
  const agentSockets = createAgentSockets({
    onTermWrite: (text) => writeToAgentTerm(text),
    onPlaceCursor: (cursor) => placeAgentCursor(cursor),
    isAgentView: () => getCurrentView() === "agent",
    isBusMode: () => isAgentViewUsesBus(),
    getViewingAgent: () => getViewingAgent(),
    sendBusRaw: (target, data) => {
      send({
        type: IPC_REQUEST_TYPES.BUS_SEND,
        target,
        message: JSON.stringify({ raw: true, data }),
        injection_mode: "immediate",
        source: "chat-agent-view",
      });
    },
  });

  // Add cursor position tracking
  let cursorPos = 0;
  let preferredCol = null;

  function getInnerWidth() {
    const promptWidth = typeof promptBox.width === "number" ? promptBox.width : 2;
    return inputMath.getInnerWidth({ input, screen, promptWidth });
  }

  function getWrapWidth() {
    return inputMath.getWrapWidth(input, getInnerWidth());
  }

  function countLines(text, width) {
    return inputMath.countLines(text, width, (value) => input.strWidth(value));
  }

  function getCursorRowCol(text, pos, width) {
    return inputMath.getCursorRowCol(text, pos, width, (value) => input.strWidth(value));
  }

  function getCursorPosForRowCol(text, targetRow, targetCol, width) {
    return inputMath.getCursorPosForRowCol(
      text,
      targetRow,
      targetCol,
      width,
      (value) => input.strWidth(value),
    );
  }

  function ensureInputCursorVisible() {
    const innerWidth = getInnerWidth();
    if (innerWidth <= 0) return;
    const totalRows = countLines(input.value, innerWidth);
    const visibleRows = Math.max(1, input.height || 1);
    const { row } = getCursorRowCol(input.value, cursorPos, innerWidth);
    let base = input.childBase || 0;
    const maxBase = Math.max(0, totalRows - visibleRows);
    const bottomMargin = visibleRows > 1 ? 1 : 0;
    const upperLimit = base;
    const lowerLimit = base + visibleRows - bottomMargin - 1;

    if (row < upperLimit) {
      base = row;
    } else if (row > lowerLimit) {
      base = row - (visibleRows - bottomMargin - 1);
    }

    if (base > maxBase) base = maxBase;
    if (base < 0) base = 0;
    if (base !== input.childBase) {
      input.childBase = base;
      if (typeof input.scrollTo === "function") {
        input.scrollTo(base);
      }
    }
  }

  function resetPreferredCol() {
    preferredCol = null;
  }

  function getPreferredCol() {
    return preferredCol;
  }

  function setPreferredCol(value) {
    preferredCol = value;
  }

  function normalizePaste(text) {
    return inputMath.normalizePaste(text);
  }

  function updateDraftFromInput() {
    if (!inputHistoryController) return;
    inputHistoryController.updateDraftFromInput();
  }

  function normalizeCommandPrefix() {
    if (!input.value.startsWith("//")) return;
    const match = input.value.match(/^\/{2,}/);
    if (!match) return;
    const extra = match[0].length - 1;
    input.value = `/${input.value.slice(match[0].length)}`;
    cursorPos = Math.max(0, cursorPos - extra);
  }

  function insertTextAtCursor(text) {
    if (!text) return;
    input.value = input.value.slice(0, cursorPos) + text + input.value.slice(cursorPos);
    cursorPos += text.length;
    normalizeCommandPrefix();
    resetPreferredCol();
    resizeInput();
    ensureInputCursorVisible();
    input._updateCursor();
    screen.render();
    updateDraftFromInput();
  }

  function setInputValue(value) {
    input.value = value || "";
    cursorPos = input.value.length;
    resetPreferredCol();
    resizeInput();
    ensureInputCursorVisible();
    input._updateCursor();
    screen.render();
  }

  inputHistoryController = createInputHistoryController({
    inputHistoryFile: currentHistoryContext.inputHistoryFile,
    historyDir: currentHistoryContext.inputHistoryDir,
    setInputValue,
    getInputValue: () => input.value || "",
  });

  function captureCurrentProjectDraft() {
    if (!inputHistoryController || typeof inputHistoryController.getDraftForPersistence !== "function") {
      return input.value || "";
    }
    return inputHistoryController.getDraftForPersistence();
  }

  function seedGlobalHistoryFromProject(nextContext) {
    if (!globalMode || !nextContext || !nextContext.projectRoot) return;
    const projectUfooDir = getUfooPaths(nextContext.projectRoot).ufooDir;
    const projectChatDir = path.join(projectUfooDir, "chat");
    const projectHistoryFile = path.join(projectChatDir, "history.jsonl");
    const projectInputHistoryFile = path.join(projectChatDir, "input-history.jsonl");
    try {
      if (!fs.existsSync(nextContext.historyFile) && fs.existsSync(projectHistoryFile)) {
        fs.mkdirSync(path.dirname(nextContext.historyFile), { recursive: true });
        fs.copyFileSync(projectHistoryFile, nextContext.historyFile);
      }
    } catch {
      // best-effort seed only
    }
    try {
      if (!fs.existsSync(nextContext.inputHistoryFile) && fs.existsSync(projectInputHistoryFile)) {
        fs.mkdirSync(path.dirname(nextContext.inputHistoryFile), { recursive: true });
        fs.copyFileSync(projectInputHistoryFile, nextContext.inputHistoryFile);
      }
    } catch {
      // best-effort seed only
    }
  }

  function applyProjectHistoryContext(nextProjectRoot) {
    streamTracker.discardAll();
    const nextContext = resolveHistoryContext(nextProjectRoot);
    seedGlobalHistoryFromProject(nextContext);
    currentHistoryContext = nextContext;
    chatLogController.setHistoryTarget({
      historyDir: nextContext.historyDir,
      historyFile: nextContext.historyFile,
    });
    chatLogController.resetViewState();

    inputHistoryController.setHistoryTarget({
      inputHistoryFile: nextContext.inputHistoryFile,
      historyDir: nextContext.inputHistoryDir,
    });
    inputHistoryController.loadInputHistory();
    const nextDraft = getProjectDraft(nextContext.projectRoot);
    inputHistoryController.restoreDraft(nextDraft);

    clearLog();
    loadHistory();
    pending = null;
  }

  function historyUp() {
    if (!inputHistoryController) return false;
    return inputHistoryController.historyUp();
  }

  function historyDown() {
    if (!inputHistoryController) return false;
    return inputHistoryController.historyDown();
  }

  function exitHandler() {
    if (globalMode) {
      setProjectDraft(activeProjectRoot, captureCurrentProjectDraft(), { immediate: true });
    }
    if (daemonCoordinator) {
      daemonCoordinator.markExit();
    }
    exitAgentView();
    if (screen && screen.program && typeof screen.program.decrst === "function") {
      screen.program.decrst(2004);
    }
    statusLineController.destroy();
    if (daemonCoordinator) {
      daemonCoordinator.close();
    }
    process.exit(0);
  }

  const completionController = createCompletionController({
    input,
    screen,
    completionPanel,
    promptBox,
    commandRegistry: COMMAND_REGISTRY,
    getMentionCandidates: () => activeAgents.map((id) => ({
      id,
      label: getAgentLabel(id),
    })),
    normalizeCommandPrefix,
    truncateText,
    getCurrentInputHeight: () => currentInputHeight,
    getCursorPos: () => cursorPos,
    setCursorPos: (value) => {
      cursorPos = value;
    },
    resetPreferredCol,
    updateDraftFromInput,
    renderScreen: () => screen.render(),
  });

  const pasteController = createPasteController({
    shouldHandle: () => screen.focused === input && focusMode === "input",
    normalizePaste,
    insertTextAtCursor,
  });

  const inputListenerController = createInputListenerController({
    getCurrentView: () => getCurrentView(),
    exitHandler,
    getFocusMode: () => focusMode,
    getDashboardView: () => dashboardView,
    getSelectedAgentIndex: () => selectedAgentIndex,
    getActiveAgents: () => activeAgents,
    getTargetAgent: () => targetAgent,
    requestCloseAgent,
    logMessage,
    isSuppressKeypress: () => pasteController.isSuppressKeypress(),
    normalizeCommandPrefix,
    handleDashboardKey,
    exitDashboardMode,
    completionController,
    getLogHeight: () => logBox.height,
    scrollLog,
    insertTextAtCursor,
    normalizePaste,
    resetPreferredCol,
    getCursorPos: () => cursorPos,
    setCursorPos: (value) => {
      cursorPos = value;
    },
    ensureInputCursorVisible,
    getWrapWidth,
    getCursorRowCol,
    countLines,
    getCursorPosForRowCol,
    getPreferredCol,
    setPreferredCol,
    historyUp,
    historyDown,
    enterDashboardMode,
    resizeInput,
    updateDraftFromInput,
  });

  // Resize input box based on content
  function resizeInput() {
    const innerWidth = getWrapWidth();
    if (innerWidth <= 0) return;

    const numLines = countLines(input.value, innerWidth);
    const contentHeight = Math.min(MAX_INPUT_CONTENT_HEIGHT, Math.max(MIN_INPUT_CONTENT_HEIGHT, numLines));
    const targetHeight = contentHeight + DASHBOARD_HEIGHT + 2;

    if (targetHeight !== currentInputHeight) {
      currentInputHeight = targetHeight;
      input.height = contentHeight;
      promptBox.height = contentHeight;
      inputTopLine.bottom = currentInputHeight - 1;  // Just above input area
    }
    statusLine.bottom = currentInputHeight;
    // Reposition completion panel if active
    if (completionController.isActive()) completionController.reflow();
    // dashboard and inputBottomLine stay fixed at the bottom region.
    logBox.height = Math.max(1, screen.height - currentInputHeight - 1);
    ensureInputCursorVisible();
  }

  // Override the internal listener to support cursor movement
  input._listener = function(ch, key) {
    inputListenerController.handleKey(ch, key, this);
  };

  // Override cursor update to use our cursor position
  input._updateCursor = function() {
    if (this.screen.focused !== this) return;

    let lpos;
    try { lpos = this._getCoords(); } catch { return; }
    if (!lpos) return;

    const innerWidth = getWrapWidth();
    if (innerWidth <= 0) return;

    ensureInputCursorVisible();
    const { row, col } = getCursorRowCol(this.value, cursorPos, innerWidth);
    const scrollOffset = this.childBase || 0;

    const displayRow = row - scrollOffset;
    const safeCol = Math.min(Math.max(0, col), innerWidth - 1);
    const cy = lpos.yi + displayRow;
    const cx = lpos.xi + safeCol;

    this.screen.program.cup(cy, cx);
    this.screen.program.showCursor();
  };

  // Reset cursor and height on clear
  const originalClearValue = input.clearValue.bind(input);
  input.clearValue = function() {
    cursorPos = 0;
    resetPreferredCol();
    currentInputHeight = MIN_INPUT_HEIGHT;
    if (inputHistoryController) inputHistoryController.setIndexToEnd();
    completionController.hide();
    const contentHeight = MIN_INPUT_CONTENT_HEIGHT;
    input.height = contentHeight;
    promptBox.height = contentHeight;
    inputTopLine.bottom = currentInputHeight - 1;
    statusLine.bottom = currentInputHeight;
    logBox.height = Math.max(1, screen.height - currentInputHeight - 1);
    return originalClearValue();
  };

  let pending = null;

  // Agent selection state
  let activeAgents = [];
  let activeAgentLabelMap = new Map();
  let activeAgentMetaMap = new Map(); // Store full meta including launch_mode
  const transientAgentStateMap = new Map();
  let agentListWindowStart = 0;
  const MAX_AGENT_WINDOW = 4;
  let projectRuntimes = [];
  let projectListWindowStart = 0;
  const MAX_PROJECT_WINDOW = 5;
  let selectedProjectIndex = -1;
  let selectedAgentIndex = -1;  // -1 = not in dashboard selection mode
  let targetAgent = null;       // Selected agent for direct messaging
  let focusMode = "input";      // "input" or "dashboard"
  let dashboardView = "agents"; // "projects" | "agents" | "mode" | "provider" | "cron"
  let reportPendingTotal = 0;
  let selectedModeIndex = Math.max(0, MODE_OPTIONS.indexOf(launchMode));
  const providerOptions = [
    { label: "codex", value: "codex-cli" },
    { label: "claude", value: "claude-cli" },
    { label: "ucode", value: "ucode" },
  ];
  let selectedProviderIndex = Math.max(0, providerOptions.findIndex((opt) => opt.value === agentProvider));
  const resumeOptions = [
    { label: "Resume previous session", value: true },
    { label: "Start new session", value: false },
  ];
  let selectedResumeIndex = autoResume ? 0 : 1;
  const DASH_HINTS = {
    agents: "←/→ select · Enter · ↓ mode · ↑ back",
    agentsGlobal: "←/→ select · Enter · ↓ mode · ↑ projects",
    agentsEmpty: "↓ mode · ↑ back",
    mode: "←/→ select · Enter · ↓ provider · ↑ back",
    provider: "←/→ select · Enter · ↓ cron · ↑ back",
    cron: "Ctrl+X close · ↑ back",
    resume: "",
    projects: "Use /project switch <index|path>",
    projectsFocus: "←/→ switch · Ctrl+X close · ↓ second row · Enter confirm · ↑ back",
    projectsEmpty: "Run ufoo chat or ufoo daemon start in project directories",
  };
  const AGENT_BAR_HINTS = {
    normal: "↓ agents",
    dashboard: "←/→ · Enter · ↑ · ^X",
  };

  function getCurrentView() {
    return agentViewController ? agentViewController.getCurrentView() : "main";
  }

  function getViewingAgent() {
    return agentViewController ? agentViewController.getViewingAgent() : "";
  }

  function getAgentAdapter(agentId) {
    if (!terminalAdapterRouter) return null;
    const meta = activeAgentMetaMap ? activeAgentMetaMap.get(agentId) : null;
    const agentLaunchMode = (meta && meta.launch_mode) || launchMode || "";
    return terminalAdapterRouter.getAdapter({ launchMode: agentLaunchMode, agentId, meta });
  }

  function getViewingAgentAdapter() {
    const viewingAgent = getViewingAgent();
    if (!viewingAgent) return null;
    return getAgentAdapter(viewingAgent);
  }

  function canSendRaw(adapter) {
    if (!adapter || !adapter.capabilities) return false;
    return Boolean(
      adapter.capabilities.supportsSocketProtocol
      || adapter.capabilities.supportsInternalQueueLoop
    );
  }

  function canResize(adapter) {
    return Boolean(adapter && adapter.capabilities && adapter.capabilities.supportsSocketProtocol);
  }

  function canSnapshot(adapter) {
    if (!adapter || !adapter.capabilities) return false;
    return Boolean(
      adapter.capabilities.supportsSnapshot
      || adapter.capabilities.supportsSubscribeScreen
      || adapter.capabilities.supportsSubscribeFull
    );
  }

  function sendRawWithCapabilities(data) {
    const adapter = getViewingAgentAdapter();
    if (!canSendRaw(adapter)) return;
    try {
      adapter.sendRaw(data);
    } catch {
      // ignore unsupported errors
    }
  }

  function sendResizeWithCapabilities(cols, rows) {
    const adapter = getViewingAgentAdapter();
    if (!canResize(adapter)) return;
    try {
      adapter.resize(cols, rows);
    } catch {
      // ignore unsupported errors
    }
  }

  function requestSnapshotWithCapabilities() {
    const adapter = getViewingAgentAdapter();
    if (!canSnapshot(adapter)) return false;
    try {
      return adapter.snapshot();
    } catch {
      return false;
    }
  }

  function isAgentViewUsesBus() {
    return agentViewController ? agentViewController.isAgentViewUsesBus() : false;
  }

  function getAgentInputSuppressUntil() {
    return agentViewController ? agentViewController.getAgentInputSuppressUntil() : 0;
  }

  function getAgentOutputSuppressed() {
    return agentViewController ? agentViewController.getAgentOutputSuppressed() : false;
  }

  function setAgentOutputSuppressed(value) {
    if (agentViewController) {
      agentViewController.setAgentOutputSuppressed(value);
    }
  }

  function renderAgentDashboard() {
    if (agentViewController) {
      agentViewController.renderAgentDashboard();
    }
  }

  function setAgentBarVisible(visible) {
    if (agentViewController) {
      agentViewController.setAgentBarVisible(visible);
    }
  }

  function enterAgentView(agentId, options = {}) {
    if (agentViewController) {
      agentViewController.enterAgentView(agentId, options);
    }
  }

  function exitAgentView() {
    if (agentViewController) {
      agentViewController.exitAgentView();
    }
  }

  function sendRawToAgent(data) {
    if (agentViewController) {
      agentViewController.sendRawToAgent(data);
    }
  }

  function sendResizeToAgent(cols, rows) {
    if (agentViewController) {
      agentViewController.sendResizeToAgent(cols, rows);
    }
  }

  function requestAgentSnapshot() {
    if (agentViewController) {
      agentViewController.requestAgentSnapshot();
    }
  }

  function writeToAgentTerm(text) {
    if (agentViewController) {
      agentViewController.writeToAgentTerm(text);
    }
  }

  function placeAgentCursor(cursor) {
    if (agentViewController) {
      agentViewController.placeAgentCursor(cursor);
    }
  }

  function handleResizeInAgentView() {
    if (!agentViewController) return false;
    return agentViewController.handleResizeInAgentView();
  }

  function getAgentLabel(agentId) {
    return agentDirectory.getAgentLabel(activeAgentLabelMap, agentId);
  }

  function resolveAgentId(label) {
    return agentDirectory.resolveAgentId({
      label,
      activeAgents,
      labelMap: activeAgentLabelMap,
      lookupNickname: (nickname) => {
        try {
          const busPath = getUfooPaths(activeProjectRoot).agentsFile;
          const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
          for (const [id, meta] of Object.entries(bus.agents || {})) {
            if (meta && meta.nickname === nickname) return id;
          }
        } catch {
          // ignore lookup errors
        }
        return null;
      },
    });
  }

  function resolveAgentDisplayName(publisher) {
    return agentDirectory.resolveAgentDisplayName({
      publisher,
      labelMap: activeAgentLabelMap,
      lookupNicknameById: (id) => {
        try {
          const busPath = getUfooPaths(activeProjectRoot).agentsFile;
          const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
          const meta = bus.agents && bus.agents[id];
          if (meta && meta.nickname) return meta.nickname;
        } catch {
          // Keep original publisher ID
        }
        return null;
      },
    });
  }

  function clampAgentWindowWithSelection(selectionIndex) {
    agentListWindowStart = agentDirectory.clampAgentWindowWithSelection({
      activeCount: activeAgents.length,
      maxWindow: MAX_AGENT_WINDOW,
      windowStart: agentListWindowStart,
      selectionIndex,
    });
  }

  function clampAgentWindow() {
    clampAgentWindowWithSelection(selectedAgentIndex);
  }

  function resolveRuntimeProjectRoot(row = {}) {
    const raw = row && row.project_root ? String(row.project_root) : "";
    if (!raw) return "";
    try {
      return canonicalProjectRoot(raw);
    } catch {
      return path.resolve(raw);
    }
  }

  function refreshProjectRuntimes() {
    let rows = [];
    try {
      rows = listProjectRuntimes({ validate: true, cleanupTmp: true });
    } catch {
      rows = [];
    }
    rows = filterVisibleProjectRuntimes(rows);
    const normalizedActive = String(activeProjectRoot || "");
    if (
      normalizedActive
      && !rows.some((row) => resolveRuntimeProjectRoot(row) === normalizedActive)
    ) {
      rows.unshift({
        project_root: normalizedActive,
        project_name: path.basename(normalizedActive) || normalizedActive,
        status: "untracked",
        last_seen: null,
      });
    }
    projectRuntimes = sortProjectRuntimes({
      rows,
      activeProjectRoot: normalizedActive,
      resolveProjectRoot: resolveRuntimeProjectRoot,
      getInteractionMs: (row) => {
        const rowRoot = resolveRuntimeProjectRoot(row);
        if (!rowRoot) return 0;
        try {
          const historyContext = resolveHistoryContext(rowRoot);
          if (historyContext && historyContext.historyFile && fs.existsSync(historyContext.historyFile)) {
            const stat = fs.statSync(historyContext.historyFile);
            if (Number.isFinite(stat.mtimeMs) && stat.mtimeMs > 0) {
              return stat.mtimeMs;
            }
          }
        } catch {
          // fall through
        }
        return parseTimestampMs(row && row.last_seen);
      },
    });

    if (projectRuntimes.length === 0) {
      selectedProjectIndex = -1;
      projectListWindowStart = 0;
      return;
    }
    const activeIndex = projectRuntimes.findIndex(
      (row) => resolveRuntimeProjectRoot(row) === normalizedActive
    );
    if (selectedProjectIndex < 0 || selectedProjectIndex >= projectRuntimes.length) {
      selectedProjectIndex = activeIndex >= 0 ? activeIndex : 0;
    }
  }

  function syncSelectedProjectToActive() {
    if (!Array.isArray(projectRuntimes) || projectRuntimes.length === 0) return;
    const activeIndex = projectRuntimes.findIndex(
      (row) => resolveRuntimeProjectRoot(row) === String(activeProjectRoot || "")
    );
    if (activeIndex >= 0) {
      selectedProjectIndex = activeIndex;
    }
  }

  function send(req) {
    if (!daemonCoordinator) return;
    daemonCoordinator.send(req);
  }

  function updatePromptBox() {
    if (targetAgent) {
      const label = getAgentLabel(targetAgent);
      promptBox.setContent(`>@${label}`);
      promptBox.width = label.length + 3;  // >@name + spacer
      input.left = promptBox.width;
      input.width = `100%-${promptBox.width}`;
    } else {
      promptBox.setContent(">");
      promptBox.width = 2;
      input.left = 2;
      input.width = "100%-2";
    }
    if (!input.parent || !promptBox.parent) return;
    resizeInput();
    if (typeof input._updateCursor === "function") {
      input._updateCursor();
    }
  }

  function syncTargetFromSelection() {
    if (focusMode !== "dashboard" || dashboardView !== "agents") return;
    if (selectedAgentIndex >= 0 && selectedAgentIndex < activeAgents.length) {
      const nextTarget = activeAgents[selectedAgentIndex];
      if (nextTarget !== targetAgent) {
        targetAgent = nextTarget;
        updatePromptBox();
        screen.render();
      }
    } else if (targetAgent) {
      targetAgent = null;
      updatePromptBox();
      screen.render();
    }
  }

  function restoreTargetFromSelection() {
    if (selectedAgentIndex >= 0 && selectedAgentIndex < activeAgents.length) {
      targetAgent = activeAgents[selectedAgentIndex];
      updatePromptBox();
    }
  }

  function focusInput() {
    input.focus();
    input._updateCursor();
  }

  function focusLog() {
    logBox.focus();
    screen.program.hideCursor();
  }

  function scrollLog(offset) {
    logBox.scroll(offset);
    screen.render();
  }

  let settingsController = null;

  function setLaunchMode(mode) {
    if (settingsController) {
      settingsController.setLaunchMode(mode);
    }
  }

  function requestCloseAgent(agentId) {
    if (!agentId) {
      logMessage("error", "{white-fg}✗{/white-fg} No agent selected");
      return;
    }
    send({ type: IPC_REQUEST_TYPES.CLOSE_AGENT, agent_id: agentId });
  }

  function setAgentProvider(provider) {
    if (settingsController) {
      settingsController.setAgentProvider(provider);
    }
  }

  function setAutoResume(value) {
    if (settingsController) {
      settingsController.setAutoResume(value);
    }
  }

  async function restartDaemon() {
    if (!daemonCoordinator) return;
    return daemonCoordinator.restart();
  }

  settingsController = createSettingsController({
    projectRoot,
    saveConfig,
    normalizeLaunchMode,
    normalizeAgentProvider,
    fsModule: fs,
    getUfooPaths,
    logMessage,
    renderDashboard,
    renderScreen: () => screen.render(),
    restartDaemon,
    getLaunchMode: () => launchMode,
    setLaunchModeState: (value) => {
      launchMode = value;
    },
    setSelectedModeIndex: (value) => {
      selectedModeIndex = value;
    },
    getAgentProvider: () => agentProvider,
    setAgentProviderState: (value) => {
      agentProvider = value;
    },
    setSelectedProviderIndex: (value) => {
      selectedProviderIndex = value;
    },
    providerOptions,
    modeOptions: MODE_OPTIONS,
    getAutoResume: () => autoResume,
    setAutoResumeState: (value) => {
      autoResume = value;
    },
    setSelectedResumeIndex: (value) => {
      selectedResumeIndex = value;
    },
  });

  function clearLog() {
    logBox.setContent("");
    if (typeof logBox.scrollTo === "function") {
      logBox.scrollTo(0);
    }
    screen.render();
  }

  function renderDashboard() {
    const computed = computeDashboardContent({
      globalMode,
      focusMode,
      dashboardView,
      activeAgents,
      projects: projectRuntimes,
      selectedProjectIndex,
      projectListWindowStart,
      maxProjectWindow: MAX_PROJECT_WINDOW,
      activeProjectRoot,
      selectedAgentIndex,
      agentListWindowStart,
      maxAgentWindow: MAX_AGENT_WINDOW,
      getAgentLabel,
      getAgentState: (agentId) => {
        let metaState = "";
        if (activeAgentMetaMap) {
          const meta = activeAgentMetaMap.get(agentId);
          metaState = meta && typeof meta.activity_state === "string"
            ? String(meta.activity_state).trim()
            : "";
        }
        if (metaState) return metaState;
        const transientState = transientAgentStateMap.get(agentId);
        return typeof transientState === "string" ? transientState : "";
      },
      launchMode,
      agentProvider,
      autoResume,
      selectedModeIndex,
      selectedProviderIndex,
      selectedResumeIndex,
      cronTasks,
      providerOptions,
      resumeOptions,
      pendingReports: reportPendingTotal,
      dashHints: DASH_HINTS,
      modeOptions: MODE_OPTIONS,
    });
    if (globalMode && (focusMode !== "dashboard" || dashboardView === "projects")) {
      projectListWindowStart = computed.windowStart;
    } else {
      agentListWindowStart = computed.windowStart;
    }
    let dashboardContent = computed.content;
    if (globalMode && !String(dashboardContent || "").includes("\n")) {
      dashboardContent = `${dashboardContent}\n `;
    }
    dashboard.setContent(dashboardContent);
  }

  function readDiskMetaForActiveAgents(activeList = []) {
    const map = new Map();
    const ids = Array.isArray(activeList) ? activeList : [];
    if (ids.length === 0) return map;
    try {
      const busPath = getUfooPaths(activeProjectRoot).agentsFile;
      if (!fs.existsSync(busPath)) return map;
      const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
      const agents = bus && bus.agents && typeof bus.agents === "object" ? bus.agents : {};
      for (const id of ids) {
        const meta = agents[id];
        if (!meta || typeof meta !== "object") continue;
        map.set(id, meta);
      }
    } catch {
      // ignore disk fallback errors
    }
    return map;
  }

  function updateDashboard(status) {
    activeAgents = status.active || [];
    if (transientAgentStateMap.size > 0) {
      const activeSet = new Set(activeAgents);
      for (const id of transientAgentStateMap.keys()) {
        if (!activeSet.has(id)) {
          transientAgentStateMap.delete(id);
        }
      }
    }
    if (globalMode) {
      refreshProjectRuntimes();
    }
    reportPendingTotal = Number.isFinite(status?.reports?.pending_total)
      ? status.reports.pending_total
      : 0;
    cronTasks = Array.isArray(status?.cron?.tasks) ? status.cron.tasks : [];
    const metaList = Array.isArray(status.active_meta) ? status.active_meta : [];
    let fallbackMap = null;
    if (metaList.length === 0 && activeAgents.length > 0) {
      try {
        const busPath = getUfooPaths(activeProjectRoot).agentsFile;
        const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
        fallbackMap = new Map();
        for (const [id, meta] of Object.entries(bus.agents || {})) {
          if (meta && meta.nickname) fallbackMap.set(id, meta.nickname);
        }
      } catch {
        fallbackMap = null;
      }
    }
    const maps = agentDirectory.buildAgentMaps(activeAgents, metaList, fallbackMap);
    activeAgentLabelMap = maps.labelMap;
    const diskMetaMap = readDiskMetaForActiveAgents(activeAgents);
    if (diskMetaMap.size > 0) {
      const mergedMetaMap = new Map(maps.metaMap);
      for (const id of activeAgents) {
        const currentMeta = mergedMetaMap.get(id);
        const diskMeta = diskMetaMap.get(id);
        if (!currentMeta && diskMeta) {
          mergedMetaMap.set(id, { id, ...diskMeta });
          continue;
        }
        if (!currentMeta || !diskMeta) continue;
        const currentState = typeof currentMeta.activity_state === "string"
          ? String(currentMeta.activity_state).trim()
          : "";
        const diskState = typeof diskMeta.activity_state === "string"
          ? String(diskMeta.activity_state).trim()
          : "";
        if (!currentState && diskState) {
          mergedMetaMap.set(id, {
            ...currentMeta,
            activity_state: diskState,
            activity_since: currentMeta.activity_since || diskMeta.activity_since || "",
          });
        }
      }
      activeAgentMetaMap = mergedMetaMap;
    } else {
      activeAgentMetaMap = maps.metaMap;
    }
    clampAgentWindow();
    // If viewing agent went offline, exit view
    const currentView = getCurrentView();
    const viewingAgent = getViewingAgent();
    if (currentView === "agent" && viewingAgent && !activeAgents.includes(viewingAgent)) {
      writeToAgentTerm("\r\n\x1b[1;31m[Agent went offline]\x1b[0m\r\n");
      exitAgentView();
      return;
    }

    // In agent view, only update the dashboard bar (blessed is frozen)
    if (currentView === "agent") {
      if (focusMode === "dashboard") {
        const totalItems = 1 + activeAgents.length;
        if (selectedAgentIndex < 0 || selectedAgentIndex >= totalItems) {
          selectedAgentIndex = 0;
        }
      }
      renderAgentDashboard();
      return;
    }
    if (focusMode === "dashboard") {
      if (dashboardView === "agents") {
        if (activeAgents.length === 0) {
          selectedAgentIndex = -1;
        } else if (selectedAgentIndex < 0 || selectedAgentIndex >= activeAgents.length) {
          selectedAgentIndex = 0;
        }
        clampAgentWindow();
      }
    }
    syncTargetFromSelection();
    renderDashboard();
    screen.render();
  }

  function enterDashboardMode() {
    focusMode = "dashboard";
    dashboardView = globalMode ? "projects" : "agents";
    if (globalMode) {
      refreshProjectRuntimes();
      syncSelectedProjectToActive();
    } else {
      selectedAgentIndex = activeAgents.length > 0 ? 0 : -1;
      agentListWindowStart = 0;
      clampAgentWindow();
    }
    selectedModeIndex = Math.max(0, MODE_OPTIONS.indexOf(launchMode));
    selectedProviderIndex = Math.max(0, providerOptions.findIndex((opt) => opt.value === agentProvider));
    selectedResumeIndex = autoResume ? 0 : 1;
    // Immediately set @target when first agent is selected.
    if (!globalMode && selectedAgentIndex >= 0 && selectedAgentIndex < activeAgents.length) {
      targetAgent = activeAgents[selectedAgentIndex];
      updatePromptBox();
    }
    screen.grabKeys = true;
    renderDashboard();
    screen.program.hideCursor();
    screen.render();
    syncTargetFromSelection();
  }

  const dashboardState = {};
  Object.defineProperties(dashboardState, {
    currentView: { get: () => getCurrentView() },
    focusMode: { get: () => focusMode, set: (value) => { focusMode = value; } },
    dashboardView: { get: () => dashboardView, set: (value) => { dashboardView = value; } },
    selectedProjectIndex: { get: () => selectedProjectIndex, set: (value) => { selectedProjectIndex = value; } },
    projects: { get: () => projectRuntimes },
    activeProjectRoot: { get: () => activeProjectRoot },
    selectedAgentIndex: { get: () => selectedAgentIndex, set: (value) => { selectedAgentIndex = value; } },
    activeAgents: { get: () => activeAgents },
    viewingAgent: { get: () => getViewingAgent() },
    activeAgentMetaMap: { get: () => activeAgentMetaMap },
    selectedModeIndex: { get: () => selectedModeIndex, set: (value) => { selectedModeIndex = value; } },
    selectedProviderIndex: { get: () => selectedProviderIndex, set: (value) => { selectedProviderIndex = value; } },
    selectedResumeIndex: { get: () => selectedResumeIndex, set: (value) => { selectedResumeIndex = value; } },
    launchMode: { get: () => launchMode },
    agentProvider: { get: () => agentProvider },
    autoResume: { get: () => autoResume },
    cronTasks: { get: () => cronTasks },
    providerOptions: { get: () => providerOptions },
    resumeOptions: { get: () => resumeOptions },
    agentOutputSuppressed: {
      get: () => getAgentOutputSuppressed(),
      set: (value) => { setAgentOutputSuppressed(value); },
    },
  });

  function activateAgent(agentId) {
    if (!agentId) return;
    const activator = new AgentActivator(activeProjectRoot);
    activator.activate(agentId).catch(() => {});
  }

  terminalAdapterRouter = createTerminalAdapterRouter({
    activateAgent,
    sendRaw: (data) => agentSockets.sendRaw(data),
    sendResize: (cols, rows) => agentSockets.sendResize(cols, rows),
    requestSnapshot: (mode) => agentSockets.requestSnapshot(mode),
  });

  const dashboardController = createDashboardKeyController({
    state: dashboardState,
    globalMode,
    existsSync: fs.existsSync,
    getInjectSockPath,
    getAgentAdapter,
    activateAgent,
    requestCloseAgent,
    enterAgentView,
    exitAgentView,
    setAgentBarVisible,
    requestAgentSnapshot,
    clearTargetAgent,
    restoreTargetFromSelection,
    syncTargetFromSelection,
    exitDashboardMode,
    setLaunchMode,
    setAgentProvider,
    setAutoResume,
    clampAgentWindow,
    clampAgentWindowWithSelection,
    requestProjectSwitch: requestProjectSwitchByIndex,
    requestCloseProject: requestCloseProjectByIndex,
    renderDashboard,
    renderAgentDashboard,
    renderScreen: () => screen.render(),
    setScreenGrabKeys: (value) => {
      screen.grabKeys = Boolean(value);
    },
    modeOptions: MODE_OPTIONS,
  });

  function handleDashboardKey(key) {
    return dashboardController.handleDashboardKey(key);
  }

  function exitDashboardMode(selectAgent = false) {
    if (selectAgent && selectedAgentIndex >= 0 && selectedAgentIndex < activeAgents.length) {
      targetAgent = activeAgents[selectedAgentIndex];
      updatePromptBox();
    }
    focusMode = "input";
    dashboardView = globalMode ? "projects" : "agents";
    selectedAgentIndex = -1;
    // Keep selectedProjectIndex across focus transitions so global rail preserves context.
    screen.grabKeys = false;
    renderDashboard();
    focusInput();
    screen.render();
  }

  function clearTargetAgent() {
    targetAgent = null;
    updatePromptBox();
    screen.render();
  }

  function getInjectSockPath(agentId) {
    const safeName = subscriberToSafeName(agentId);
    return path.join(getUfooPaths(activeProjectRoot).busQueuesDir, safeName, "inject.sock");
  }

  agentViewController = createAgentViewController({
    screen,
    input,
    processStdout: process.stdout,
    computeAgentBar,
    agentBarHints: AGENT_BAR_HINTS,
    maxAgentWindow: MAX_AGENT_WINDOW,
    getFocusMode: () => focusMode,
    setFocusMode: (value) => {
      focusMode = value;
    },
    getSelectedAgentIndex: () => selectedAgentIndex,
    setSelectedAgentIndex: (value) => {
      selectedAgentIndex = value;
    },
    getActiveAgents: () => activeAgents,
    getAgentListWindowStart: () => agentListWindowStart,
    setAgentListWindowStart: (value) => {
      agentListWindowStart = value;
    },
    getAgentLabel,
    getAgentStates: () => {
      const states = {};
      if (activeAgentMetaMap) {
        for (const [id, meta] of activeAgentMetaMap) {
          if (meta && meta.activity_state) states[id] = meta.activity_state;
        }
      }
      return states;
    },
    setDashboardView: (value) => {
      dashboardView = value;
    },
    setScreenGrabKeys: (value) => {
      screen.grabKeys = Boolean(value);
    },
    clearTargetAgent,
    renderDashboard,
    focusInput,
    resizeInput,
    renderScreen: () => screen.render(),
    getInjectSockPath,
    connectAgentOutput: (sockPath) => {
      agentSockets.connectOutput(sockPath);
    },
    disconnectAgentOutput: () => {
      agentSockets.disconnectOutput();
    },
    connectAgentInput: (sockPath) => {
      agentSockets.connectInput(sockPath);
    },
    disconnectAgentInput: () => {
      agentSockets.disconnectInput();
    },
    sendRaw: (data) => {
      sendRawWithCapabilities(data);
    },
    sendResize: (cols, rows) => {
      sendResizeWithCapabilities(cols, rows);
    },
    requestScreenSnapshot: () => {
      requestSnapshotWithCapabilities();
    },
  });

  function requestStatus() {
    if (!daemonCoordinator) return;
    daemonCoordinator.requestStatus();
  }

  const daemonMessageRouter = createDaemonMessageRouter({
    escapeBlessed,
    stripBlessedTags,
    logMessage,
    renderScreen: () => screen.render(),
    updateDashboard,
    requestStatus,
    resolveStatusLine,
    enqueueBusStatus,
    resolveBusStatus,
    getPending: () => pending,
    setPending: (value) => {
      pending = value;
    },
    resolveAgentDisplayName,
    getCurrentView: () => getCurrentView(),
    isAgentViewUsesBus: () => isAgentViewUsesBus(),
    getViewingAgent: () => getViewingAgent(),
    writeToAgentTerm,
    consumePendingDelivery,
    getPendingState,
    beginStream,
    appendStreamDelta,
    finalizeStream,
    hasStream: (publisher) => streamTracker.hasStream(publisher),
    setTransientAgentState: (agentId, state) => {
      if (!agentId || !state) return;
      transientAgentStateMap.set(agentId, state);
    },
    clearTransientAgentState: (agentId) => {
      if (!agentId) return;
      transientAgentStateMap.delete(agentId);
    },
    refreshDashboard: () => {
      if (getCurrentView() === "agent") {
        renderAgentDashboard();
        return;
      }
      renderDashboard();
    },
  });

  daemonCoordinator = createDaemonCoordinator({
    projectRoot,
    daemonTransport,
    handleMessage: (msg) => daemonMessageRouter.handleMessage(msg),
    queueStatusLine,
    resolveStatusLine,
    logMessage,
    stopDaemon,
    startDaemon,
  });

  const connected = await daemonCoordinator.connect();
  if (!connected) {
    // Check if daemon failed to start
    if (!isRunning(activeProjectRoot)) {
      const logFile = getUfooPaths(activeProjectRoot).ufooDaemonLog;
      // eslint-disable-next-line no-console
      console.error("Failed to start ufoo daemon. Check logs at:", logFile);
      throw new Error("Daemon failed to start. Check the daemon log for details.");
    }
    throw new Error("Failed to connect to ufoo daemon (timeout). The daemon may still be starting.");
  }

  function resolveProjectSwitchTarget(rawTarget) {
    const target = String(rawTarget || "").trim();
    if (!target) {
      throw new Error("missing target");
    }
    if (/^\d+$/.test(target)) {
      const index = Number.parseInt(target, 10);
      if (!Number.isFinite(index) || index <= 0) {
        throw new Error("invalid project index");
      }
      const rows = listProjectRuntimes({ validate: true, cleanupTmp: true });
      const item = rows[index - 1];
      if (!item || !item.project_root) {
        throw new Error("project index out of range");
      }
      return {
        projectRoot: canonicalProjectRoot(item.project_root),
        source: `index ${index}`,
      };
    }
    return {
      projectRoot: canonicalProjectRoot(target),
      source: target,
    };
  }

  async function switchProjectConnection(targetInput) {
    let targetInfo;
    try {
      targetInfo = resolveProjectSwitchTarget(targetInput);
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : "invalid project target",
      };
    }
    const nextProjectRoot = targetInfo.projectRoot;
    if (!nextProjectRoot) {
      return { ok: false, error: "invalid project target" };
    }
    if (nextProjectRoot === activeProjectRoot) {
      return { ok: true, project_root: activeProjectRoot, unchanged: true };
    }
    const outgoingDraftSnapshot = captureCurrentProjectDraft();

    try {
      const nextPaths = getUfooPaths(nextProjectRoot);
      if (!fs.existsSync(nextPaths.ufooDir)) {
        const repoRoot = path.join(__dirname, "..", "..");
        const init = new UfooInit(repoRoot);
        await init.init({ modules: "context,bus", project: nextProjectRoot });
      }
      if (!isRunning(nextProjectRoot)) {
        startDaemon(nextProjectRoot);
      }
      const result = await daemonCoordinator.switchProject({
        projectRoot: nextProjectRoot,
        sockPath: socketPath(nextProjectRoot),
      });
      if (!result || result.ok !== true) {
        return {
          ok: false,
          error: (result && result.error) || "switch failed",
        };
      }
      const previousProjectRoot = activeProjectRoot;
      if (previousProjectRoot && previousProjectRoot !== nextProjectRoot) {
        setProjectDraft(previousProjectRoot, outgoingDraftSnapshot);
      }
      activeProjectRoot = nextProjectRoot;
      applyProjectHistoryContext(nextProjectRoot);
      if (globalMode) {
        refreshProjectRuntimes();
        syncSelectedProjectToActive();
        renderDashboard();
        screen.render();
      }
      return {
        ok: true,
        project_root: activeProjectRoot,
      };
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : "switch failed",
      };
    }
  }

  let projectSwitching = false;
  let pendingProjectSwitchRoot = null;
  let projectSwitchDebounceTimer = null;
  let projectSwitchFlushPromise = null;
  const PROJECT_SWITCH_DEBOUNCE_MS = 200;

  function cancelProjectSwitchDebounce() {
    if (!projectSwitchDebounceTimer) return;
    clearTimeout(projectSwitchDebounceTimer);
    projectSwitchDebounceTimer = null;
  }

  function scheduleProjectSwitchFlush(delayMs = PROJECT_SWITCH_DEBOUNCE_MS) {
    cancelProjectSwitchDebounce();
    projectSwitchDebounceTimer = setTimeout(() => {
      projectSwitchDebounceTimer = null;
      flushPendingProjectSwitch().catch((err) => {
        const message = err && err.message ? err.message : String(err || "switch failed");
        logMessage("error", `{white-fg}✗{/white-fg} Switch failed: ${escapeBlessed(message)}`);
      });
    }, Math.max(0, Number.isFinite(delayMs) ? delayMs : PROJECT_SWITCH_DEBOUNCE_MS));
  }

  async function flushPendingProjectSwitch() {
    if (projectSwitchFlushPromise) {
      return projectSwitchFlushPromise;
    }
    projectSwitchFlushPromise = (async () => {
      projectSwitching = true;
      let lastResult = { ok: true, project_root: activeProjectRoot, unchanged: true };
      try {
        while (pendingProjectSwitchRoot) {
          const nextProjectRoot = pendingProjectSwitchRoot;
          pendingProjectSwitchRoot = null;
          if (!nextProjectRoot || nextProjectRoot === activeProjectRoot) continue;
          const result = await switchProjectConnection(nextProjectRoot);
          lastResult = result || { ok: false, error: "switch failed" };
          if (!result || result.ok !== true) {
            const reason = (result && result.error) || "switch failed";
            logMessage("error", `{white-fg}✗{/white-fg} Switch failed: ${escapeBlessed(reason)}`);
          }
        }
        return lastResult;
      } finally {
        projectSwitching = false;
        if (globalMode) {
          refreshProjectRuntimes();
          syncSelectedProjectToActive();
          renderDashboard();
          screen.render();
        }
      }
    })();
    try {
      return await projectSwitchFlushPromise;
    } finally {
      projectSwitchFlushPromise = null;
      if (pendingProjectSwitchRoot && !projectSwitchDebounceTimer) {
        scheduleProjectSwitchFlush(0);
      }
    }
  }

  function requestProjectSwitchByIndex(index) {
    if (!globalMode) return;
    const numericIndex = Number(index);
    const nextIndex = Number.isFinite(numericIndex) ? Math.trunc(numericIndex) : Number.NaN;
    if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= projectRuntimes.length) {
      return;
    }
    selectedProjectIndex = nextIndex;
    const selected = projectRuntimes[nextIndex] || {};
    const nextProjectRoot = resolveRuntimeProjectRoot(selected);
    renderDashboard();
    screen.render();
    if (!nextProjectRoot) return;
    pendingProjectSwitchRoot = nextProjectRoot;
    scheduleProjectSwitchFlush();
  }

  async function requestProjectSwitchByTarget(targetInput) {
    let targetInfo;
    try {
      targetInfo = resolveProjectSwitchTarget(targetInput);
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : "invalid project target",
      };
    }
    const nextProjectRoot = targetInfo && targetInfo.projectRoot ? targetInfo.projectRoot : "";
    if (!nextProjectRoot) {
      return { ok: false, error: "invalid project target" };
    }
    if (nextProjectRoot === activeProjectRoot) {
      return { ok: true, project_root: activeProjectRoot, unchanged: true };
    }

    pendingProjectSwitchRoot = nextProjectRoot;
    cancelProjectSwitchDebounce();

    let attempts = 0;
    while (attempts < 4) {
      attempts += 1;
      const result = await flushPendingProjectSwitch();
      if (activeProjectRoot === nextProjectRoot) {
        return { ok: true, project_root: activeProjectRoot };
      }
      if (!pendingProjectSwitchRoot) {
        if (result && result.ok !== true) return result;
        return { ok: false, error: "switch failed" };
      }
      if (pendingProjectSwitchRoot !== nextProjectRoot) {
        pendingProjectSwitchRoot = nextProjectRoot;
      }
    }
    return { ok: false, error: "switch did not complete" };
  }

  const projectCloseController = createProjectCloseController({
    getProjects: () => projectRuntimes,
    getActiveProjectRoot: () => activeProjectRoot,
    resolveProjectRoot: resolveRuntimeProjectRoot,
    isRunning,
    stopDaemon,
    switchProject: (targetProjectRoot) => requestProjectSwitchByTarget(targetProjectRoot),
    refreshProjects: () => {
      if (!globalMode) return;
      refreshProjectRuntimes();
      syncSelectedProjectToActive();
    },
    renderDashboard,
    renderScreen: () => screen.render(),
    logMessage,
    escapeBlessed,
  });

  function requestCloseProjectByIndex(index) {
    if (!globalMode) return;
    void projectCloseController.requestCloseProject(index);
  }

  const commandExecutor = createCommandExecutor({
    projectRoot,
    parseCommand,
    escapeBlessed,
    logMessage,
    renderScreen: () => screen.render(),
    getActiveAgents: () => activeAgents,
    getActiveAgentMetaMap: () => activeAgentMetaMap,
    getAgentLabel,
    isDaemonRunning: isRunning,
    startDaemon,
    stopDaemon,
    restartDaemon,
    send,
    requestStatus,
    requestCron: (payload = {}) => {
      send({
        type: IPC_REQUEST_TYPES.CRON,
        ...payload,
      });
    },
    activateAgent: async (target) => {
      const activator = new AgentActivator(activeProjectRoot);
      await activator.activate(target);
    },
    listProjects: () => listProjectRuntimes({ validate: true, cleanupTmp: true }),
    getCurrentProject: () => ({
      project_root: activeProjectRoot,
      project_name: path.basename(activeProjectRoot),
    }),
    switchProject: async ({ target } = {}) => requestProjectSwitchByTarget(target),
  });

  async function executeCommand(text) {
    return commandExecutor.executeCommand(text);
  }

  const submitState = {};
  Object.defineProperties(submitState, {
    targetAgent: { get: () => targetAgent, set: (value) => { targetAgent = value; } },
    pending: { get: () => pending, set: (value) => { pending = value; } },
    activeAgentMetaMap: { get: () => activeAgentMetaMap },
  });

  const inputSubmitHandler = createInputSubmitHandler({
    state: submitState,
    parseAtTarget,
    resolveAgentId,
    executeCommand,
    queueStatusLine,
    send,
    logMessage,
    getAgentLabel,
    escapeBlessed,
    markPendingDelivery,
    clearTargetAgent,
    setTargetAgent: (agentId) => {
      targetAgent = agentId || null;
      updatePromptBox();
      screen.render();
    },
    enterAgentView,
    activateAgent: async (agentId) => {
      const activator = new AgentActivator(activeProjectRoot);
      await activator.activate(agentId);
    },
    getInjectSockPath,
    existsSync: fs.existsSync,
    commitInputHistory: (text) => {
      if (inputHistoryController) inputHistoryController.commitSubmittedText(text);
    },
    focusInput: () => input.focus(),
    renderScreen: () => screen.render(),  // Add renderScreen callback
  });

  input.on("submit", async (value) => {
    input.clearValue();
    screen.render(); // Render cleared input
    await inputSubmitHandler.handleSubmit(value);
    // No need for second render - handleSubmit now calls renderScreen() internally
  });

  screen.key(["C-c"], exitHandler);

  // Agent TTY view: enter dashboard mode
  function enterAgentDashboardMode() {
    if (agentViewController) {
      agentViewController.enterAgentDashboardMode();
    }
  }

  // Dashboard navigation - use screen.on to capture even when input is focused
  screen.on("keypress", (ch, key) => {
    // Agent TTY view: handle keystrokes
    if (getCurrentView() === "agent") {
      if (focusMode === "dashboard") {
        handleDashboardKey(key);
        return;
      }
      // Suppress input briefly after entering agent view
      if (Date.now() < getAgentInputSuppressUntil()) {
        return;
      }
      // Ctrl+C exits entire app
      if (key && key.ctrl && key.name === "c") {
        return; // handled by screen.key(["C-c"])
      }
      // Down arrow: enter agents bar (same pattern as normal chat dashboard)
      if (key && key.name === "down") {
        enterAgentDashboardMode();
        return;
      }
      // All other keys (including Esc) go to agent PTY
      const raw = keyToRaw(ch, key);
      if (raw) {
        sendRawToAgent(raw);
      }
      return;
    }

    // Normal mode: dashboard key handling
    handleDashboardKey(key);
  });

  screen.key(["tab"], () => {
    if (getCurrentView() === "agent") return; // Tab goes to PTY via keypress handler
    if (focusMode === "dashboard") {
      exitDashboardMode(false);
    } else {
      enterDashboardMode();
    }
  });

  screen.key(["C-k", "M-k"], () => {
    if (getCurrentView() === "agent") return;
    clearLog();
  });


  screen.key(["i", "enter"], () => {
    if (getCurrentView() === "agent") return;
    if (focusMode === "dashboard") return;
    if (screen.focused === input) return;
    focusInput();
  });

  // Escape in input mode only clears @target, never exits
  input.key(["escape"], () => {
    if (targetAgent) {
      clearTargetAgent();
    }
  });

  focusInput();
  if (screen.program && typeof screen.program.decset === "function") {
    screen.program.decset(2004);
  }
  if (screen.program) {
    screen.program.on("data", (data) => {
      pasteController.handleProgramData(data);
    });
  }
  loadHistory();
  loadInputHistory();
  if (globalMode) {
    inputHistoryController.restoreDraft(getProjectDraft(activeProjectRoot));
  }
  if (globalMode) {
    refreshProjectRuntimes();
  }
  renderDashboard();
  resizeInput();
  requestStatus();

  // 定期刷新 dashboard 状态（兜底，daemon 会主动推送变化）
  setInterval(() => {
    if (daemonCoordinator && daemonCoordinator.isConnected()) {
      requestStatus();
    }
  }, 5000);

  // Global mode: watch runtime registry for new/removed projects
  if (globalMode) {
    const runtimeDir = resolveRuntimeDir();
    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true });
    }
    let runtimeWatchDebounce = null;
    try {
      const watcher = fs.watch(runtimeDir, () => {
        if (runtimeWatchDebounce) return;
        runtimeWatchDebounce = setTimeout(() => {
          runtimeWatchDebounce = null;
          const prevCount = projectRuntimes.length;
          refreshProjectRuntimes();
          if (projectRuntimes.length !== prevCount) {
            renderDashboard();
            screen.render();
          }
        }, 300);
      });
      screen.on("destroy", () => watcher.close());
    } catch {
      // Fallback: ignore if fs.watch not supported
    }
  }
  screen.on("resize", () => {
    if (handleResizeInAgentView()) {
      return;
    }
    resizeInput();
    if (completionController.isActive()) completionController.hide();
    input._updateCursor();
    // Force recalculate logBox width to match terminal
    logBox.width = screen.width;
    screen.render();
  });
  screen.render();
}

module.exports = { runChat };

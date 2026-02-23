const path = require("path");
const blessed = require("blessed");
const { execSync } = require("child_process");
const fs = require("fs");
const {
  loadConfig,
  saveConfig,
  normalizeLaunchMode,
  normalizeAgentProvider,
  normalizeAssistantEngine,
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
const { createCronScheduler } = require("./cronScheduler");
const { createAgentViewController } = require("./agentViewController");
const { createSettingsController } = require("./settingsController");
const { createChatLayout } = require("./layout");
const { createDaemonCoordinator } = require("./daemonCoordinator");
const { IPC_REQUEST_TYPES } = require("../shared/eventContract");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");
const { createDaemonTransport } = require("./daemonTransport");

async function runChat(projectRoot) {
  if (!fs.existsSync(getUfooPaths(projectRoot).ufooDir)) {
    const repoRoot = path.join(__dirname, "..", "..");
    const init = new UfooInit(repoRoot);
    await init.init({ modules: "context,bus", project: projectRoot });
  }

  // Ensure subscriber ID exists for chat (persistent across restarts)
  if (!process.env.UFOO_SUBSCRIBER_ID) {
    const crypto = require("crypto");
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
  let assistantEngine = normalizeAssistantEngine(config.assistantEngine);
  let autoResume = config.autoResume !== false;
  let cronScheduler = {
    addTask: () => null,
    listTasks: () => [],
    stopTask: () => false,
    stopAll: () => 0,
  };

  // Dynamic input height settings
  // Layout: topLine(1) + content + bottomLine(1) + dashboard(1)
  const MIN_INPUT_HEIGHT = 4;  // 1 content + 3
  const MAX_INPUT_HEIGHT = 9;  // 6 content + 3
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
    version: pkg.version,
  });

  const historyDir = path.join(getUfooPaths(projectRoot).ufooDir, "chat");
  const historyFile = path.join(historyDir, "history.jsonl");
  const inputHistoryFile = path.join(historyDir, "input-history.jsonl");

  const chatLogController = createChatLogController({
    logBox,
    fsModule: fs,
    historyDir,
    historyFile,
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
    inputHistoryFile,
    historyDir,
    setInputValue,
    getInputValue: () => input.value || "",
  });

  function historyUp() {
    if (!inputHistoryController) return false;
    return inputHistoryController.historyUp();
  }

  function historyDown() {
    if (!inputHistoryController) return false;
    return inputHistoryController.historyDown();
  }

  function exitHandler() {
    if (daemonCoordinator) {
      daemonCoordinator.markExit();
    }
    cronScheduler.stopAll();
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
    const contentHeight = Math.min(MAX_INPUT_HEIGHT - 3, Math.max(1, numLines));
    const targetHeight = contentHeight + 3; // +1 topLine +1 bottomLine +1 dashboard

    if (targetHeight !== currentInputHeight) {
      currentInputHeight = targetHeight;
      input.height = contentHeight;
      promptBox.height = contentHeight;
      inputTopLine.bottom = currentInputHeight - 1;  // Just above input area
    }
    statusLine.bottom = currentInputHeight;
    // Reposition completion panel if active
    if (completionController.isActive()) completionController.reflow();
    // dashboard and inputBottomLine stay fixed at bottom 0 and 1
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
    const contentHeight = 1; // MIN content height
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
  let agentListWindowStart = 0;
  const MAX_AGENT_WINDOW = 4;
  let selectedAgentIndex = -1;  // -1 = not in dashboard selection mode
  let targetAgent = null;       // Selected agent for direct messaging
  let focusMode = "input";      // "input" or "dashboard"
  let dashboardView = "agents"; // "agents" | "mode" | "provider" | "assistant" | "cron"
  let reportPendingTotal = 0;
  let selectedModeIndex = launchMode === "internal" ? 2 : (launchMode === "tmux" ? 1 : 0);
  const providerOptions = [
    { label: "codex", value: "codex-cli" },
    { label: "claude", value: "claude-cli" },
    { label: "ucode", value: "ucode" },
  ];
  let selectedProviderIndex = Math.max(0, providerOptions.findIndex((opt) => opt.value === agentProvider));
  const assistantOptions = [
    { label: "auto", value: "auto" },
    { label: "codex", value: "codex" },
    { label: "claude", value: "claude" },
    { label: "ucode", value: "ufoo" },
  ];
  let selectedAssistantIndex = Math.max(
    0,
    assistantOptions.findIndex((opt) => opt.value === assistantEngine)
  );
  const resumeOptions = [
    { label: "Resume previous session", value: true },
    { label: "Start new session", value: false },
  ];
  let selectedResumeIndex = autoResume ? 0 : 1;
  const DASH_HINTS = {
    agents: "←/→ select · Enter · ↓ mode · ↑ back",
    agentsEmpty: "↓ mode · ↑ back",
    mode: "←/→ select · Enter · ↓ provider · ↑ back",
    provider: "←/→ select · Enter · ↓ assistant · ↑ back",
    assistant: "←/→ select · Enter · ↓ cron · ↑ back",
    cron: "Ctrl+X close · ↑ back",
    resume: "",
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
    return terminalAdapterRouter.getAdapter({ launchMode: agentLaunchMode, agentId });
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
          const busPath = getUfooPaths(projectRoot).agentsFile;
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
          const busPath = getUfooPaths(projectRoot).agentsFile;
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

  function send(req) {
    if (!daemonCoordinator) return;
    daemonCoordinator.send(req);
  }

  cronScheduler = createCronScheduler({
    dispatch: ({ taskId, target, message }) => {
      send({
        type: IPC_REQUEST_TYPES.BUS_SEND,
        target,
        message,
      });
      queueStatusLine(`cron:${taskId} -> ${target}`);
    },
    onChange: () => {
      renderDashboard();
      screen.render();
    },
  });

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
    const label = getAgentLabel(agentId);
    logMessage("status", `{white-fg}⚙{/white-fg} Closing ${label}...`);
    send({ type: IPC_REQUEST_TYPES.CLOSE_AGENT, agent_id: agentId });
  }

  function setAgentProvider(provider) {
    if (settingsController) {
      settingsController.setAgentProvider(provider);
    }
  }

  function setAssistantEngine(value) {
    if (settingsController) {
      settingsController.setAssistantEngine(value);
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
    normalizeAssistantEngine,
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
    getAssistantEngine: () => assistantEngine,
    setAssistantEngineState: (value) => {
      assistantEngine = value;
    },
    setSelectedAssistantIndex: (value) => {
      selectedAssistantIndex = value;
    },
    assistantOptions,
    providerOptions,
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
      focusMode,
      dashboardView,
      activeAgents,
      selectedAgentIndex,
      agentListWindowStart,
      maxAgentWindow: MAX_AGENT_WINDOW,
      getAgentLabel,
      launchMode,
      agentProvider,
      assistantEngine,
      autoResume,
      selectedModeIndex,
      selectedProviderIndex,
      selectedAssistantIndex,
      selectedResumeIndex,
      cronTasks: cronScheduler.listTasks(),
      providerOptions,
      assistantOptions,
      resumeOptions,
      pendingReports: reportPendingTotal,
      dashHints: DASH_HINTS,
    });
    agentListWindowStart = computed.windowStart;
    dashboard.setContent(computed.content);
  }

  function updateDashboard(status) {
    activeAgents = status.active || [];
    reportPendingTotal = Number.isFinite(status?.reports?.pending_total)
      ? status.reports.pending_total
      : 0;
    const metaList = Array.isArray(status.active_meta) ? status.active_meta : [];
    let fallbackMap = null;
    if (metaList.length === 0 && activeAgents.length > 0) {
      try {
        const busPath = getUfooPaths(projectRoot).agentsFile;
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
    activeAgentMetaMap = maps.metaMap;
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
    dashboardView = "agents";
    selectedAgentIndex = activeAgents.length > 0 ? 0 : -1;
    agentListWindowStart = 0;
    clampAgentWindow();
    selectedModeIndex = launchMode === "internal" ? 2 : (launchMode === "tmux" ? 1 : 0);
    selectedProviderIndex = Math.max(0, providerOptions.findIndex((opt) => opt.value === agentProvider));
    selectedAssistantIndex = Math.max(
      0,
      assistantOptions.findIndex((opt) => opt.value === assistantEngine)
    );
    selectedResumeIndex = autoResume ? 0 : 1;
    // Immediately set @target when first agent is selected
    if (selectedAgentIndex >= 0 && selectedAgentIndex < activeAgents.length) {
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
    selectedAgentIndex: { get: () => selectedAgentIndex, set: (value) => { selectedAgentIndex = value; } },
    activeAgents: { get: () => activeAgents },
    viewingAgent: { get: () => getViewingAgent() },
    activeAgentMetaMap: { get: () => activeAgentMetaMap },
    selectedModeIndex: { get: () => selectedModeIndex, set: (value) => { selectedModeIndex = value; } },
    selectedProviderIndex: { get: () => selectedProviderIndex, set: (value) => { selectedProviderIndex = value; } },
    selectedAssistantIndex: { get: () => selectedAssistantIndex, set: (value) => { selectedAssistantIndex = value; } },
    selectedResumeIndex: { get: () => selectedResumeIndex, set: (value) => { selectedResumeIndex = value; } },
    launchMode: { get: () => launchMode },
    agentProvider: { get: () => agentProvider },
    assistantEngine: { get: () => assistantEngine },
    autoResume: { get: () => autoResume },
    cronTasks: { get: () => cronScheduler.listTasks() },
    providerOptions: { get: () => providerOptions },
    assistantOptions: { get: () => assistantOptions },
    resumeOptions: { get: () => resumeOptions },
    agentOutputSuppressed: {
      get: () => getAgentOutputSuppressed(),
      set: (value) => { setAgentOutputSuppressed(value); },
    },
  });

  function activateAgent(agentId) {
    if (!agentId) return;
    const activator = new AgentActivator(projectRoot);
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
    setAssistantEngine,
    setAutoResume,
    clampAgentWindow,
    clampAgentWindowWithSelection,
    renderDashboard,
    renderAgentDashboard,
    renderScreen: () => screen.render(),
    setScreenGrabKeys: (value) => {
      screen.grabKeys = Boolean(value);
    },
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
    dashboardView = "agents";
    selectedAgentIndex = -1;
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
    return path.join(getUfooPaths(projectRoot).busQueuesDir, safeName, "inject.sock");
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
    if (!isRunning(projectRoot)) {
      const logFile = getUfooPaths(projectRoot).ufooDaemonLog;
      // eslint-disable-next-line no-console
      console.error("Failed to start ufoo daemon. Check logs at:", logFile);
      throw new Error("Daemon failed to start. Check the daemon log for details.");
    }
    throw new Error("Failed to connect to ufoo daemon (timeout). The daemon may still be starting.");
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
    createCronTask: ({ intervalMs, targets, prompt }) =>
      cronScheduler.addTask({ intervalMs, targets, prompt }),
    listCronTasks: () => cronScheduler.listTasks(),
    stopCronTask: (id) => cronScheduler.stopTask(id),
    activateAgent: async (target) => {
      const activator = new AgentActivator(projectRoot);
      await activator.activate(target);
    },
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
      const activator = new AgentActivator(projectRoot);
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
  renderDashboard();
  resizeInput();
  requestStatus();

  // Auto-connect to target agent if specified via ufoo resume
  if (process.env.UFOO_RESUME_TARGET) {
    const resumeTarget = process.env.UFOO_RESUME_TARGET;

    // Wait a bit for agents to be populated from daemon
    setTimeout(() => {
      // Find the agent in activeAgents list
      const targetIndex = activeAgents.findIndex(id => id === resumeTarget);

      if (targetIndex >= 0) {
        // Set the target agent for @ messaging
        targetAgent = resumeTarget;
        selectedAgentIndex = targetIndex;

        // Update UI to show connection
        const meta = activeAgentMetaMap.get(resumeTarget);
        const nickname = meta?.nickname || resumeTarget;
        logMessage("system", `{cyan-fg}Connected to @${nickname}{/cyan-fg}`);

        // Focus input and show @ prefix
        updatePromptBox();
        renderDashboard();
        focusInput();
        screen.render();
      } else {
        logMessage("error", `{red-fg}Failed to connect: Agent ${resumeTarget} not found{/red-fg}`);
      }

      // Clear the environment variable to avoid reconnecting on reload
      delete process.env.UFOO_RESUME_TARGET;
    }, 500);
  }

  // 定期刷新 dashboard 状态（兜底，daemon 会主动推送变化）
  setInterval(() => {
    if (daemonCoordinator && daemonCoordinator.isConnected()) {
      requestStatus();
    }
  }, 30000);
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

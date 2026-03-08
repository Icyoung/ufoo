function createAgentViewController(options = {}) {
  const {
    screen,
    input,
    processStdout = process.stdout,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
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
    sendResize = () => {},
    requestScreenSnapshot = () => {},
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
  const originalRender = screen.render.bind(screen);
  let renderFrozen = false;

  screen.render = function wrappedRender() {
    if (renderFrozen) return;
    return originalRender();
  };

  function getRows() {
    return processStdout.rows || 24;
  }

  function getCols() {
    return processStdout.columns || 80;
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
    if (currentView === "agent") {
      disconnectAgentOutput();
      disconnectAgentInput();
    }

    currentView = "agent";
    viewingAgent = agentId;
    setFocusMode("input");

    detachedChildren = [...screen.children];
    for (const child of detachedChildren) screen.remove(child);

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
    if (!agentViewUsesBus) {
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
    agentViewUsesBus = false;
    agentOutputSuppressed = false;
    agentBarVisible = false;

    currentView = "main";
    viewingAgent = null;

    processStdout.write(`\x1b[1;${rows}r`);
    processStdout.write("\x1b[2J\x1b[H");

    if (detachedChildren) {
      for (const child of detachedChildren) screen.append(child);
      detachedChildren = null;
    }

    renderFrozen = false;
    setFocusMode("input");
    setDashboardView("agents");
    setSelectedAgentIndex(-1);
    setScreenGrabKeys(false);
    if (typeof screen.alloc === "function") {
      screen.alloc();
    }
    clearTargetAgent();
    renderDashboard();
    focusInput();
    resizeInput();
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
    renderAgentDashboard();
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
  };
}

module.exports = {
  createAgentViewController,
};

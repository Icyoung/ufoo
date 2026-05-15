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
    sendBusMessage = () => {},
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
  let busInputValue = "";
  let busInputCursor = 0;
  let busLogLines = [];
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

  function stripAnsi(text = "") {
    return String(text || "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }

  function clamp(value, min, max) {
    const normalized = Number.isFinite(value) ? Math.floor(value) : min;
    return Math.max(min, Math.min(max, normalized));
  }

  function fitText(text = "", width = 1) {
    const normalizedWidth = Math.max(1, width);
    const clean = stripAnsi(String(text || "")).replace(/\r/g, "");
    if (clean.length <= normalizedWidth) {
      return clean + " ".repeat(normalizedWidth - clean.length);
    }
    if (normalizedWidth <= 1) return clean.slice(0, normalizedWidth);
    return clean.slice(0, normalizedWidth - 1) + "…";
  }

  function horizontalLine(width = 80) {
    return "─".repeat(Math.max(1, width));
  }

  function plainLine(text = "", width = 80) {
    return fitText(text, Math.max(1, width));
  }

  function wrapTextLine(text = "", width = 80) {
    const inner = Math.max(1, width);
    const clean = stripAnsi(String(text || ""));
    if (!clean) return [""];
    const lines = [];
    let rest = clean;
    while (rest.length > inner) {
      lines.push(rest.slice(0, inner));
      rest = rest.slice(inner);
    }
    lines.push(rest);
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

  function resetBusView(agentId) {
    busInputValue = "";
    busInputCursor = 0;
    const label = getAgentLabel(agentId);
    busLogLines = [
      `ufoo internal · ${label}`,
      "",
    ];
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
    if (busLogLines.length > 1000) {
      busLogLines = busLogLines.slice(-1000);
    }
  }

  function getBusInputViewport(width) {
    const inner = Math.max(1, width - 4);
    const value = String(busInputValue || "").replace(/\n/g, "⏎");
    let start = 0;
    if (busInputCursor >= inner) {
      start = busInputCursor - inner + 1;
    }
    return {
      text: value.slice(start, start + inner),
      cursorCol: Math.max(0, busInputCursor - start),
    };
  }

  function renderBusView() {
    if (currentView !== "agent" || !agentViewUsesBus) return;
    const rows = getRows();
    const cols = getCols();
    const width = Math.max(20, cols);
    const inputTop = Math.max(4, rows - 3);
    const logContentTop = 1;
    const logContentBottom = Math.max(logContentTop, inputTop - 1);
    const logContentHeight = Math.max(1, logContentBottom - logContentTop + 1);

    processStdout.write("\x1b[?25l");
    const visibleLines = getWrappedBusLogLines(width).slice(-logContentHeight);
    for (let i = 0; i < logContentHeight; i += 1) {
      writeAt(logContentTop + i, plainLine(visibleLines[i] || "", width));
    }

    writeAt(inputTop, horizontalLine(width));
    const viewport = getBusInputViewport(width);
    writeAt(inputTop + 1, plainLine(`> ${viewport.text}`, width));
    writeAt(inputTop + 2, horizontalLine(width));

    renderAgentDashboard();
    const cursorCol = clamp(3 + viewport.cursorCol, 1, width);
    processStdout.write(`\x1b[${inputTop + 1};${cursorCol}H\x1b[?25h`);
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
    if (agentViewUsesBus) {
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
    agentViewUsesBus = false;
    agentOutputSuppressed = false;
    agentBarVisible = false;
    busInputValue = "";
    busInputCursor = 0;
    busLogLines = [];

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

  function insertBusInput(text = "") {
    const value = String(text || "");
    if (!value) return;
    busInputValue = busInputValue.slice(0, busInputCursor) + value + busInputValue.slice(busInputCursor);
    busInputCursor += value.length;
    renderBusView();
  }

  function deleteBusInputBeforeCursor() {
    if (busInputCursor <= 0) return;
    busInputValue = busInputValue.slice(0, busInputCursor - 1) + busInputValue.slice(busInputCursor);
    busInputCursor -= 1;
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
      busInputCursor = Math.max(0, busInputCursor - 1);
      renderBusView();
      return true;
    }
    if (keyName === "right") {
      busInputCursor = Math.min(busInputValue.length, busInputCursor + 1);
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
        busInputValue = busInputValue.slice(0, busInputCursor) + busInputValue.slice(busInputCursor + 1);
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
      appendBusLog(cleaned);
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
    handleBusAgentKey,
  };
}

module.exports = {
  createAgentViewController,
};

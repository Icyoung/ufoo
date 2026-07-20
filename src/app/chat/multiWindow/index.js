const { calculatePaneLayout } = require("./paneLayout");
const { createPaneManager } = require("./paneManager");
const { createRenderer } = require("./renderer");

// Pane output bursts are coalesced into short batches; full chrome repaints
// are throttled with a trailing frame so the final state always renders.
const PANE_OUTPUT_BATCH_MS = 50;
const RENDER_ALL_MIN_INTERVAL_MS = 100;

function createMultiWindowController(options = {}) {
  const {
    processStdout = process.stdout,
    getRows = () => process.stdout.rows || 24,
    getCols = () => process.stdout.columns || 80,
    getInjectSockPath = () => "",
    getActiveAgents = () => [],
    getAgentPaneOptions = () => ({}),
    getChatLogLines = () => [],
    getStatusText = () => "",
    getPromptPrefix = () => "› ",
    getCurrentDraft = () => "",
    getCursorPos = () => 0,
    getCompletions = () => ({ items: [], index: -1, windowStart: 0, pageSize: 8 }),
    getAgentLabel = (id) => id,
    getInternalPaneInfo = () => ({}),
    getDashboardLines = () => [],
    getTerminalFocused = () => false,
    freezeScreen = () => {},
    restoreTerminal = () => {},
    onExit = () => {},
    onFocusAgent = () => {},
    onInternalSubmit = () => {},
  } = options;

  let active = false;
  let renderThrottleTimer = null;
  let dirtyPanes = new Set();
  let renderAllTimer = null;
  let renderAllTrailing = false;
  let lastRenderAllAt = 0;
  let lastCompletionPopup = null;
  const renderer = createRenderer({ write: (d) => processStdout.write(d) });
  const paneManager = createPaneManager({
    getInjectSockPath,
    onInternalSubmit,
    onPaneOutput: (agentId) => {
      if (!active) return;
      dirtyPanes.add(agentId);
      if (!renderThrottleTimer) {
        renderThrottleTimer = setTimeout(() => {
          renderThrottleTimer = null;
          const panes = [...dirtyPanes];
          dirtyPanes.clear();
          for (const id of panes) renderSinglePane(id);
        }, PANE_OUTPUT_BATCH_MS);
      }
    },
  });

  function enter() {
    const agents = getActiveAgents();
    if (agents.length === 0) return false;
    if (active) return false;
    active = true;
    freezeScreen(true);
    renderer.hideCursor();
    renderer.clear();
    syncAgents();
    renderAllNow();
    return true;
  }

  function exit() {
    if (!active) return;
    active = false;
    if (renderThrottleTimer) {
      clearTimeout(renderThrottleTimer);
      renderThrottleTimer = null;
      dirtyPanes.clear();
    }
    if (renderAllTimer) {
      clearTimeout(renderAllTimer);
      renderAllTimer = null;
      renderAllTrailing = false;
    }
    paneManager.disconnectAll();
    renderer.showCursor();
    restoreTerminal();
    freezeScreen(false);
    onExit();
  }

  function syncAgents() {
    const agents = getActiveAgents();
    const current = new Set(paneManager.getAgentIds());
    const layout = calculatePaneLayout(getCols(), getRows(), agents.length);

    for (let i = 0; i < agents.length; i++) {
      const id = agents[i];
      const pane = layout.agentPanes[i];
      if (!pane) continue;
      const innerW = Math.max(1, pane.width - 2);
      const innerH = Math.max(1, pane.height - 2);
      if (!current.has(id)) {
        paneManager.addAgent(id, innerW, innerH, getAgentPaneOptions(id) || {});
      } else {
        paneManager.sendResize(id, innerW, innerH);
      }
    }
    for (const id of current) {
      if (!agents.includes(id)) {
        paneManager.removeAgent(id);
      }
    }
  }

  function renderSinglePane(agentId) {
    if (!active) return;
    try {
      const agents = paneManager.getAgentIds();
      const layout = calculatePaneLayout(getCols(), getRows(), agents.length);
      const idx = agents.indexOf(agentId);
      if (idx < 0 || !layout.agentPanes[idx]) return;
      const pane = paneManager.getPane(agentId);
      if (!pane) return;
      const isFocused = getTerminalFocused() && agentId === paneManager.getFocused();
      if (pane.mode === "internal" && typeof renderer.renderInternalPane === "function") {
        renderer.renderInternalPane(pane.vt, layout.agentPanes[idx], isFocused, {
          label: getAgentLabel(agentId),
          ...(getInternalPaneInfo(agentId) || {}),
          input: pane.internalInput || "",
          cursor: pane.internalCursor || 0,
        });
      } else {
        renderer.renderPane(pane.vt, layout.agentPanes[idx], isFocused, getAgentLabel(agentId));
      }
    } catch {
      // swallow render errors to prevent crash
    }
  }

  function renderAllNow() {
    if (!active) return;
    lastRenderAllAt = Date.now();
    try {
      const agents = paneManager.getAgentIds();
      const layout = calculatePaneLayout(getCols(), getRows(), agents.length);
      const cols = getCols();

      // Resolve the completion popup up front so stale rows are cleared
      // before anything repaints (clearing also invalidates renderer caches).
      const cmp = getCompletions();
      let nextCompletionPopup = null;
      let nextCompletionItems = null;
      let nextCompletionStart = 0;
      if (cmp && Array.isArray(cmp.items) && cmp.items.length > 0 && layout.inputPane) {
        const start = Math.min(cmp.windowStart || 0, Math.max(0, cmp.items.length - (cmp.pageSize || 8)));
        const end = Math.min(cmp.items.length, start + (cmp.pageSize || 8));
        const visible = cmp.items.slice(start, end);
        const popupTop = layout.inputPane.top - visible.length - 1;
        if (popupTop >= 0) {
          nextCompletionPopup = { top: popupTop, left: 0, width: cols, height: visible.length + 1 };
          nextCompletionItems = visible;
          nextCompletionStart = start;
        }
      }
      const prevPopup = lastCompletionPopup;
      const samePopupRect = prevPopup && nextCompletionPopup &&
        prevPopup.top === nextCompletionPopup.top &&
        prevPopup.width === nextCompletionPopup.width &&
        prevPopup.height === nextCompletionPopup.height &&
        (prevPopup.left || 0) === (nextCompletionPopup.left || 0);
      if (prevPopup && !samePopupRect && typeof renderer.clearRows === "function") {
        renderer.clearRows(prevPopup.top, prevPopup.height, prevPopup.width, prevPopup.left || 0);
      }

      renderer.renderChatLog(layout.chatPane, getChatLogLines());

      const focused = getTerminalFocused() ? paneManager.getFocused() : null;
      for (let i = 0; i < agents.length; i++) {
        const pane = paneManager.getPane(agents[i]);
        if (!pane || !layout.agentPanes[i]) continue;
        if (pane.mode === "internal" && typeof renderer.renderInternalPane === "function") {
          renderer.renderInternalPane(pane.vt, layout.agentPanes[i], agents[i] === focused, {
            label: getAgentLabel(agents[i]),
            ...(getInternalPaneInfo(agents[i]) || {}),
            input: pane.internalInput || "",
            cursor: pane.internalCursor || 0,
          });
        } else {
          renderer.renderPane(pane.vt, layout.agentPanes[i], agents[i] === focused, getAgentLabel(agents[i]));
        }
      }

      const chatFocused = !getTerminalFocused();
      if (layout.separatorPane) {
        renderer.renderSeparator(layout.separatorPane, chatFocused);
      }
      if (layout.statusPane) {
        renderer.renderStatusLine(layout.statusPane, getStatusText());
      }
      if (layout.inputPane) {
        renderer.renderInputPrompt(layout.inputPane, getPromptPrefix(), getCurrentDraft(), getCursorPos());
      }
      if (layout.inputSepPane) {
        renderer.renderSeparator(layout.inputSepPane, chatFocused);
      }
      if (layout.dashboardPane) {
        const lines = getDashboardLines();
        renderer.renderDashboard(layout.dashboardPane, lines);
      }

      if (nextCompletionPopup && nextCompletionItems) {
        const popupTop = nextCompletionPopup.top;
        renderer.renderSeparator({ top: popupTop, left: 0, width: cols });
        for (let i = 0; i < nextCompletionItems.length; i++) {
          const idx = nextCompletionStart + i;
          const selected = idx === cmp.index;
          const label = nextCompletionItems[i].label || "";
          const desc = nextCompletionItems[i].description || "";
          const line = selected
            ? `\x1b[7;36m${label}\x1b[0m  \x1b[90m${desc}\x1b[0m`
            : `\x1b[90m${label}  ${desc}\x1b[0m`;
          const pad = Math.max(0, cols - renderer.visibleLength(line));
          renderer.write(renderer.moveTo(popupTop + 1 + i, 0) + line + " ".repeat(pad) + "\x1b[0m");
        }
      }
      lastCompletionPopup = nextCompletionPopup;
    } catch {
      // swallow render errors to prevent crash
    }
  }

  // Throttled entry point for external callers: renders immediately when idle,
  // otherwise coalesces bursts into one trailing frame so state stays consistent.
  function renderAll() {
    if (!active) return;
    const elapsed = Date.now() - lastRenderAllAt;
    if (!renderAllTimer && elapsed >= RENDER_ALL_MIN_INTERVAL_MS) {
      renderAllNow();
      return;
    }
    renderAllTrailing = true;
    if (!renderAllTimer) {
      renderAllTimer = setTimeout(() => {
        renderAllTimer = null;
        if (!renderAllTrailing) return;
        renderAllTrailing = false;
        renderAllNow();
      }, Math.max(RENDER_ALL_MIN_INTERVAL_MS - elapsed, 16));
      if (typeof renderAllTimer.unref === "function") renderAllTimer.unref();
    }
  }

  function handleKey(key) {
    if (!active) return false;

    if (key.name === "c" && key.ctrl) {
      return false;
    }

    if (key.name === "w" && key.ctrl) {
      paneManager.cycleFocus();
      renderAllNow();
      return true;
    }

    if (key.name === "q" && key.ctrl) {
      exit();
      return true;
    }

    return false;
  }

  function focusAgent(agentId) {
    if (!active) return;
    const agents = paneManager.getAgentIds();
    if (!agents.includes(agentId)) return;
    paneManager.setFocused(agentId);
    onFocusAgent(agentId);
    renderAllNow();
  }

  function handleResize() {
    if (!active) return;
    syncAgents();
    renderer.clear();
    renderAllNow();
  }

  function isActive() { return active; }

  return {
    enter,
    exit,
    isActive,
    handleKey,
    handleResize,
    syncAgents,
    renderAll,
    focusAgent,
    sendInput: (data) => paneManager.sendInput(data),
    writeToPane: (agentId, data) => paneManager.writeToPane(agentId, data),
    getFocused: () => paneManager.getFocused(),
    getAgentIds: () => paneManager.getAgentIds(),
  };
}

module.exports = { createMultiWindowController };

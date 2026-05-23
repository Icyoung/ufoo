const { calculatePaneLayout } = require("./paneLayout");
const { createPaneManager } = require("./paneManager");
const { createRenderer } = require("./renderer");

function createMultiWindowController(options = {}) {
  const {
    processStdout = process.stdout,
    getRows = () => process.stdout.rows || 24,
    getCols = () => process.stdout.columns || 80,
    getInjectSockPath = () => "",
    getActiveAgents = () => [],
    getChatLogLines = () => [],
    onExit = () => {},
  } = options;

  let active = false;
  const renderer = createRenderer({ write: (d) => processStdout.write(d) });
  const paneManager = createPaneManager({
    getInjectSockPath,
    onPaneOutput: (agentId) => { if (active) renderSinglePane(agentId); },
  });

  function enter() {
    if (active) return;
    active = true;
    renderer.hideCursor();
    renderer.clear();
    syncAgents();
    renderAll();
  }

  function exit() {
    if (!active) return;
    active = false;
    paneManager.disconnectAll();
    renderer.showCursor();
    renderer.clear();
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
        paneManager.addAgent(id, innerW, innerH);
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
    const agents = paneManager.getAgentIds();
    const layout = calculatePaneLayout(getCols(), getRows(), agents.length);
    const idx = agents.indexOf(agentId);
    if (idx < 0 || !layout.agentPanes[idx]) return;
    const pane = paneManager.getPane(agentId);
    if (!pane) return;
    const focused = paneManager.getFocused() === agentId;
    renderer.renderPane(pane.vt, layout.agentPanes[idx], focused, agentId);
  }

  function renderAll() {
    if (!active) return;
    const agents = paneManager.getAgentIds();
    const layout = calculatePaneLayout(getCols(), getRows(), agents.length);

    renderer.renderChatLog(layout.chatPane, getChatLogLines());

    for (let i = 0; i < agents.length; i++) {
      const pane = paneManager.getPane(agents[i]);
      if (!pane || !layout.agentPanes[i]) continue;
      const focused = paneManager.getFocused() === agents[i];
      renderer.renderPane(pane.vt, layout.agentPanes[i], focused, agents[i]);
    }
  }

  function handleKey(key) {
    if (!active) return false;

    if (key.name === "w" && key.ctrl) {
      paneManager.cycleFocus();
      renderAll();
      return true;
    }

    if (key.name === "q" && key.ctrl) {
      exit();
      return true;
    }

    if (key.sequence) {
      paneManager.sendInput(key.sequence);
      return true;
    }

    return false;
  }

  function handleResize() {
    if (!active) return;
    syncAgents();
    renderer.clear();
    renderAll();
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
  };
}

module.exports = { createMultiWindowController };

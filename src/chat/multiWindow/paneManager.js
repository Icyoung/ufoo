const net = require("net");
const { PTY_SOCKET_MESSAGE_TYPES, PTY_SOCKET_SUBSCRIBE_MODES } = require("../../shared/ptySocketContract");
const { createVirtualTerminal } = require("./virtualTerminal");

function createPaneManager(options = {}) {
  const {
    getInjectSockPath = () => "",
    onPaneOutput = () => {},
  } = options;

  const panes = new Map();
  let focusedAgent = null;

  function addAgent(agentId, cols, rows) {
    if (panes.has(agentId)) return;
    const vt = createVirtualTerminal(cols, rows);
    const pane = { agentId, vt, outputClient: null, inputClient: null, buffer: "" };
    panes.set(agentId, pane);
    connectOutput(pane);
    if (!focusedAgent) focusedAgent = agentId;
  }

  function removeAgent(agentId) {
    const pane = panes.get(agentId);
    if (!pane) return;
    disconnect(pane);
    panes.delete(agentId);
    if (focusedAgent === agentId) {
      const keys = [...panes.keys()];
      focusedAgent = keys.length > 0 ? keys[0] : null;
    }
  }

  function connectOutput(pane) {
    const sockPath = getInjectSockPath(pane.agentId);
    if (!sockPath) return;

    try {
      const client = net.createConnection(sockPath, () => {
        client.write(JSON.stringify({
          type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE,
          mode: PTY_SOCKET_SUBSCRIBE_MODES.FULL,
        }) + "\n");
      });

      client.on("data", (data) => {
        pane.buffer += data.toString("utf8");
        const lines = pane.buffer.split("\n");
        pane.buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === PTY_SOCKET_MESSAGE_TYPES.OUTPUT ||
                msg.type === PTY_SOCKET_MESSAGE_TYPES.REPLAY ||
                msg.type === PTY_SOCKET_MESSAGE_TYPES.SNAPSHOT) {
              if (msg.data) {
                pane.vt.write(msg.data);
                onPaneOutput(pane.agentId);
              }
            }
          } catch {
            // ignore malformed
          }
        }
      });

      client.on("error", () => { pane.outputClient = null; });
      client.on("close", () => { pane.outputClient = null; });
      pane.outputClient = client;
    } catch {
      // connection failed
    }
  }

  function disconnect(pane) {
    if (pane.outputClient) {
      try { pane.outputClient.destroy(); } catch {}
      pane.outputClient = null;
    }
    if (pane.inputClient) {
      try { pane.inputClient.destroy(); } catch {}
      pane.inputClient = null;
    }
  }

  function sendInput(data) {
    if (!focusedAgent) return;
    const pane = panes.get(focusedAgent);
    if (!pane) return;
    const sockPath = getInjectSockPath(pane.agentId);
    if (!sockPath) return;

    if (!pane.inputClient || pane.inputClient.destroyed) {
      try {
        const client = net.createConnection(sockPath);
        pane.inputClient = client;
        client.on("error", () => { pane.inputClient = null; });
        client.on("close", () => { pane.inputClient = null; });
        client.once("connect", () => {
          try {
            client.write(JSON.stringify({
              type: PTY_SOCKET_MESSAGE_TYPES.RAW,
              data,
            }) + "\n");
          } catch {}
        });
      } catch { return; }
      return;
    }

    try {
      pane.inputClient.write(JSON.stringify({
        type: PTY_SOCKET_MESSAGE_TYPES.RAW,
        data,
      }) + "\n");
    } catch {
      pane.inputClient = null;
    }
  }

  function sendResize(agentId, cols, rows) {
    const pane = panes.get(agentId);
    if (!pane) return;
    pane.vt.resize(cols, rows);
    if (pane.outputClient && !pane.outputClient.destroyed) {
      try {
        pane.outputClient.write(JSON.stringify({
          type: PTY_SOCKET_MESSAGE_TYPES.RESIZE,
          cols,
          rows,
        }) + "\n");
      } catch {}
    }
  }

  function cycleFocus() {
    const keys = [...panes.keys()];
    if (keys.length === 0) return;
    const idx = keys.indexOf(focusedAgent);
    focusedAgent = keys[(idx + 1) % keys.length];
    return focusedAgent;
  }

  function getFocused() { return focusedAgent; }
  function setFocused(agentId) { if (panes.has(agentId)) focusedAgent = agentId; }
  function getPane(agentId) { return panes.get(agentId) || null; }
  function getAllPanes() { return [...panes.values()]; }
  function getAgentIds() { return [...panes.keys()]; }

  function disconnectAll() {
    for (const pane of panes.values()) disconnect(pane);
    panes.clear();
    focusedAgent = null;
  }

  return {
    addAgent,
    removeAgent,
    sendInput,
    sendResize,
    cycleFocus,
    getFocused,
    setFocused,
    getPane,
    getAllPanes,
    getAgentIds,
    disconnectAll,
  };
}

module.exports = { createPaneManager };

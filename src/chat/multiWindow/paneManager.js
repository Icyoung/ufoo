const fs = require("fs");
const net = require("net");
const { PTY_SOCKET_MESSAGE_TYPES, PTY_SOCKET_SUBSCRIBE_MODES } = require("../../shared/ptySocketContract");
const { createVirtualTerminal } = require("./virtualTerminal");

function createPaneManager(options = {}) {
  const {
    getInjectSockPath = () => "",
    onPaneOutput = () => {},
    onInternalSubmit = () => {},
  } = options;

  const panes = new Map();
  let focusedAgent = null;

  function addAgent(agentId, cols, rows, options = {}) {
    if (panes.has(agentId)) return;
    const vt = createVirtualTerminal(cols, rows);
    const mode = options.mode === "internal" ? "internal" : "socket";
    const pane = {
      agentId,
      mode,
      vt,
      outputClient: null,
      inputClient: null,
      buffer: "",
      internalInput: "",
      internalCursor: 0,
    };
    panes.set(agentId, pane);
    if (mode === "internal") {
      const initialOutput = Array.isArray(options.initialLines)
        ? options.initialLines.join("\r\n")
        : String(options.initialOutput || "");
      if (initialOutput) pane.vt.write(`${initialOutput}\r\n`);
      onPaneOutput(pane.agentId);
    } else {
      connectOutput(pane);
    }
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
    if (!sockPath || !fs.existsSync(sockPath)) {
      pane.vt.write("\x1b[33m[waiting]\x1b[0m inject.sock not found\r\n");
      onPaneOutput(pane.agentId);
      return;
    }

    try {
      const client = net.createConnection(sockPath, () => {
        const { cols, rows } = pane.vt.getScreen();
        client.write(JSON.stringify({
          type: PTY_SOCKET_MESSAGE_TYPES.RESIZE,
          cols,
          rows,
        }) + "\n");
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
            if (msg.type === PTY_SOCKET_MESSAGE_TYPES.OUTPUT) {
              if (msg.data) {
                pane.vt.write(msg.data);
                onPaneOutput(pane.agentId);
              }
            } else if (msg.type === PTY_SOCKET_MESSAGE_TYPES.REPLAY) {
              if (msg.data) {
                pane.vt.write(msg.data);
                onPaneOutput(pane.agentId);
              }
            } else if (msg.type === PTY_SOCKET_MESSAGE_TYPES.SNAPSHOT) {
              if (msg.data) {
                pane.vt.write(msg.data);
                onPaneOutput(pane.agentId);
              }
            }
          } catch {
            // ignore malformed messages or render errors
          }
        }
      });

      client.on("error", (err) => {
        pane.outputClient = null;
        pane.vt.write(`\r\n\x1b[31m[connection error]\x1b[0m ${err && err.message ? err.message : "socket error"}\r\n`);
        onPaneOutput(pane.agentId);
      });
      client.on("close", () => {
        pane.outputClient = null;
        pane.vt.write("\r\n\x1b[33m[disconnected]\x1b[0m\r\n");
        onPaneOutput(pane.agentId);
      });
      pane.outputClient = client;
    } catch (err) {
      pane.vt.write(`\x1b[31m[connection error]\x1b[0m ${err && err.message ? err.message : "connection failed"}\r\n`);
      onPaneOutput(pane.agentId);
    }
  }

  function disconnect(pane) {
    if (pane.outputClient) {
      try {
        pane.outputClient.removeAllListeners();
        pane.outputClient.destroy();
      } catch {}
      pane.outputClient = null;
    }
    if (pane.inputClient) {
      try {
        pane.inputClient.removeAllListeners();
        pane.inputClient.destroy();
      } catch {}
      pane.inputClient = null;
    }
  }

  function sendInput(data) {
    if (!focusedAgent) return;
    const pane = panes.get(focusedAgent);
    if (!pane) return;
    if (pane.mode === "internal") {
      handleInternalInput(pane, data);
      return;
    }
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

  function previousInputBoundary(text = "", cursor = 0) {
    const source = String(text || "");
    const target = Math.max(0, Math.min(source.length, cursor));
    let previous = 0;
    for (const char of Array.from(source)) {
      const next = previous + char.length;
      if (next >= target) break;
      previous = next;
    }
    return previous;
  }

  function handleInternalInput(pane, data) {
    const raw = String(data || "");
    if (!raw) return;
    if (raw === "\r" || raw === "\n") {
      const message = String(pane.internalInput || "").trim();
      pane.internalInput = "";
      pane.internalCursor = 0;
      if (message) {
        pane.vt.write(`\r\n> ${message.replace(/\r?\n/g, "\r\n  ")}\r\n`);
        try { onInternalSubmit(pane.agentId, message); } catch {}
      }
      onPaneOutput(pane.agentId);
      return;
    }
    if (raw === "\x7f" || raw === "\b" || raw === "\x08") {
      if (pane.internalCursor > 0) {
        const start = previousInputBoundary(pane.internalInput, pane.internalCursor);
        pane.internalInput = pane.internalInput.slice(0, start) + pane.internalInput.slice(pane.internalCursor);
        pane.internalCursor = start;
        onPaneOutput(pane.agentId);
      }
      return;
    }
    if (raw === "\x1b[D") {
      pane.internalCursor = previousInputBoundary(pane.internalInput, pane.internalCursor);
      onPaneOutput(pane.agentId);
      return;
    }
    if (raw === "\x1b[C") {
      const tail = pane.internalInput.slice(pane.internalCursor);
      const nextChar = Array.from(tail)[0] || "";
      pane.internalCursor = Math.min(pane.internalInput.length, pane.internalCursor + nextChar.length);
      onPaneOutput(pane.agentId);
      return;
    }
    if (raw === "\x1b[A" || raw === "\x1b[B" || raw === "\t" || raw === "\x1b") return;

    const clean = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
    if (!clean) return;
    pane.internalInput = pane.internalInput.slice(0, pane.internalCursor) + clean + pane.internalInput.slice(pane.internalCursor);
    pane.internalCursor += clean.length;
    onPaneOutput(pane.agentId);
  }

  function sendResize(agentId, cols, rows) {
    const pane = panes.get(agentId);
    if (!pane) return;
    pane.vt.resize(cols, rows);
    if (pane.mode === "internal") return;
    const sockPath = getInjectSockPath(pane.agentId);
    if ((!pane.outputClient || pane.outputClient.destroyed) && sockPath && fs.existsSync(sockPath)) {
      connectOutput(pane);
      return;
    }
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
  function writeToPane(agentId, data) {
    const pane = panes.get(agentId);
    if (!pane) return false;
    pane.vt.write(data);
    onPaneOutput(pane.agentId);
    return true;
  }

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
    writeToPane,
    disconnectAll,
  };
}

module.exports = { createPaneManager };

const { moveCursorVertically, deleteWordBeforeCursor, charDisplayWidth } = require("../../../ui/format");
const { createAgentSurface } = require("../../../ui/agentSurface");

function createPaneManager(options = {}) {
  const {
    onPaneOutput = () => {},
    onInternalSubmit = () => {},
  } = options;

  const panes = new Map();
  let focusedAgent = null;

  function addAgent(agentId, cols, rows, options = {}) {
    if (panes.has(agentId)) return;
    if (options.mode && options.mode !== "internal") throw new Error("Dashboard panes support internal agents only");
    const mode = "internal";
    const surface = options.surface || createAgentSurface();
    const pane = {
      agentId,
      mode,
      surface,
      cols,
      inputCols: cols,
      rows,
      scrollOffset: Number(options.scrollOffset) || 0,
      internalInput: String(options.initialInput || ""),
      internalCursor: Math.max(0, Math.min(String(options.initialInput || "").length, Number(options.initialCursor) || 0)),
    };
    panes.set(agentId, pane);
    const initialOutput = Array.isArray(options.initialLines)
      ? options.initialLines.join("\r\n")
      : String(options.initialOutput || "");
    if (initialOutput && !options.surface) surface.apply("transcript.append", { kind: "system", text: initialOutput });
    onPaneOutput(pane.agentId);
    if (!focusedAgent) focusedAgent = agentId;
  }

  function removeAgent(agentId) {
    const pane = panes.get(agentId);
    if (!pane) return;
    panes.delete(agentId);
    if (focusedAgent === agentId) {
      const keys = [...panes.keys()];
      focusedAgent = keys.length > 0 ? keys[0] : null;
    }
  }

  function sendInput(data) {
    if (!focusedAgent) return;
    sendInputToPane(panes.get(focusedAgent), data);
  }

  function sendInputToAgent(agentId, data) {
    if (!agentId) return;
    sendInputToPane(panes.get(agentId), data);
  }

  function sendInputToPane(pane, data) {
    if (!pane) return;
    handleInternalInput(pane, data);
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
    if (raw === "\r") {
      const message = String(pane.internalInput || "").trim();
      pane.internalInput = "";
      pane.internalCursor = 0;
      if (message) {
        pane.surface.apply("transcript.append", { kind: "user", text: message });
        if (!/^\/multi(?:\s|$)/.test(message)) pane.surface.accept({ type: "task_submitted", message });
        const failed = (error) => {
          pane.surface.accept({ type: "submission_failed", message, error: `Message delivery failed: ${error?.message || error}` });
          if (!pane.internalInput) { pane.internalInput = message; pane.internalCursor = message.length; }
          onPaneOutput(pane.agentId);
        };
        try {
          const result = onInternalSubmit(pane.agentId, message);
          if (result?.catch) result.catch(failed);
        } catch (error) { failed(error); }
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
    if (raw === "\x1b[H" || raw === "\x1b[F") {
      pane.internalCursor = raw === "\x1b[H" ? 0 : pane.internalInput.length;
      onPaneOutput(pane.agentId);
      return;
    }
    if (["\x01", "\x05", "\x15", "\x0b"].includes(raw)) {
      const before = pane.internalInput.slice(0, pane.internalCursor);
      const start = before.lastIndexOf("\n") + 1;
      const nextLine = pane.internalInput.indexOf("\n", pane.internalCursor);
      const end = nextLine < 0 ? pane.internalInput.length : nextLine;
      if (raw === "\x01") pane.internalCursor = start;
      else if (raw === "\x05") pane.internalCursor = end;
      else if (raw === "\x15") {
        pane.internalInput = pane.internalInput.slice(0, start) + pane.internalInput.slice(pane.internalCursor);
        pane.internalCursor = start;
      } else pane.internalInput = before + pane.internalInput.slice(end);
      onPaneOutput(pane.agentId);
      return;
    }
    if (raw === "\x1b[A" || raw === "\x1b[B") {
      const move = moveCursorVertically({ inputValue: pane.internalInput, cursorPos: pane.internalCursor,
        width: pane.inputCols, direction: raw === "\x1b[A" ? "up" : "down",
        strWidth: (text) => Array.from(text).reduce((sum, ch) => sum + charDisplayWidth(ch), 0) });
      pane.internalCursor = move.nextCursorPos;
      onPaneOutput(pane.agentId);
      return;
    }
    if (raw === "\x1b[3~") {
      const next = Array.from(pane.internalInput.slice(pane.internalCursor))[0] || "";
      pane.internalInput = pane.internalInput.slice(0, pane.internalCursor) + pane.internalInput.slice(pane.internalCursor + next.length);
      onPaneOutput(pane.agentId);
      return;
    }
    if (raw === "\x17") {
      const deleted = deleteWordBeforeCursor(pane.internalInput, pane.internalCursor);
      pane.internalInput = deleted.value;
      pane.internalCursor = deleted.cursorPos;
      onPaneOutput(pane.agentId);
      return;
    }
    if (raw === "\t" || raw === "\x1b") return;

    const clean = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
    if (!clean) return;
    pane.internalInput = pane.internalInput.slice(0, pane.internalCursor) + clean + pane.internalInput.slice(pane.internalCursor);
    pane.internalCursor += clean.length;
    onPaneOutput(pane.agentId);
  }

  function sendResize(agentId, cols, rows, inputCols = cols) {
    const pane = panes.get(agentId);
    if (!pane) return;
    pane.cols = cols;
    pane.inputCols = inputCols;
    pane.rows = rows;
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
    pane.surface.accept({ type: "text_delta", delta: String(data || "").replace(/\r\n/g, "\n") });
    onPaneOutput(pane.agentId);
    return true;
  }

  function scrollPane(agentId, lines, maxOffset = 2000) {
    const pane = panes.get(agentId);
    if (!pane) return false;
    pane.scrollOffset = Math.max(0, Math.min(maxOffset, pane.scrollOffset + lines));
    onPaneOutput(agentId);
    return true;
  }

  function disconnectAll() {
    panes.clear();
    focusedAgent = null;
  }

  return {
    addAgent,
    removeAgent,
    sendInput,
    sendInputToAgent,
    sendResize,
    cycleFocus,
    getFocused,
    setFocused,
    getPane,
    getAllPanes,
    getAgentIds,
    writeToPane,
    scrollPane,
    disconnectAll,
  };
}

module.exports = { createPaneManager };

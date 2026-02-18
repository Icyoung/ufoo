const { renderMarkdownLines } = require("../shared/markdownRenderer");

function createStreamTracker(options = {}) {
  const {
    logBox,
    writeSpacer,
    appendHistory,
    escapeBlessed,
    onStreamStart,
    now = () => new Date().toISOString(),
  } = options;

  const streamStates = new Map();
  const pendingDeliveries = new Map();

  function renderLine(line, mdState) {
    const rendered = renderMarkdownLines(line, mdState, escapeBlessed);
    return rendered.length > 0 ? rendered[0] : escapeBlessed(line);
  }

  function buildStreamDisplayText(fullText, prefix, continuationPrefix) {
    const mdState = {};
    const lines = String(fullText || "").split("\n");
    return lines.map((line, i) => {
      const p = i === 0 ? prefix : continuationPrefix;
      return `${p}${renderLine(line, mdState)}`;
    }).join("\n");
  }

  function beginStream(publisher, prefix, continuationPrefix, meta) {
    let state = streamStates.get(publisher);
    if (state) return state;

    if (typeof writeSpacer === "function") {
      writeSpacer();
    }
    logBox.pushLine(prefix);
    state = {
      publisher,
      prefix,
      continuationPrefix,
      lineIndex: logBox.getLines().length - 1,
      buffer: "",
      full: "",
      linesEmitted: 0,
      meta,
      mdState: {},
    };
    streamStates.set(publisher, state);
    if (typeof onStreamStart === "function") {
      onStreamStart();
    }
    return state;
  }

  function appendStreamDelta(state, delta) {
    if (!delta || !state) return;
    state.full += delta;
    state.buffer += delta;
    const parts = state.buffer.split("\n");
    if (parts.length > 1) {
      const completed = parts.slice(0, -1);
      for (const line of completed) {
        const prefix = state.linesEmitted === 0 ? state.prefix : state.continuationPrefix;
        logBox.setLine(state.lineIndex, `${prefix}${renderLine(line, state.mdState)}`);
        state.linesEmitted += 1;
        logBox.pushLine(state.continuationPrefix);
        state.lineIndex = logBox.getLines().length - 1;
      }
      state.buffer = parts[parts.length - 1];
    }
    const prefix = state.linesEmitted === 0 ? state.prefix : state.continuationPrefix;
    // For the current incomplete line, render with a snapshot of mdState
    // to avoid mutating state on partial lines
    const snapState = { inCodeBlock: state.mdState.inCodeBlock };
    logBox.setLine(state.lineIndex, `${prefix}${renderLine(state.buffer, snapState)}`);
  }

  function finalizeStream(publisher, meta, reason = "") {
    const state = streamStates.get(publisher);
    if (!state) return;
    const text = buildStreamDisplayText(state.full, state.prefix, state.continuationPrefix);
    appendHistory({
      ts: now(),
      type: "bus",
      text,
      meta: { ...(meta || {}), stream_done: true, stream_reason: reason },
    });
    streamStates.delete(publisher);
  }

  function hasStream(publisher) {
    return streamStates.has(publisher);
  }

  function markPendingDelivery(agentId, agentLabel) {
    const key = agentId || agentLabel;
    if (!key) return;
    const existing = pendingDeliveries.get(key);
    const state = existing || { count: 0, keys: new Set() };
    state.count += 1;
    if (agentId) {
      pendingDeliveries.set(agentId, state);
      state.keys.add(agentId);
    }
    if (agentLabel && agentLabel !== agentId) {
      pendingDeliveries.set(agentLabel, state);
      state.keys.add(agentLabel);
    }
    if (!agentId && !agentLabel) {
      pendingDeliveries.set(key, state);
      state.keys.add(key);
    }
  }

  function getPendingState(publisher, displayName) {
    if (publisher && pendingDeliveries.has(publisher)) {
      return { key: publisher, state: pendingDeliveries.get(publisher) };
    }
    if (displayName && pendingDeliveries.has(displayName)) {
      return { key: displayName, state: pendingDeliveries.get(displayName) };
    }
    return null;
  }

  function consumePendingDelivery(publisher, displayName) {
    const hit = getPendingState(publisher, displayName);
    if (!hit) return false;
    const state = hit.state;
    state.count -= 1;
    if (state.count <= 0) {
      for (const key of state.keys || []) {
        pendingDeliveries.delete(key);
      }
    }
    return true;
  }

  return {
    beginStream,
    appendStreamDelta,
    finalizeStream,
    hasStream,
    markPendingDelivery,
    getPendingState,
    consumePendingDelivery,
  };
}

module.exports = { createStreamTracker };

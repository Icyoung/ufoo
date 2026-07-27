"use strict";

/**
 * Burst-coalescing sender + chat stream state (Phase 0B extraction from ChatApp).
 */

const { stripBlessedTags } = require("../../ui/chatLogModel");

const STREAM_FLUSH_INTERVAL_MS = 80;

function createThrottledSender(send, windowMs = 500) {
  let lastSentAt = 0;
  let timer = null;
  const fire = () => {
    timer = null;
    lastSentAt = Date.now();
    send();
  };
  return () => {
    const now = Date.now();
    const elapsed = now - lastSentAt;
    if (elapsed >= windowMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastSentAt = now;
      send();
      return;
    }
    if (!timer) {
      timer = setTimeout(fire, windowMs - elapsed);
      if (typeof timer.unref === "function") timer.unref();
    }
  };
}

function createChatStreamState({
  dispatch,
  appendHistory,
  displayNameForPublisher = (value) => value,
  flushIntervalMs = STREAM_FLUSH_INTERVAL_MS,
} = {}) {
  const streams = new Map();
  const pendingDeliveries = new Map();
  const pendingDeltas = new Map();
  let flushTimer = null;

  function flushDeltas() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingDeltas.size === 0) return;
    for (const batch of pendingDeltas.values()) {
      dispatch({
        type: "stream/delta",
        publisher: batch.publisher,
        delta: batch.parts.join(""),
      });
    }
    pendingDeltas.clear();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushDeltas, flushIntervalMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  function deliveryKey(agentId, agentLabel) {
    return String(agentId || agentLabel || "").trim();
  }

  function markPendingDelivery(agentId, agentLabel) {
    const key = deliveryKey(agentId, agentLabel);
    if (!key) return;
    const existing = pendingDeliveries.get(key) || { count: 0, keys: new Set() };
    existing.count += 1;
    for (const candidate of [agentId, agentLabel]) {
      const value = String(candidate || "").trim();
      if (value) {
        pendingDeliveries.set(value, existing);
        existing.keys.add(value);
      }
    }
  }

  function getPendingState(publisher, displayName) {
    for (const candidate of [publisher, displayName]) {
      const key = String(candidate || "").trim();
      if (key && pendingDeliveries.has(key)) {
        return { key, state: pendingDeliveries.get(key) };
      }
    }
    return null;
  }

  function consumePendingDelivery(publisher, displayName) {
    const hit = getPendingState(publisher, displayName);
    if (!hit) return false;
    hit.state.count -= 1;
    if (hit.state.count <= 0) {
      for (const key of hit.state.keys || []) pendingDeliveries.delete(key);
    }
    return true;
  }

  function beginStream(publisher, prefix, continuationPrefix, meta) {
    const key = String(publisher || "bus");
    let state = streams.get(key);
    if (state) return state;
    const displayName = stripBlessedTags(prefix || displayNameForPublisher(key) || key)
      .replace(/\s*·\s*$/, "")
      .trim() || displayNameForPublisher(key) || key;
    state = {
      publisher: key,
      displayName,
      prefix,
      continuationPrefix,
      parts: [],
      meta: meta || {},
    };
    streams.set(key, state);
    dispatch({ type: "stream/begin", publisher: displayName });
    return state;
  }

  function appendStreamDelta(state, delta) {
    if (!state || !delta) return;
    const text = String(delta || "");
    state.parts.push(text);
    let batch = pendingDeltas.get(state.publisher);
    if (!batch) {
      batch = { publisher: state.displayName || state.publisher, parts: [] };
      pendingDeltas.set(state.publisher, batch);
    }
    batch.parts.push(text);
    scheduleFlush();
  }

  function finalizeStream(publisher, meta, reason = "") {
    const key = String(publisher || "bus");
    const state = streams.get(key);
    if (!state) return;
    flushDeltas();
    dispatch({ type: "stream/end" });
    if (typeof appendHistory === "function") {
      const full = state.parts.join("");
      const text = state.displayName
        ? `${state.displayName}: ${full}`
        : full;
      appendHistory("bus", text, { ...(meta || state.meta || {}), stream_done: true, stream_reason: reason });
    }
    streams.delete(key);
  }

  function hasStream(publisher) {
    return streams.has(String(publisher || "bus"));
  }

  return {
    markPendingDelivery,
    getPendingState,
    consumePendingDelivery,
    beginStream,
    appendStreamDelta,
    finalizeStream,
    hasStream,
    flushDeltas,
  };
}

/** @deprecated Prefer createChatStreamState. */
const createInkStreamState = createChatStreamState;

module.exports = {
  STREAM_FLUSH_INTERVAL_MS,
  createThrottledSender,
  createChatStreamState,
  createInkStreamState,
};

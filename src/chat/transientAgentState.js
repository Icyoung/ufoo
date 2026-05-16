"use strict";

const DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS = 8000;

function normalizeNow(now) {
  return Number.isFinite(now) ? now : Date.now();
}

function normalizeSetOptions(nowOrOptions, detailArg = "") {
  if (nowOrOptions && typeof nowOrOptions === "object") {
    return {
      now: normalizeNow(nowOrOptions.now),
      detail: String(nowOrOptions.detail || "").trim(),
    };
  }
  return {
    now: normalizeNow(nowOrOptions),
    detail: String(detailArg || "").trim(),
  };
}

function setTransientAgentState(store, agentId, state, nowOrOptions = Date.now(), detailArg = "") {
  if (!(store instanceof Map)) return;
  const id = String(agentId || "").trim();
  const nextState = String(state || "").trim();
  if (!id || !nextState) return;
  const options = normalizeSetOptions(nowOrOptions, detailArg);
  store.set(id, {
    state: nextState,
    updatedAt: options.now,
    detail: options.detail,
  });
}

function getTransientAgentStateEntry(store, agentId, options = {}) {
  if (!(store instanceof Map)) return null;
  const id = String(agentId || "").trim();
  if (!id) return null;
  const entry = store.get(id);
  if (!entry) return null;

  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.max(0, Math.trunc(options.ttlMs))
    : DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS;
  const now = normalizeNow(options.now);
  const state = typeof entry === "string" ? entry : String(entry.state || "").trim();
  const updatedAt = typeof entry === "object" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : now;
  const detail = typeof entry === "object" ? String(entry.detail || "").trim() : "";

  if (!state) {
    store.delete(id);
    return null;
  }
  if (ttlMs > 0 && now - updatedAt > ttlMs) {
    store.delete(id);
    return null;
  }
  return { state, updatedAt, detail };
}

function getTransientAgentState(store, agentId, options = {}) {
  const entry = getTransientAgentStateEntry(store, agentId, options);
  if (!entry) return "";
  return entry.state;
}

function pruneTransientAgentStates(store, activeAgentIds = [], options = {}) {
  if (!(store instanceof Map)) return;
  const activeSet = new Set(Array.isArray(activeAgentIds) ? activeAgentIds : []);
  for (const id of Array.from(store.keys())) {
    if (!activeSet.has(id)) {
      store.delete(id);
      continue;
    }
    getTransientAgentState(store, id, options);
  }
}

module.exports = {
  DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS,
  setTransientAgentState,
  getTransientAgentStateEntry,
  getTransientAgentState,
  pruneTransientAgentStates,
};

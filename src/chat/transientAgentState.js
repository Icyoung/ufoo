"use strict";

const DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS = 8000;

function normalizeNow(now) {
  return Number.isFinite(now) ? now : Date.now();
}

function setTransientAgentState(store, agentId, state, now = Date.now()) {
  if (!(store instanceof Map)) return;
  const id = String(agentId || "").trim();
  const nextState = String(state || "").trim();
  if (!id || !nextState) return;
  store.set(id, {
    state: nextState,
    updatedAt: normalizeNow(now),
  });
}

function getTransientAgentState(store, agentId, options = {}) {
  if (!(store instanceof Map)) return "";
  const id = String(agentId || "").trim();
  if (!id) return "";
  const entry = store.get(id);
  if (!entry) return "";

  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.max(0, Math.trunc(options.ttlMs))
    : DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS;
  const now = normalizeNow(options.now);
  const state = typeof entry === "string" ? entry : String(entry.state || "").trim();
  const updatedAt = typeof entry === "object" && Number.isFinite(entry.updatedAt)
    ? entry.updatedAt
    : now;

  if (!state) {
    store.delete(id);
    return "";
  }
  if (ttlMs > 0 && now - updatedAt > ttlMs) {
    store.delete(id);
    return "";
  }
  return state;
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
  getTransientAgentState,
  pruneTransientAgentStates,
};

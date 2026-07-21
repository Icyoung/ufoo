"use strict";

/**
 * Runtime event types for Agent Loop wakeup (never user-role messages).
 */

const RUNTIME_EVENT_TYPES = Object.freeze([
  "task_started",
  "task_succeeded",
  "task_failed",
  "task_cancelled",
  "parent_graph_ready_changed",
]);

function createRuntimeEvent(type = "", payload = {}) {
  const eventType = String(type || "").trim();
  if (!RUNTIME_EVENT_TYPES.includes(eventType)) {
    throw new Error(`unknown runtime event type: ${type}`);
  }
  return {
    type: eventType,
    at: new Date().toISOString(),
    ...payload,
  };
}

function isRuntimeEvent(value = null) {
  return Boolean(
    value
    && typeof value === "object"
    && RUNTIME_EVENT_TYPES.includes(String(value.type || "")),
  );
}

module.exports = {
  RUNTIME_EVENT_TYPES,
  createRuntimeEvent,
  isRuntimeEvent,
};

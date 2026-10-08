"use strict";

/**
 * Minimal fault-injection harness for crash/restart tests (Phase 0 skeleton).
 *
 * Usage:
 *   armFault("after_prepare_tool_calls");
 *   await withFaultPoint("after_prepare_tool_calls", async () => { ... });
 *
 * Armed points throw FaultInjectedError once (or until disarmed).
 */

const armed = new Map();

class FaultInjectedError extends Error {
  constructor(point = "") {
    super(`fault injected at ${point}`);
    this.name = "FaultInjectedError";
    this.code = "FAULT_INJECTED";
    this.point = String(point || "");
  }
}

/** Known hook names reserved for native loop / resume (R4 expands coverage). */
const FAULT_POINTS = Object.freeze([
  "after_prepare_tool_calls",
  "before_tool_exec",
  "after_tool_effect",
  "before_result_commit",
  "after_answer_commit",
  "before_provider_resume",
  "after_taskrun_acquire_lease",
  "before_parent_node_sync",
]);

function armFault(point = "", { times = 1, error = null } = {}) {
  const name = String(point || "").trim();
  if (!name) throw new Error("fault point name required");
  armed.set(name, {
    remaining: Math.max(1, Math.floor(Number(times) || 1)),
    error: error || null,
  });
  return name;
}

function disarmFault(point = "") {
  const name = String(point || "").trim();
  if (!name) {
    armed.clear();
    return;
  }
  armed.delete(name);
}

function isFaultArmed(point = "") {
  return armed.has(String(point || "").trim());
}

function checkFaultPoint(point = "") {
  const name = String(point || "").trim();
  const entry = armed.get(name);
  if (!entry) return;
  entry.remaining -= 1;
  if (entry.remaining <= 0) armed.delete(name);
  if (entry.error) throw entry.error;
  throw new FaultInjectedError(name);
}

/**
 * Run fn; if point is armed, throw before invoking fn.
 */
async function withFaultPoint(point = "", fn) {
  checkFaultPoint(point);
  return typeof fn === "function" ? fn() : undefined;
}

function listArmedFaults() {
  return Array.from(armed.keys());
}

module.exports = {
  FAULT_POINTS,
  FaultInjectedError,
  armFault,
  disarmFault,
  isFaultArmed,
  checkFaultPoint,
  withFaultPoint,
  listArmedFaults,
};

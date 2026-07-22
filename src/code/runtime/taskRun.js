"use strict";

const { randomUUID } = require("crypto");

/**
 * TaskRun registry — parent Task node identity vs runnable attempt.
 *
 * Scheduler owner: TaskLoop (`processTaskRun` / `resumePersistedTaskRuns`).
 * Agent Loop may only issue control commands (start/cancel/complete) via CAS.
 *
 * Restart rules:
 * - queued → remain queued (scheduler resumes)
 * - running + phase waiting_model|executing_tools|planning → requeue to queued
 * - cancelling → stay cancelling until cancel completes
 * - terminal → never transition backward
 */

const TASK_RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "cancelled",
]);

const TASK_RUN_PHASES = Object.freeze([
  "initializing",
  "planning",
  "waiting_model",
  "executing_tools",
  "finalizing",
]);

const TERMINAL_TASK_RUN = new Set(["succeeded", "failed", "cancelled"]);

/** Keep in sync with protocol/transitions.TASK_RUN_TRANSITIONS. */
const TASK_RUN_TRANSITIONS = Object.freeze({
  queued: Object.freeze(["running", "cancelled"]),
  running: Object.freeze(["succeeded", "failed", "cancelling"]),
  cancelling: Object.freeze(["cancelled", "failed"]),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/** Default write-lease / heartbeat staleness (ms). */
const DEFAULT_LEASE_STALE_MS = 30 * 60 * 1000;

/** Extra recovery edge used only by recoverTaskRunsAfterRestart. */
const RECOVERY_TRANSITIONS = Object.freeze({
  running: Object.freeze(["queued"]),
});

function isAllowedTaskRunTransition(fromStatus = "", toStatus = "") {
  const from = String(fromStatus || "").trim();
  const to = String(toStatus || "").trim();
  const allowed = TASK_RUN_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
function createTaskRunId() {
  return `trun_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

function emptyTaskRunStore() {
  return {
    byId: {},
    commandLog: {},
    wakeupLog: {},
  };
}

function ensureTaskRunStore(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  if (!state.taskRuns || typeof state.taskRuns !== "object") {
    state.taskRuns = emptyTaskRunStore();
  }
  if (!state.taskRuns.byId || typeof state.taskRuns.byId !== "object") {
    state.taskRuns.byId = {};
  }
  if (!state.taskRuns.commandLog || typeof state.taskRuns.commandLog !== "object") {
    state.taskRuns.commandLog = {};
  }
  if (!state.taskRuns.wakeupLog || typeof state.taskRuns.wakeupLog !== "object") {
    state.taskRuns.wakeupLog = {};
  }
  return state.taskRuns;
}

function createTaskRun({
  parentGraphId = "",
  parentNodeId = "",
  childGraphId = "",
  attempt = 1,
} = {}) {
  const now = new Date().toISOString();
  return {
    id: createTaskRunId(),
    parentGraphId: String(parentGraphId || "").trim(),
    parentNodeId: String(parentNodeId || "").trim(),
    childGraphId: String(childGraphId || "").trim(),
    status: "queued",
    phase: "initializing",
    attempt: Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1,
    ignoreUserPrompts: true,
    cancelRequested: false,
    result: null,
    error: null,
    changedFiles: [],
    createdAt: now,
    startedAt: "",
    completedAt: "",
    heartbeatAt: "",
    lastWakeupId: "",
  };
}

function getTaskRun(executionState = null, taskRunId = "") {
  const store = ensureTaskRunStore(executionState);
  const id = String(taskRunId || "").trim();
  return id && store.byId[id] ? store.byId[id] : null;
}

function putTaskRun(executionState = null, taskRun = null) {
  if (!taskRun || !taskRun.id) return null;
  const store = ensureTaskRunStore(executionState);
  store.byId[taskRun.id] = taskRun;
  return taskRun;
}

function findActiveTaskRunForNode(executionState = null, parentNodeId = "") {
  const store = ensureTaskRunStore(executionState);
  const nodeId = String(parentNodeId || "").trim();
  for (const run of Object.values(store.byId)) {
    if (!run || run.parentNodeId !== nodeId) continue;
    if (run.status === "queued" || run.status === "running" || run.status === "cancelling") {
      return run;
    }
  }
  return null;
}

function listActiveWritingTaskRuns(executionState = null) {
  const store = ensureTaskRunStore(executionState);
  return Object.values(store.byId).filter((run) => (
    run
    && (run.status === "queued" || run.status === "running" || run.status === "cancelling")
  ));
}

function isTerminalTaskRun(run = null) {
  return Boolean(run && TERMINAL_TASK_RUN.has(String(run.status || "")));
}

function touchTaskRunHeartbeat(executionState = null, taskRunId = "") {
  const run = getTaskRun(executionState, taskRunId);
  if (!run) return null;
  run.heartbeatAt = new Date().toISOString();
  putTaskRun(executionState, run);
  return run;
}

function isTransitionAllowed(fromStatus, toStatus, { allowRecovery = false } = {}) {
  if (fromStatus === toStatus) return true;
  if (isAllowedTaskRunTransition(fromStatus, toStatus)) return true;
  if (allowRecovery) {
    const extra = RECOVERY_TRANSITIONS[fromStatus] || [];
    return extra.includes(toStatus);
  }
  return false;
}

/**
 * Compare-and-set status transition. Enforces allowed edges; terminal is final.
 */
function casTaskRunStatus(executionState = null, taskRunId = "", {
  expectedStatus = "",
  nextStatus = "",
  phase = "",
  result = null,
  error = null,
  changedFiles = null,
  allowRecovery = false,
} = {}) {
  const run = getTaskRun(executionState, taskRunId);
  if (!run) return { ok: false, code: "TASK_RUN_NOT_FOUND", run: null };
  const expected = String(expectedStatus || "").trim();
  if (expected && run.status !== expected) {
    return {
      ok: false,
      code: "TASK_STATUS_CAS_FAILED",
      run,
      currentStatus: run.status,
    };
  }
  if (TERMINAL_TASK_RUN.has(run.status)) {
    return {
      ok: false,
      code: "TASK_ALREADY_TERMINAL",
      run,
      currentStatus: run.status,
    };
  }
  const next = String(nextStatus || "").trim();
  if (!TASK_RUN_STATUSES.includes(next)) {
    return { ok: false, code: "INVALID_TASK_STATUS", run };
  }
  if (!isTransitionAllowed(run.status, next, { allowRecovery })) {
    return {
      ok: false,
      code: "TASK_TRANSITION_FORBIDDEN",
      run,
      currentStatus: run.status,
      nextStatus: next,
      allowed: (TASK_RUN_TRANSITIONS[run.status] || []).slice(),
    };
  }
  run.status = next;
  if (phase && TASK_RUN_PHASES.includes(phase)) run.phase = phase;
  if (result !== null) run.result = result;
  if (error !== null) run.error = error;
  if (Array.isArray(changedFiles)) run.changedFiles = changedFiles.map(String);
  if (next === "running" && !run.startedAt) run.startedAt = new Date().toISOString();
  if (TERMINAL_TASK_RUN.has(next)) {
    run.completedAt = new Date().toISOString();
    run.phase = "finalizing";
  }
  if (next === "cancelling") run.cancelRequested = true;
  run.heartbeatAt = new Date().toISOString();
  putTaskRun(executionState, run);
  return { ok: true, run };
}

function cacheControlCommand(executionState = null, commandId = "", payload = {}) {
  const id = String(commandId || "").trim();
  if (!id) return;
  const store = ensureTaskRunStore(executionState);
  store.commandLog[id] = JSON.parse(JSON.stringify(payload));
}

function getCachedControlCommand(executionState = null, commandId = "") {
  const id = String(commandId || "").trim();
  if (!id) return null;
  const store = ensureTaskRunStore(executionState);
  return store.commandLog[id] ? JSON.parse(JSON.stringify(store.commandLog[id])) : null;
}

/**
 * Deduplicate wakeups by wakeupId. Second delivery returns cached result.
 */
function beginWakeup(executionState = null, wakeupId = "", meta = {}) {
  const id = String(wakeupId || "").trim();
  if (!id) return { ok: true, fresh: true };
  const store = ensureTaskRunStore(executionState);
  const existing = store.wakeupLog[id];
  if (existing && existing.status === "completed") {
    return {
      ok: true,
      fresh: false,
      idempotentReplay: true,
      result: existing.result ? JSON.parse(JSON.stringify(existing.result)) : existing,
    };
  }
  if (existing && existing.status === "started") {
    return {
      ok: true,
      fresh: false,
      idempotentReplay: true,
      result: { status: "in_flight", wakeupId: id },
    };
  }
  store.wakeupLog[id] = {
    status: "started",
    startedAt: new Date().toISOString(),
    ...meta,
  };
  return { ok: true, fresh: true };
}

function completeWakeup(executionState = null, wakeupId = "", result = {}) {
  const id = String(wakeupId || "").trim();
  if (!id) return;
  const store = ensureTaskRunStore(executionState);
  store.wakeupLog[id] = {
    ...(store.wakeupLog[id] || {}),
    status: "completed",
    completedAt: new Date().toISOString(),
    result: JSON.parse(JSON.stringify(result || {})),
  };
}

/**
 * After process restart: requeue interrupted running runs; leave cancelling alone.
 * Does not execute tools — caller should invoke processTaskRun separately.
 */
function recoverTaskRunsAfterRestart(executionState = null) {
  const store = ensureTaskRunStore(executionState);
  const recovered = [];
  for (const run of Object.values(store.byId)) {
    if (!run) continue;
    if (run.status === "running") {
      const phase = String(run.phase || "");
      if (phase === "waiting_model" || phase === "executing_tools" || phase === "planning") {
        const cas = casTaskRunStatus(executionState, run.id, {
          expectedStatus: "running",
          nextStatus: "queued",
          phase: "initializing",
          allowRecovery: true,
        });
        recovered.push({
          taskRunId: run.id,
          action: cas.ok ? "requeued" : "skip",
          code: cas.ok ? "" : cas.code,
        });
      } else {
        recovered.push({ taskRunId: run.id, action: "resume_running" });
      }
    } else if (run.status === "queued" || run.status === "cancelling") {
      recovered.push({ taskRunId: run.id, action: `resume_${run.status}` });
    }
  }
  return recovered;
}

module.exports = {
  TASK_RUN_STATUSES,
  TASK_RUN_PHASES,
  TERMINAL_TASK_RUN,
  TASK_RUN_TRANSITIONS,
  DEFAULT_LEASE_STALE_MS,
  createTaskRunId,
  emptyTaskRunStore,
  ensureTaskRunStore,
  createTaskRun,
  getTaskRun,
  putTaskRun,
  findActiveTaskRunForNode,
  listActiveWritingTaskRuns,
  isTerminalTaskRun,
  touchTaskRunHeartbeat,
  casTaskRunStatus,
  cacheControlCommand,
  getCachedControlCommand,
  beginWakeup,
  completeWakeup,
  recoverTaskRunsAfterRestart,
};

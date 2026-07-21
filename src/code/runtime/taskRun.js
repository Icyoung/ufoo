"use strict";

const { randomUUID } = require("crypto");

/**
 * TaskRun registry — parent Task node identity vs runnable attempt.
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

function createTaskRunId() {
  return `trun_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

function emptyTaskRunStore() {
  return {
    byId: {},
    commandLog: {},
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

/**
 * Compare-and-set status transition. Returns { ok, run }.
 */
function casTaskRunStatus(executionState = null, taskRunId = "", {
  expectedStatus = "",
  nextStatus = "",
  phase = "",
  result = null,
  error = null,
  changedFiles = null,
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
  const next = String(nextStatus || "").trim();
  if (!TASK_RUN_STATUSES.includes(next)) {
    return { ok: false, code: "INVALID_TASK_STATUS", run };
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

module.exports = {
  TASK_RUN_STATUSES,
  TASK_RUN_PHASES,
  TERMINAL_TASK_RUN,
  createTaskRunId,
  emptyTaskRunStore,
  ensureTaskRunStore,
  createTaskRun,
  getTaskRun,
  putTaskRun,
  findActiveTaskRunForNode,
  listActiveWritingTaskRuns,
  isTerminalTaskRun,
  casTaskRunStatus,
  cacheControlCommand,
  getCachedControlCommand,
};

"use strict";

/**
 * Workspace write lease — up to MAX_CONCURRENT_WRITE_LEASES writing TaskRuns.
 * Agent write/edit/side-effect bash rejected while any Task holds a write lease.
 */

const WRITE_TOOLS = new Set(["write", "edit", "bash"]);
const MAX_CONCURRENT_WRITE_LEASES = 6;

function emptyWorkspaceLease() {
  return {
    holders: [], // [{ kind: "task_run", taskRunId, acquiredAt }]
    mode: "write",
    // Legacy single-holder field; migrated in ensureWorkspaceLease.
    holder: null,
    acquiredAt: "",
  };
}

function ensureWorkspaceLease(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  if (!state.workspaceLease || typeof state.workspaceLease !== "object") {
    state.workspaceLease = emptyWorkspaceLease();
  }
  normalizeHolders(state.workspaceLease);
  return state.workspaceLease;
}

function normalizeHolders(lease = null) {
  const next = lease && typeof lease === "object" ? lease : emptyWorkspaceLease();
  if (!Array.isArray(next.holders)) next.holders = [];

  // Migrate V1 single-holder shape.
  if (next.holder && typeof next.holder === "object" && next.holder.taskRunId) {
    const id = String(next.holder.taskRunId || "").trim();
    if (id && !next.holders.some((h) => h && h.taskRunId === id)) {
      next.holders.push({
        kind: "task_run",
        taskRunId: id,
        acquiredAt: String(next.acquiredAt || new Date().toISOString()),
      });
    }
    next.holder = null;
  }

  next.holders = next.holders
    .filter((h) => h && h.kind === "task_run" && String(h.taskRunId || "").trim())
    .map((h) => ({
      kind: "task_run",
      taskRunId: String(h.taskRunId).trim(),
      acquiredAt: String(h.acquiredAt || ""),
    }));

  // Cap defensive (should not happen if acquire gates correctly).
  if (next.holders.length > MAX_CONCURRENT_WRITE_LEASES) {
    next.holders = next.holders.slice(0, MAX_CONCURRENT_WRITE_LEASES);
  }
  return next.holders;
}

function listWriteLeaseHolders(executionState = null) {
  return normalizeHolders(ensureWorkspaceLease(executionState)).slice();
}

function countWriteLeases(executionState = null) {
  return listWriteLeaseHolders(executionState).length;
}

function findWriteLeaseHolder(executionState = null, taskRunId = "") {
  const id = String(taskRunId || "").trim();
  if (!id) return null;
  return listWriteLeaseHolders(executionState).find((h) => h.taskRunId === id) || null;
}

function canAcquireWriteLease(executionState = null, taskRunId = "") {
  const id = String(taskRunId || "").trim();
  if (!id) return { ok: false, code: "MISSING_TASK_RUN_ID" };
  if (findWriteLeaseHolder(executionState, id)) {
    return { ok: true, idempotent: true };
  }
  const count = countWriteLeases(executionState);
  if (count >= MAX_CONCURRENT_WRITE_LEASES) {
    return {
      ok: false,
      code: "MAX_CONCURRENT_TASKS",
      max: MAX_CONCURRENT_WRITE_LEASES,
      current: count,
      holders: listWriteLeaseHolders(executionState),
    };
  }
  return { ok: true, current: count, max: MAX_CONCURRENT_WRITE_LEASES };
}

function acquireTaskWriteLease(executionState = null, taskRunId = "") {
  const lease = ensureWorkspaceLease(executionState);
  const holders = normalizeHolders(lease);
  const id = String(taskRunId || "").trim();
  if (!id) {
    return { ok: false, code: "MISSING_TASK_RUN_ID" };
  }

  const existing = holders.find((h) => h.taskRunId === id);
  if (existing) {
    return { ok: true, lease, holder: existing, idempotent: true };
  }

  if (holders.length >= MAX_CONCURRENT_WRITE_LEASES) {
    return {
      ok: false,
      code: "MAX_CONCURRENT_TASKS",
      max: MAX_CONCURRENT_WRITE_LEASES,
      current: holders.length,
      holders: holders.slice(),
      message: `At most ${MAX_CONCURRENT_WRITE_LEASES} concurrent writing TaskRuns`,
    };
  }

  const holder = {
    kind: "task_run",
    taskRunId: id,
    acquiredAt: new Date().toISOString(),
  };
  holders.push(holder);
  lease.holders = holders;
  lease.mode = "write";
  return { ok: true, lease, holder };
}

function releaseTaskWriteLease(executionState = null, taskRunId = "") {
  const lease = ensureWorkspaceLease(executionState);
  const holders = normalizeHolders(lease);
  const id = String(taskRunId || "").trim();
  if (!id) return { ok: true, lease };
  lease.holders = holders.filter((h) => h.taskRunId !== id);
  if (lease.holders.length === 0) {
    lease.acquiredAt = "";
  }
  return { ok: true, lease };
}

function clearWorkspaceLease(executionState = null) {
  const lease = ensureWorkspaceLease(executionState);
  lease.holders = [];
  lease.holder = null;
  lease.acquiredAt = "";
  return lease;
}

/**
 * @param {string} tool
 * @param {"agent_loop"|"task_loop"} originKind
 * @param {string} [taskRunId]
 */
function checkWriteAllowed(executionState = null, {
  tool = "",
  originKind = "agent_loop",
  taskRunId = "",
} = {}) {
  const name = String(tool || "").trim().toLowerCase();
  if (!WRITE_TOOLS.has(name)) return { ok: true };

  const holders = listWriteLeaseHolders(executionState);
  if (holders.length === 0) return { ok: true };

  if (originKind === "task_loop") {
    const id = String(taskRunId || "").trim();
    if (holders.some((h) => h.taskRunId === id)) {
      return { ok: true };
    }
    return {
      ok: false,
      code: "WORKSPACE_WRITE_LEASE_HELD",
      holders,
      message: "This TaskRun does not hold a workspace write lease.",
    };
  }

  // Agent loop cannot write while any task holds a lease.
  return {
    ok: false,
    code: "WORKSPACE_WRITE_LEASE_HELD",
    holders,
    owner: holders[0] || null,
    message: `${holders.length} active TaskRun(s) hold workspace write lease(s); cancel or wait before writing.`,
  };
}

function hasActiveWriteLease(executionState = null) {
  return countWriteLeases(executionState) > 0;
}

module.exports = {
  WRITE_TOOLS,
  MAX_CONCURRENT_WRITE_LEASES,
  emptyWorkspaceLease,
  ensureWorkspaceLease,
  normalizeHolders,
  listWriteLeaseHolders,
  countWriteLeases,
  findWriteLeaseHolder,
  canAcquireWriteLease,
  acquireTaskWriteLease,
  releaseTaskWriteLease,
  clearWorkspaceLease,
  checkWriteAllowed,
  hasActiveWriteLease,
};

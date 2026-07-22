"use strict";

/**
 * Orthogonal control-plane fields (R5).
 *
 * planningPolicy: whether direct side-effect tools are allowed without a graph.
 * executionOwner: who currently owns workspace / loop advancement.
 *
 * Dual-write with legacy planMode boolean during migration.
 */

const PLANNING_POLICIES = Object.freeze(["direct_allowed", "graph_required"]);

function emptyExecutionOwner() {
  return { kind: "none", id: "" };
}

function normalizePlanningPolicy(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (PLANNING_POLICIES.includes(raw)) return raw;
  return "";
}

function normalizeExecutionOwner(owner = null) {
  if (!owner || typeof owner !== "object") return emptyExecutionOwner();
  const kind = String(owner.kind || "none").trim().toLowerCase();
  if (kind === "agent_loop" || kind === "task_run") {
    return {
      kind,
      id: String(owner.id || owner.taskRunId || owner.agentLoopId || "").trim(),
    };
  }
  return emptyExecutionOwner();
}

/**
 * Sync planningPolicy ↔ planMode. Prefer explicit planningPolicy when present.
 */
function syncPlanningFields(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  const explicit = normalizePlanningPolicy(state.planningPolicy);
  if (explicit) {
    state.planningPolicy = explicit;
    state.planMode = explicit === "graph_required";
  } else if (state.planMode === true) {
    state.planningPolicy = "graph_required";
  } else {
    state.planningPolicy = "direct_allowed";
    state.planMode = false;
  }
  state.executionOwner = normalizeExecutionOwner(state.executionOwner);
  return state;
}

function setPlanningPolicy(executionState = null, policy = "direct_allowed", {
  reason = "",
  source = "",
} = {}) {
  const state = syncPlanningFields(executionState);
  const next = normalizePlanningPolicy(policy) || "direct_allowed";
  state.planningPolicy = next;
  // Dual-write legacy bool
  const { setPlanMode } = require("../context/planMode");
  setPlanMode(state, next === "graph_required", { reason, source });
  state.planningPolicy = next;
  return state;
}

function getPlanningPolicy(executionState = null) {
  return syncPlanningFields(executionState).planningPolicy;
}

function setExecutionOwner(executionState = null, owner = null) {
  const state = syncPlanningFields(executionState);
  state.executionOwner = normalizeExecutionOwner(owner);
  return state.executionOwner;
}

function getExecutionOwner(executionState = null) {
  return syncPlanningFields(executionState).executionOwner;
}

module.exports = {
  PLANNING_POLICIES,
  emptyExecutionOwner,
  normalizePlanningPolicy,
  normalizeExecutionOwner,
  syncPlanningFields,
  setPlanningPolicy,
  getPlanningPolicy,
  setExecutionOwner,
  getExecutionOwner,
};

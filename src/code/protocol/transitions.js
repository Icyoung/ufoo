"use strict";

/**
 * Current-state transition tables for Plan Mode and TaskRun (Phase 0).
 *
 * Documents *as-implemented* rules. R5 will replace planMode bool with
 * planningPolicy × executionOwner; until then this table locks the status quo.
 */

const { TASK_RUN_STATUSES, TERMINAL_TASK_RUN } = require("../runtime/taskRun");

/** Allowed TaskRun status edges (from → to[]). Terminal states have no outbound edges. */
const TASK_RUN_TRANSITIONS = Object.freeze({
  queued: Object.freeze(["running", "cancelled"]),
  running: Object.freeze(["succeeded", "failed", "cancelling"]),
  cancelling: Object.freeze(["cancelled", "failed"]),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/**
 * Plan Mode is a session posture boolean today.
 * Combinations with TaskRun are orthogonal: /plan off does not cancel TaskRuns.
 */
const PLAN_MODE_FACTS = Object.freeze({
  /** /plan on | auto after plan_graph create */
  enterSources: Object.freeze(["user", "auto"]),
  /** /plan off clears planMode; does not cancel graph or TaskRun */
  exitClearsGraph: false,
  exitCancelsTaskRun: false,
  /** When planMode=true, side-effect direct tools may be blocked at runtime */
  blocksDirectSideEffectsWhenOn: true,
  /** Active plan waiting on a task can block data-plane tools even if policy differs later */
  activePlanMayBlockDataTools: true,
  /** TaskRun may continue after planMode is turned off */
  taskRunSurvivesPlanOff: true,
});

/**
 * Forward-looking orthognal fields (not yet stored on executionState).
 * Mapped conceptually for R5 migration tests.
 */
const FUTURE_POLICY_OWNER = Object.freeze({
  planningPolicy: Object.freeze(["direct_allowed", "graph_required"]),
  executionOwnerKinds: Object.freeze(["none", "agent_loop", "task_run"]),
  mapPlanModeOn: Object.freeze({ planningPolicy: "graph_required" }),
  mapPlanModeOff: Object.freeze({ planningPolicy: "direct_allowed" }),
});

function isAllowedTaskRunTransition(fromStatus = "", toStatus = "") {
  const from = String(fromStatus || "").trim();
  const to = String(toStatus || "").trim();
  const allowed = TASK_RUN_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

function assertTransitionTables() {
  for (const status of TASK_RUN_STATUSES) {
    if (!Object.prototype.hasOwnProperty.call(TASK_RUN_TRANSITIONS, status)) {
      throw new Error(`missing TASK_RUN_TRANSITIONS for ${status}`);
    }
  }
  for (const [from, tos] of Object.entries(TASK_RUN_TRANSITIONS)) {
    if (TERMINAL_TASK_RUN.has(from) && tos.length !== 0) {
      throw new Error(`terminal status ${from} must have empty outbound edges`);
    }
    for (const to of tos) {
      if (!TASK_RUN_STATUSES.includes(to)) {
        throw new Error(`invalid transition ${from} → ${to}`);
      }
    }
  }
  return true;
}

module.exports = {
  TASK_RUN_TRANSITIONS,
  PLAN_MODE_FACTS,
  FUTURE_POLICY_OWNER,
  isAllowedTaskRunTransition,
  assertTransitionTables,
};

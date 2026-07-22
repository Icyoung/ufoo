"use strict";

/**
 * Session state ownership table (Phase 0).
 *
 * Durable fields are recovery sources. Projections may be rebuilt from durable
 * state (or from protocolLedger + provider message checkpoint until full
 * event-sourced rebuild exists).
 *
 * See docs/ucode-agent-runtime-remediation-plan.md §4.2 / R4.
 */

/** @typedef {"session"|"session/artifacts"|"checkpoint"|"runtime_events"|"execution/session"} Authority */

/**
 * @type {ReadonlyArray<{
 *   key: string,
 *   authority: Authority,
 *   durable: boolean,
 *   rebuildable: boolean,
 *   notes?: string
 * }>}
 */
const STATE_OWNERSHIP = Object.freeze([
  {
    key: "protocolLedger",
    authority: "session",
    durable: true,
    rebuildable: false,
    notes: "Not yet persisted; planned under DurableSessionState (R1/R4)",
  },
  {
    key: "executionState",
    authority: "session",
    durable: true,
    rebuildable: false,
  },
  {
    key: "transcript.events",
    authority: "session/artifacts",
    durable: true,
    rebuildable: false,
  },
  {
    key: "providerMessages",
    authority: "checkpoint",
    durable: true,
    rebuildable: true,
    notes: "Today: nlMessages stripped on save; rebuilt from transcript when possible",
  },
  {
    key: "workingSet",
    authority: "execution/session",
    durable: true,
    rebuildable: true,
  },
  {
    key: "artifacts",
    authority: "session/artifacts",
    durable: true,
    rebuildable: false,
  },
  {
    key: "rollingSummary",
    authority: "session",
    durable: true,
    rebuildable: true,
    notes: "Optional durable projection (summary field)",
  },
  {
    key: "uiLogs",
    authority: "runtime_events",
    durable: false,
    rebuildable: true,
  },
  {
    key: "planUi",
    authority: "execution/session",
    durable: true,
    rebuildable: true,
    notes: "Band mode preferences; graph view is projection of planGraph",
  },
  {
    key: "sessionStatus",
    authority: "runtime_events",
    durable: false,
    rebuildable: true,
  },
]);

const DURABLE_FIELDS = Object.freeze(
  STATE_OWNERSHIP.filter((row) => row.durable).map((row) => row.key)
);

const PROJECTION_FIELDS = Object.freeze(
  STATE_OWNERSHIP.filter((row) => row.rebuildable).map((row) => row.key)
);

function getOwnershipRow(key = "") {
  const id = String(key || "").trim();
  return STATE_OWNERSHIP.find((row) => row.key === id) || null;
}

function assertOwnershipTableInvariants() {
  const keys = new Set();
  for (const row of STATE_OWNERSHIP) {
    if (!row.key) throw new Error("ownership row missing key");
    if (keys.has(row.key)) throw new Error(`duplicate ownership key: ${row.key}`);
    keys.add(row.key);
    if (typeof row.durable !== "boolean" || typeof row.rebuildable !== "boolean") {
      throw new Error(`ownership row ${row.key} has invalid flags`);
    }
  }
  return true;
}

/**
 * Atomic commit boundaries (R4). Crash between these stages must have a
 * defined recovery; tools that are not naturally idempotent must not be
 * blindly re-executed when stopped at `started`.
 */
const ATOMIC_COMMIT_BOUNDARIES = Object.freeze([
  "assistant_tool_calls_accepted",
  "before_side_effect_tool",
  "after_side_effect_persisted",
  "tool_result_committed_to_ledger",
  "before_agent_loop_suspension",
  "after_resume_answer_committed",
  "after_taskrun_terminal_cas",
]);

const SIDE_EFFECT_INVOCATION_PHASES = Object.freeze([
  "prepared",
  "started",
  "effect_observed",
  "result_committed",
]);

module.exports = {
  STATE_OWNERSHIP,
  DURABLE_FIELDS,
  PROJECTION_FIELDS,
  getOwnershipRow,
  assertOwnershipTableInvariants,
  ATOMIC_COMMIT_BOUNDARIES,
  SIDE_EFFECT_INVOCATION_PHASES,
};

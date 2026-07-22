"use strict";

/**
 * Unified user interjection (nudge) queue for the native agent loop.
 *
 * While a task is running, user submits enqueue here. nativeRunner drains
 * before each LLM turn and appends a labeled additional user reminder.
 */

function ensurePendingUserPrompts(executionState = null) {
  const state = executionState && typeof executionState === "object"
    ? executionState
    : {};
  if (!Array.isArray(state.pendingUserPrompts)) {
    state.pendingUserPrompts = [];
  }
  return state;
}

function enqueueUserPrompt(executionState = null, text = "") {
  const state = ensurePendingUserPrompts(executionState);
  const value = String(text || "").trim();
  if (!value) {
    return { ok: false, enqueued: false, reason: "empty", executionState: state };
  }
  state.pendingUserPrompts.push({
    text: value,
    at: new Date().toISOString(),
  });
  return {
    ok: true,
    enqueued: true,
    count: state.pendingUserPrompts.length,
    executionState: state,
  };
}

/**
 * Atomically take all pending prompts and clear the queue.
 * @returns {string[]}
 */
function drainUserPrompts(executionState = null) {
  const state = ensurePendingUserPrompts(executionState);
  if (state.pendingUserPrompts.length === 0) return [];
  const texts = state.pendingUserPrompts.map((entry) => String(entry.text || "").trim()).filter(Boolean);
  state.pendingUserPrompts = [];
  return texts;
}

function clearUserPrompts(executionState = null) {
  const state = ensurePendingUserPrompts(executionState);
  state.pendingUserPrompts = [];
  return state;
}

function hasPendingUserPrompts(executionState = null) {
  const state = ensurePendingUserPrompts(executionState);
  return state.pendingUserPrompts.length > 0;
}

function shouldFrameAsUserReminder(executionState = null) {
  if (!executionState || typeof executionState !== "object") return false;
  if (executionState.planMode === true) return true;
  const waiting = executionState.planGraph && executionState.planGraph.waitingFor;
  return Boolean(waiting && waiting.id);
}

function formatUserReminderMessage(texts = [], { waitingFor = null } = {}) {
  const lines = Array.isArray(texts)
    ? texts.map((t) => String(t || "").trim()).filter(Boolean)
    : [String(texts || "").trim()].filter(Boolean);
  if (lines.length === 0) return "";

  const parts = ["User reminder (additional prompt):"];
  if (lines.length === 1) {
    parts.push(lines[0]);
  } else {
    lines.forEach((line, index) => {
      parts.push(`${index + 1}. ${line}`);
    });
  }
  if (waitingFor && waitingFor.id) {
    const label = waitingFor.title || waitingFor.objective || waitingFor.reason || waitingFor.id;
    parts.push(
      `Prefer serving the current waiting ${waitingFor.type || "node"}: ${waitingFor.id}`
        + (label && label !== waitingFor.id ? ` — ${label}` : "")
        + ". Do not start an unrelated objective.",
    );
  }
  return parts.join("\n");
}

/**
 * Idle + plan waiting: wrap a new user message as continuation reminder.
 */
function buildContinuationUserPrompt(userText = "", executionState = null) {
  const text = String(userText || "").trim();
  if (!text) return "";
  const waiting = executionState
    && executionState.planGraph
    && executionState.planGraph.waitingFor
    ? executionState.planGraph.waitingFor
    : null;
  return formatUserReminderMessage([text], { waitingFor: waiting });
}

const PLAN_AUTO_CONTINUE_STOP_REASONS = new Set([
  "approval_required",
  "graph_terminal",
  "scheduler_deadlock",
]);

/**
 * Whether the Agent Loop should keep going after a text-only model turn
 * because the plan graph is still waiting on an agent-actionable task.
 */
function shouldAutoContinuePlan(executionState = null) {
  if (!executionState || typeof executionState !== "object") return false;
  if (executionState.pendingUserInteraction) return false;
  const pg = executionState.planGraph && typeof executionState.planGraph === "object"
    ? executionState.planGraph
    : null;
  if (!pg) return false;
  const waiting = pg.waitingFor && typeof pg.waitingFor === "object" ? pg.waitingFor : null;
  if (!waiting || !waiting.id) return false;
  if (String(waiting.type || "").trim().toLowerCase() !== "task") return false;
  const yieldReason = String(pg.lastYieldReason || "").trim().toLowerCase();
  if (yieldReason && PLAN_AUTO_CONTINUE_STOP_REASONS.has(yieldReason)) return false;
  return true;
}

/**
 * Internal reminder injected by runtime when the model ends a turn while the
 * plan is still waiting on a task. Must NOT reuse the User reminder label —
 * that is reserved for real mid-run user text and pollutes transcript/TUI.
 */
function buildPlanAutoContinueReminder(executionState = null) {
  const waiting = executionState
    && executionState.planGraph
    && executionState.planGraph.waitingFor
    ? executionState.planGraph.waitingFor
    : null;
  if (!waiting || !waiting.id) return "";
  const label = waiting.title || waiting.objective || waiting.reason || waiting.id;
  const lines = [
    "Runtime wake (not a user message): active plan is still waiting.",
    "Continue serving it now via plan_graph "
      + "(expand_node, control.start_task, or control.complete_task as appropriate). "
      + "Do not end the turn with text only while this node is waiting.",
    `Prefer serving the current waiting ${waiting.type || "node"}: ${waiting.id}`
      + (label && label !== waiting.id ? ` — ${label}` : "")
      + ".",
  ];
  return lines.join("\n");
}

module.exports = {
  ensurePendingUserPrompts,
  enqueueUserPrompt,
  drainUserPrompts,
  clearUserPrompts,
  hasPendingUserPrompts,
  shouldFrameAsUserReminder,
  formatUserReminderMessage,
  buildContinuationUserPrompt,
  shouldAutoContinuePlan,
  buildPlanAutoContinueReminder,
  PLAN_AUTO_CONTINUE_STOP_REASONS,
};

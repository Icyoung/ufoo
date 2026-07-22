"use strict";

/**
 * Drain Agent Loop mailbox into a turnDynamic block (never as user role).
 * Mid-loop wakeups (nativeRunner) also consume the same mailbox into the
 * conversation so TaskRun waiting_model does not strand the Agent Loop.
 */

const { drainAgentMailbox, ensureMailbox, peek } = require("./loopMailbox");
const { ensureTaskRunStore } = require("./taskRun");

function formatAgentRuntimeEvents(events = []) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) return "";
  const lines = ["Runtime events (Agent Loop mailbox; not user messages):"];
  for (const entry of list) {
    if (!entry) continue;
    if (entry.kind === "user") {
      lines.push(`- user_nudge: ${String(entry.text || "").slice(0, 400)}`);
      continue;
    }
    if (entry.kind === "runtime" && entry.event) {
      const ev = entry.event;
      const bits = [`type=${ev.type}`];
      if (ev.taskId) bits.push(`taskId=${ev.taskId}`);
      if (ev.taskRunId) bits.push(`taskRunId=${ev.taskRunId}`);
      if (ev.result && ev.result.summary) bits.push(`summary=${String(ev.result.summary).slice(0, 200)}`);
      if (ev.error && (ev.error.message || ev.error)) {
        bits.push(`error=${String(ev.error.message || ev.error).slice(0, 200)}`);
      }
      if (Array.isArray(ev.readyNodes) && ev.readyNodes.length) {
        bits.push(`readyNodes=[${ev.readyNodes.join(",")}]`);
      }
      lines.push(`- ${bits.join(" ")}`);
    }
  }
  return lines.join("\n");
}

/**
 * Peek without drain — for inspect. Prefer drainForAgentTurn for consumption.
 */
function peekAgentMailboxText(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  const box = ensureMailbox(state, "agentMailbox");
  return formatAgentRuntimeEvents(box.queue || []);
}

function hasPendingAgentMailbox(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  return Boolean(peek(ensureMailbox(state, "agentMailbox")));
}

function drainAgentMailboxForTurn(executionState = null) {
  const events = drainAgentMailbox(executionState);
  return {
    events,
    text: formatAgentRuntimeEvents(events),
  };
}

const AWAITING_MODEL_PHASES = new Set([
  "waiting_model",
  "planning",
  "initializing",
]);

/**
 * TaskRuns that still need the Agent Loop (model turn / planning).
 */
function listTaskRunsAwaitingModel(executionState = null) {
  const store = ensureTaskRunStore(executionState);
  return Object.values(store.byId || {}).filter((run) => (
    run
    && (run.status === "running" || run.status === "queued")
    && AWAITING_MODEL_PHASES.has(String(run.phase || "").trim().toLowerCase())
  ));
}

function shouldWakeAgentForTaskRuns(executionState = null) {
  return listTaskRunsAwaitingModel(executionState).length > 0;
}

/**
 * Whether the Agent Loop must keep going after a text-only model turn
 * because TaskRuns or unread runtime mail still need service.
 */
function shouldAutoContinueForTaskWake(executionState = null) {
  if (!executionState || typeof executionState !== "object") return false;
  if (executionState.pendingUserInteraction) return false;
  return hasPendingAgentMailbox(executionState) || shouldWakeAgentForTaskRuns(executionState);
}

function buildTaskRunWakeReminder(executionState = null) {
  const runs = listTaskRunsAwaitingModel(executionState);
  if (runs.length === 0 && !hasPendingAgentMailbox(executionState)) return "";
  const lines = [
    "Runtime wake (not a user message): active TaskRun(s) still need the Agent Loop.",
    "Continue serving them now. For a TaskLoop child graph waiting on root:",
    "call plan_graph operation=patch with graphId=<childGraphId> and expand_node on nodeId=root",
    "(tool children). Do not ask the user to /plan off. Do not end with text only.",
  ];
  for (const run of runs.slice(0, 4)) {
    const label = run.title || run.objective || run.parentNodeId || run.id;
    lines.push(
      `- taskRunId=${run.id} phase=${run.phase || ""} status=${run.status || ""}`
      + (run.childGraphId ? ` childGraphId=${run.childGraphId}` : "")
      + (label ? ` — ${String(label).slice(0, 120)}` : "")
    );
  }
  return lines.join("\n");
}

module.exports = {
  formatAgentRuntimeEvents,
  peekAgentMailboxText,
  hasPendingAgentMailbox,
  drainAgentMailboxForTurn,
  listTaskRunsAwaitingModel,
  shouldWakeAgentForTaskRuns,
  shouldAutoContinueForTaskWake,
  buildTaskRunWakeReminder,
};

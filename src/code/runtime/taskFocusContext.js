"use strict";

/**
 * Isolated TaskFocus turns for Agent Loop.
 *
 * TaskLoop steps must not inherit the full Agent Loop transcript. When a
 * TaskRun is waiting_model (or the parent plan is waiting on a task node),
 * rebuild a fresh one-message turn from TaskFocus + compact graph hints.
 */

const {
  listTaskRunsAwaitingModel,
  buildTaskRunWakeReminder,
  formatAgentRuntimeEvents,
} = require("./agentWakeup");
const { buildTaskFocus, renderTaskFocusText, getExecutionKind } = require("./taskFocus");
const { shouldAutoContinuePlan, buildPlanAutoContinueReminder } = require("../context/userNudge");

function getChildGraph(executionState = null, graphId = "") {
  const id = String(graphId || "").trim();
  if (!id || !executionState || typeof executionState !== "object") return null;
  if (executionState.graphs && executionState.graphs[id]) return executionState.graphs[id];
  if (executionState.planGraph && executionState.planGraph.graphId === id) {
    return executionState.planGraph;
  }
  return null;
}

function waitingPlanNode(executionState = null) {
  const pg = executionState && executionState.planGraph;
  const waiting = pg && pg.waitingFor;
  if (!waiting || !waiting.id) return null;
  if (String(waiting.type || "").trim().toLowerCase() !== "task") return null;
  const nodes = Array.isArray(pg.nodes) ? pg.nodes : [];
  return nodes.find((node) => node && node.id === waiting.id) || null;
}

/**
 * True when the next model turn should use TaskFocus isolation instead of the
 * accumulating Agent Loop transcript.
 */
function shouldIsolateTaskFocusTurn(executionState = null) {
  if (!executionState || typeof executionState !== "object") return false;
  if (executionState.pendingUserInteraction) return false;
  // Active TaskRun waiting_model always gets a fresh TaskFocus turn.
  if (listTaskRunsAwaitingModel(executionState).length > 0) return true;
  // Parent-plan waits without a TaskRun only isolate when the Agent Loop
  // would also auto-continue (skip approval_required / terminal yields).
  if (!shouldAutoContinuePlan(executionState)) return false;
  const node = waitingPlanNode(executionState);
  if (!node) return false;
  const kind = getExecutionKind(node);
  return kind === "task_loop" || kind === "expand" || kind === "inline_llm" || kind === "llm";
}

function pickPrimaryAwaitingRun(executionState = null) {
  const runs = listTaskRunsAwaitingModel(executionState);
  return runs[0] || null;
}

function rebuildFocusText(executionState = null, run = null) {
  if (run && String(run.lastFocusText || "").trim()) {
    return String(run.lastFocusText).trim();
  }
  const parent = executionState && executionState.planGraph;
  const nodes = parent && Array.isArray(parent.nodes) ? parent.nodes : [];
  const nodeId = (run && run.parentNodeId)
    || (waitingPlanNode(executionState) && waitingPlanNode(executionState).id)
    || "";
  const focus = buildTaskFocus({
    nodes,
    currentNodeId: nodeId,
    taskRunsById: (executionState.taskRuns && executionState.taskRuns.byId) || {},
    recentlyChangedFiles: executionState.modifiedFiles || [],
    standaloneTask: run && !run.parentNodeId
      ? {
        id: run.id,
        objective: run.objective || run.title || "",
        title: run.title || run.objective || run.id,
        status: run.status,
      }
      : null,
  });
  return renderTaskFocusText(focus);
}

function compactChildGraphHint(executionState = null, run = null) {
  if (!run || !run.childGraphId) return "";
  const child = getChildGraph(executionState, run.childGraphId);
  if (!child) return `Child graph ${run.childGraphId}: (missing)`;
  const waiting = child.waitingFor;
  const nodes = Array.isArray(child.nodes) ? child.nodes : [];
  const lines = [
    `Child graph ${child.graphId}:`,
    `  objective: ${String(child.objective || "").slice(0, 200)}`,
    `  nodes: ${nodes.length}`,
  ];
  if (waiting && waiting.id) {
    lines.push(`  waitingFor: ${waiting.type || "node"}:${waiting.id}`);
  }
  const pending = nodes
    .filter((n) => n && (n.status === "pending" || n.status === "ready" || n.status === "waiting_llm"))
    .slice(0, 6)
    .map((n) => `${n.id}[${n.status || "pending"}]`);
  if (pending.length) lines.push(`  open: ${pending.join(", ")}`);
  return lines.join("\n");
}

function buildIsolationWakeText(executionState = null, mailboxEvents = []) {
  const parts = [];
  const mailText = formatAgentRuntimeEvents(mailboxEvents);
  if (mailText) parts.push(mailText);
  const taskWake = buildTaskRunWakeReminder(executionState);
  if (taskWake) parts.push(taskWake);
  else if (shouldAutoContinuePlan(executionState)) {
    const planWake = buildPlanAutoContinueReminder(executionState);
    if (planWake) parts.push(planWake);
  }
  return parts.join("\n\n").trim();
}

/**
 * Build a fresh Agent Loop message list for one TaskFocus-scoped model turn.
 */
function buildIsolatedTaskFocusTurn(executionState = null, options = {}) {
  const run = pickPrimaryAwaitingRun(executionState);
  const focusText = rebuildFocusText(executionState, run);
  const childHint = compactChildGraphHint(executionState, run);
  const wakeText = String(options.wakeText || "").trim()
    || buildIsolationWakeText(executionState, options.mailboxEvents || []);
  const userNudge = String(options.userNudge || "").trim();

  const content = [
    "Isolated TaskFocus turn (no prior Agent Loop transcript).",
    "Serve only the current task / child graph. Do not re-litigate finished plan nodes.",
    focusText,
    childHint,
    wakeText,
    userNudge,
  ].filter(Boolean).join("\n\n");

  return {
    isolated: true,
    taskRunId: run && run.id ? String(run.id) : "",
    childGraphId: run && run.childGraphId ? String(run.childGraphId) : "",
    parentNodeId: run && run.parentNodeId ? String(run.parentNodeId) : "",
    messages: [{ role: "user", content }],
  };
}

/**
 * Drop runner-only fields before a tool result is serialized into model messages.
 * executionState alone can be hundreds of KB and must never enter the prompt.
 */
function sanitizeToolResultForModel(toolResult = null) {
  if (!toolResult || typeof toolResult !== "object" || Array.isArray(toolResult)) {
    return toolResult;
  }
  const {
    executionState,
    compile,
    taskLoopResume,
    ...rest
  } = toolResult;
  if (rest.modelPayload && typeof rest.modelPayload === "object") {
    const {
      executionState: nestedState,
      compile: nestedCompile,
      ...payloadRest
    } = rest.modelPayload;
    rest.modelPayload = payloadRest;
    void nestedState;
    void nestedCompile;
  }
  void executionState;
  void compile;
  void taskLoopResume;
  return rest;
}

module.exports = {
  shouldIsolateTaskFocusTurn,
  pickPrimaryAwaitingRun,
  rebuildFocusText,
  compactChildGraphHint,
  buildIsolationWakeText,
  buildIsolatedTaskFocusTurn,
  sanitizeToolResultForModel,
  waitingPlanNode,
};

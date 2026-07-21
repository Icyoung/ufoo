"use strict";

/**
 * Route graph yields to the owning loop mailbox.
 */

const { isTaskLoopOwner } = require("./graphOwner");
const { enqueueAgentRuntime, enqueueTaskEvent } = require("./loopMailbox");
const { createRuntimeEvent } = require("./runtimeEvents");

function routeGraphYield(executionState = null, {
  graph = null,
  reason = "",
  waitingFor = null,
} = {}) {
  const owner = graph && graph.owner ? graph.owner : null;
  const graphId = graph && graph.graphId ? graph.graphId : "";
  const payload = {
    graphId,
    reason: String(reason || "").trim() || "llm_required",
    waitingFor: waitingFor || null,
  };

  if (isTaskLoopOwner(owner)) {
    return enqueueTaskEvent(executionState, owner.taskRunId, {
      kind: "graph_yield",
      ...payload,
    });
  }

  // Parent / agent-owned graph: surface as runtime event (not user message).
  return enqueueAgentRuntime(executionState, createRuntimeEvent("parent_graph_ready_changed", {
    readyNodes: waitingFor && waitingFor.id ? [waitingFor.id] : [],
    graphId,
    yieldReason: payload.reason,
    waitingFor,
  }));
}

module.exports = {
  routeGraphYield,
};

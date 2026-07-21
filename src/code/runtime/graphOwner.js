"use strict";

/**
 * Graph ownership: which loop consumes waiting_llm / yields.
 */

function agentLoopOwner(agentLoopId = "agent") {
  return {
    kind: "agent_loop",
    agentLoopId: String(agentLoopId || "agent").trim() || "agent",
  };
}

function taskLoopOwner(taskRunId = "") {
  return {
    kind: "task_loop",
    taskRunId: String(taskRunId || "").trim(),
  };
}

function normalizeGraphOwner(source = null) {
  if (!source || typeof source !== "object") return agentLoopOwner();
  const kind = String(source.kind || "").trim();
  if (kind === "task_loop") {
    const taskRunId = String(source.taskRunId || "").trim();
    if (!taskRunId) return agentLoopOwner();
    return taskLoopOwner(taskRunId);
  }
  return agentLoopOwner(source.agentLoopId);
}

function isTaskLoopOwner(owner = null) {
  return Boolean(owner && owner.kind === "task_loop" && owner.taskRunId);
}

module.exports = {
  agentLoopOwner,
  taskLoopOwner,
  normalizeGraphOwner,
  isTaskLoopOwner,
};

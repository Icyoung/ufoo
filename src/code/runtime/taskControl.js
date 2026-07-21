"use strict";

/**
 * plan_graph control-plane actions:
 * start_task / cancel_task / fail_task / complete_task / skip_node / cancel_subtree.
 *
 * complete_task:
 * - taskRunId → owning TaskLoop submitting TaskRun result
 * - nodeId → Graph owner completing waiting_llm inline_llm/expand work
 */

const { agentLoopOwner } = require("./graphOwner");
const {
  createTaskRun,
  putTaskRun,
  findActiveTaskRunForNode,
  getTaskRun,
  casTaskRunStatus,
  isTerminalTaskRun,
  getCachedControlCommand,
  cacheControlCommand,
  listActiveWritingTaskRuns,
} = require("./taskRun");
const {
  createChildGraphState,
  setGraph,
  getGraph,
  ensureGraphs,
  processTaskRun,
  finalizeFailure,
  syncParentNodeFromRun,
} = require("./taskLoop");
const { enqueueTaskEvent } = require("./loopMailbox");
const { getExecutionKind } = require("./taskFocus");
const {
  countWriteLeases,
  MAX_CONCURRENT_WRITE_LEASES,
} = require("./workspaceLease");
const { applyControlNodeAction } = require("../context/planGraph");

function findParentNode(executionState = null, nodeId = "") {
  ensureGraphs(executionState);
  const parent = executionState.planGraph;
  if (!parent || !Array.isArray(parent.nodes)) return { parent: null, node: null };
  const node = parent.nodes.find((n) => n && n.id === nodeId) || null;
  return { parent, node };
}

function dependenciesSatisfied(parent = null, node = null) {
  if (!node) return { ok: false, dependencies: [] };
  const byId = new Map((parent.nodes || []).map((n) => [n.id, n]));
  const unmet = [];
  for (const depId of node.dependsOn || []) {
    const dep = byId.get(depId);
    if (!dep || dep.status !== "succeeded") {
      unmet.push({ id: depId, status: dep ? dep.status : "missing" });
    }
  }
  return { ok: unmet.length === 0, dependencies: unmet };
}

function startTask(executionState = null, {
  nodeId = "",
  commandId = "",
  runTool = null,
  knownTools = null,
  processImmediately = true,
} = {}) {
  const cached = getCachedControlCommand(executionState, commandId);
  if (cached) return { ...cached, idempotentReplay: true };

  const id = String(nodeId || "").trim();
  const { parent, node } = findParentNode(executionState, id);
  if (!parent || !node) {
    return {
      status: "rejected",
      ok: false,
      errors: [{ code: "NODE_NOT_FOUND", message: `task node missing: ${id}` }],
    };
  }
  if (node.type !== "task") {
    return {
      status: "rejected",
      ok: false,
      errors: [{ code: "NOT_A_TASK", message: `node ${id} is not a task` }],
    };
  }
  const kind = getExecutionKind(node);
  if (kind !== "task_loop") {
    return {
      status: "rejected",
      ok: false,
      errors: [{
        code: "NOT_TASK_LOOP",
        message: `node ${id} execution.kind must be task_loop (got ${kind})`,
      }],
    };
  }

  const active = findActiveTaskRunForNode(executionState, id);
  if (active) {
    const payload = {
      status: "already_running",
      ok: true,
      graphId: parent.graphId || "",
      nodeId: id,
      taskRunId: active.id,
      childGraphId: active.childGraphId,
      parentNodeStatus: "running",
    };
    cacheControlCommand(executionState, commandId, payload);
    return payload;
  }

  const deps = dependenciesSatisfied(parent, node);
  if (!deps.ok) {
    return {
      status: "rejected",
      ok: false,
      errors: [{
        code: "DEPENDENCIES_NOT_SATISFIED",
        message: `dependencies not succeeded for ${id}`,
        dependencies: deps.dependencies,
      }],
    };
  }

  const activeCount = listActiveWritingTaskRuns(executionState).length;
  const leaseCount = countWriteLeases(executionState);
  if (activeCount >= MAX_CONCURRENT_WRITE_LEASES || leaseCount >= MAX_CONCURRENT_WRITE_LEASES) {
    return {
      status: "rejected",
      ok: false,
      errors: [{
        code: "MAX_CONCURRENT_TASKS",
        message: `At most ${MAX_CONCURRENT_WRITE_LEASES} concurrent writing TaskRuns`,
        max: MAX_CONCURRENT_WRITE_LEASES,
        current: Math.max(activeCount, leaseCount),
      }],
    };
  }

  // Freeze spec snapshot on node.runtime
  if (!node.runtime || typeof node.runtime !== "object") node.runtime = {};
  node.runtime.specFrozen = {
    objective: node.objective,
    title: node.title,
    dependsOn: (node.dependsOn || []).slice(),
    execution: node.execution && typeof node.execution === "object"
      ? JSON.parse(JSON.stringify(node.execution))
      : { kind: "task_loop" },
  };

  const run = createTaskRun({
    parentGraphId: parent.graphId || "",
    parentNodeId: id,
    attempt: (Number(node.attempt) || 0) + 1,
  });
  const child = createChildGraphState({
    parentGraphId: parent.graphId || "",
    parentNodeId: id,
    taskRunId: run.id,
    objective: node.objective || node.title || id,
  });
  run.childGraphId = child.graphId;
  putTaskRun(executionState, run);
  setGraph(executionState, child);

  // Ensure parent has owner
  if (!parent.owner) parent.owner = agentLoopOwner();
  node.status = "running";
  node.attempt = run.attempt;
  syncParentNodeFromRun(executionState, run);

  const payload = {
    status: "started",
    ok: true,
    graphId: parent.graphId || "",
    nodeId: id,
    taskRunId: run.id,
    childGraphId: child.graphId,
    parentNodeStatus: "running",
  };
  cacheControlCommand(executionState, commandId, payload);

  enqueueTaskEvent(executionState, run.id, { kind: "advance" });

  if (processImmediately) {
    processTaskRun(executionState, run.id, { runTool, knownTools });
  }

  return payload;
}

function cancelTask(executionState = null, {
  nodeId = "",
  reason = "",
  commandId = "",
} = {}) {
  const cached = getCachedControlCommand(executionState, commandId);
  if (cached) return { ...cached, idempotentReplay: true };

  const id = String(nodeId || "").trim();
  const active = findActiveTaskRunForNode(executionState, id);
  if (!active) {
    const { node } = findParentNode(executionState, id);
    if (node && (node.status === "succeeded" || node.status === "failed" || node.status === "cancelled")) {
      return {
        status: "rejected",
        ok: false,
        errors: [{
          code: "TASK_ALREADY_TERMINAL",
          message: `task ${id} already ${node.status}`,
          currentStatus: node.status,
        }],
      };
    }
    return {
      status: "rejected",
      ok: false,
      errors: [{ code: "TASK_NOT_RUNNING", message: `no active run for ${id}` }],
    };
  }

  if (isTerminalTaskRun(active)) {
    return {
      status: "rejected",
      ok: false,
      errors: [{
        code: "TASK_ALREADY_TERMINAL",
        message: `task run already ${active.status}`,
        currentStatus: active.status,
      }],
    };
  }

  casTaskRunStatus(executionState, active.id, {
    expectedStatus: active.status,
    nextStatus: "cancelling",
    error: { code: "TASK_CANCELLED", message: String(reason || "cancelled") },
  });
  enqueueTaskEvent(executionState, active.id, {
    kind: "control",
    op: "cancel_task",
    reason: String(reason || ""),
  });
  const done = finalizeFailure(executionState, active.id, {
    code: "TASK_CANCELLED",
    message: String(reason || "cancelled"),
  }, "cancelling");

  const payload = {
    status: "accepted",
    ok: Boolean(done.ok),
    nodeId: id,
    taskRunId: active.id,
    parentNodeStatus: done.run ? done.run.status : "cancelled",
  };
  cacheControlCommand(executionState, commandId, payload);
  return payload;
}

function failTask(executionState = null, {
  nodeId = "",
  reason = "",
  commandId = "",
} = {}) {
  const cached = getCachedControlCommand(executionState, commandId);
  if (cached) return { ...cached, idempotentReplay: true };

  const id = String(nodeId || "").trim();
  const active = findActiveTaskRunForNode(executionState, id);
  if (!active) {
    const { node } = findParentNode(executionState, id);
    if (node && (node.status === "succeeded" || node.status === "failed" || node.status === "cancelled")) {
      return {
        status: "rejected",
        ok: false,
        errors: [{
          code: "TASK_ALREADY_TERMINAL",
          message: `task ${id} already ${node.status}`,
          currentStatus: node.status,
        }],
      };
    }
    return {
      status: "rejected",
      ok: false,
      errors: [{ code: "TASK_NOT_RUNNING", message: `no active run for ${id}` }],
    };
  }
  if (isTerminalTaskRun(active)) {
    return {
      status: "rejected",
      ok: false,
      errors: [{
        code: "TASK_ALREADY_TERMINAL",
        currentStatus: active.status,
      }],
    };
  }

  casTaskRunStatus(executionState, active.id, {
    expectedStatus: active.status === "cancelling" ? "cancelling" : "running",
    nextStatus: "cancelling",
    error: { code: "TASK_FAILED", message: String(reason || "failed") },
  });
  const done = finalizeFailure(executionState, active.id, {
    code: "TASK_FAILED",
    message: String(reason || "failed"),
  }, "cancelling");

  const payload = {
    status: done.ok ? "accepted" : "rejected",
    ok: Boolean(done.ok),
    nodeId: id,
    taskRunId: active.id,
    parentNodeStatus: done.run ? done.run.status : "failed",
    errors: done.ok ? undefined : [{ code: done.code || "CAS_FAILED", currentStatus: done.currentStatus }],
  };
  cacheControlCommand(executionState, commandId, payload);
  return payload;
}

function completeTaskFromLoop(executionState = null, {
  taskRunId = "",
  result = {},
  commandId = "",
} = {}) {
  const cached = getCachedControlCommand(executionState, commandId);
  if (cached) return { ...cached, idempotentReplay: true };

  const run = getTaskRun(executionState, taskRunId);
  if (!run) {
    return {
      status: "rejected",
      ok: false,
      errors: [{ code: "TASK_RUN_NOT_FOUND", message: "task run missing" }],
    };
  }
  enqueueTaskEvent(executionState, run.id, {
    kind: "control",
    op: "complete_task",
    result: result && typeof result === "object" ? result : {},
  });
  const tick = processTaskRun(executionState, run.id, {});
  const live = getTaskRun(executionState, run.id);
  const payload = {
    status: live && live.status === "succeeded" ? "accepted" : "rejected",
    ok: Boolean(live && live.status === "succeeded"),
    taskRunId: run.id,
    parentNodeStatus: live ? live.status : "",
    result: live && live.result,
    tick,
  };
  if (!payload.ok && live && isTerminalTaskRun(live)) {
    payload.errors = [{
      code: "TASK_ALREADY_TERMINAL",
      currentStatus: live.status,
    }];
  }
  cacheControlCommand(executionState, commandId, payload);
  return payload;
}

function completeInlineTask(executionState = null, {
  nodeId = "",
  result = null,
  output = null,
  summary = "",
  commandId = "",
} = {}) {
  const cached = getCachedControlCommand(executionState, commandId);
  if (cached) return { ...cached, idempotentReplay: true };

  ensureGraphs(executionState);
  const applied = applyControlNodeAction(executionState.planGraph, {
    op: "complete_task",
    nodeId,
    result,
    output,
    summary,
  });
  if (!applied.ok) {
    return {
      status: "rejected",
      ok: false,
      errors: applied.errors || [{ code: "COMPLETE_REJECTED", message: "complete_task rejected" }],
    };
  }
  const live = (executionState.planGraph.nodes || []).find((n) => n && n.id === nodeId);
  const payload = {
    status: "accepted",
    ok: true,
    nodeId,
    parentNodeStatus: live ? live.status : "succeeded",
    result: live ? live.result : null,
    stateRevision: Number(executionState.planGraph.stateRevision) || 0,
  };
  cacheControlCommand(executionState, commandId, payload);
  return payload;
}

function skipNode(executionState = null, {
  nodeId = "",
  reason = "",
  commandId = "",
} = {}) {
  const cached = getCachedControlCommand(executionState, commandId);
  if (cached) return { ...cached, idempotentReplay: true };

  ensureGraphs(executionState);
  const applied = applyControlNodeAction(executionState.planGraph, {
    op: "skip_node",
    nodeId,
    reason,
  });
  if (!applied.ok) {
    return {
      status: "rejected",
      ok: false,
      errors: applied.errors || [{ code: "SKIP_REJECTED", message: "skip_node rejected" }],
    };
  }
  const payload = {
    status: "accepted",
    ok: true,
    nodeId,
    parentNodeStatus: "skipped",
    stateRevision: Number(executionState.planGraph.stateRevision) || 0,
  };
  cacheControlCommand(executionState, commandId, payload);
  return payload;
}

function cancelSubtree(executionState = null, {
  nodeId = "",
  reason = "",
  commandId = "",
} = {}) {
  const cached = getCachedControlCommand(executionState, commandId);
  if (cached) return { ...cached, idempotentReplay: true };

  ensureGraphs(executionState);
  const applied = applyControlNodeAction(executionState.planGraph, {
    op: "cancel_subtree",
    nodeId,
    reason,
  });
  if (!applied.ok) {
    return {
      status: "rejected",
      ok: false,
      errors: applied.errors || [{ code: "CANCEL_SUBTREE_REJECTED", message: "cancel_subtree rejected" }],
    };
  }
  const payload = {
    status: "accepted",
    ok: true,
    nodeId,
    parentNodeStatus: "cancelled",
    stateRevision: Number(executionState.planGraph.stateRevision) || 0,
  };
  cacheControlCommand(executionState, commandId, payload);
  return payload;
}

function runControlActions(executionState = null, {
  actions = [],
  commandId = "",
  runTool = null,
  knownTools = null,
} = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const results = [];
  for (const action of list) {
    const op = String(action && action.op || "").trim().toLowerCase();
    if (op === "start_task") {
      results.push(startTask(executionState, {
        nodeId: action.nodeId,
        commandId: commandId && list.length === 1 ? commandId : `${commandId}:${op}:${action.nodeId}`,
        runTool,
        knownTools,
      }));
    } else if (op === "cancel_task") {
      results.push(cancelTask(executionState, {
        nodeId: action.nodeId,
        reason: action.reason,
        commandId: commandId && list.length === 1 ? commandId : `${commandId}:${op}:${action.nodeId}`,
      }));
    } else if (op === "fail_task" || op === "mark_task_failed") {
      results.push(failTask(executionState, {
        nodeId: action.nodeId,
        reason: action.reason,
        commandId: commandId && list.length === 1 ? commandId : `${commandId}:${op}:${action.nodeId}`,
      }));
    } else if (op === "complete_task") {
      const taskRunId = String(action.taskRunId || "").trim();
      if (taskRunId) {
        results.push(completeTaskFromLoop(executionState, {
          taskRunId,
          result: action.result,
          commandId: commandId && list.length === 1 ? commandId : `${commandId}:${op}:${taskRunId}`,
        }));
      } else {
        results.push(completeInlineTask(executionState, {
          nodeId: action.nodeId,
          result: action.result,
          output: action.output,
          summary: action.summary,
          commandId: commandId && list.length === 1
            ? commandId
            : `${commandId}:${op}:${action.nodeId}`,
        }));
      }
    } else if (op === "skip_node") {
      results.push(skipNode(executionState, {
        nodeId: action.nodeId,
        reason: action.reason,
        commandId: commandId && list.length === 1 ? commandId : `${commandId}:${op}:${action.nodeId}`,
      }));
    } else if (op === "cancel_subtree") {
      results.push(cancelSubtree(executionState, {
        nodeId: action.nodeId,
        reason: action.reason,
        commandId: commandId && list.length === 1 ? commandId : `${commandId}:${op}:${action.nodeId}`,
      }));
    } else if (op === "fail_current_task") {
      results.push(failTask(executionState, {
        nodeId: action.nodeId || (getTaskRun(executionState, action.taskRunId) || {}).parentNodeId,
        reason: action.reason,
        commandId: commandId && list.length === 1 ? commandId : `${commandId}:${op}`,
      }));
    } else {
      results.push({
        status: "rejected",
        ok: false,
        errors: [{ code: "UNKNOWN_CONTROL_OP", message: `unknown control op: ${op}` }],
      });
    }
  }
  const ok = results.every((r) => r && r.ok !== false && r.status !== "rejected");
  const errors = [];
  for (const r of results) {
    if (r && Array.isArray(r.errors)) errors.push(...r.errors);
  }
  return {
    status: ok ? "accepted" : "rejected",
    ok,
    results,
    errors: errors.length ? errors : undefined,
  };
}

module.exports = {
  startTask,
  cancelTask,
  failTask,
  completeTaskFromLoop,
  completeInlineTask,
  skipNode,
  cancelSubtree,
  runControlActions,
  dependenciesSatisfied,
};

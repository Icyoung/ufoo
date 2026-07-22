"use strict";

/**
 * Event-driven TaskLoop worker (in-process, persist on executionState).
 * Advances one step per processTaskRun call — recoverable across restarts
 * as long as executionState.taskRuns is persisted with the session.
 */

const { createPlanId } = require("../context/planGraph");
const {
  emptyPlanGraphState,
  runPlanGraphCommand,
  ensurePlanGraphState,
} = require("../context/planGraphService");
const { taskLoopOwner } = require("./graphOwner");
const { createRuntimeEvent } = require("./runtimeEvents");
const {
  enqueueAgentRuntime,
  enqueueTaskEvent,
  drainTaskMailbox,
} = require("./loopMailbox");
const {
  getTaskRun,
  putTaskRun,
  casTaskRunStatus,
  isTerminalTaskRun,
} = require("./taskRun");
const {
  acquireTaskWriteLease,
  releaseTaskWriteLease,
} = require("./workspaceLease");
const { buildTaskFocus, renderTaskFocusText } = require("./taskFocus");
const { recordToolProvenance, getProvenanceChangedFiles } = require("./toolProvenance");
const { routeGraphYield } = require("./graphYieldRouter");
const { checkWriteAllowed } = require("./workspaceLease");

function ensureGraphs(executionState = null) {
  const state = ensurePlanGraphState(executionState);
  if (!state.graphs || typeof state.graphs !== "object") {
    state.graphs = {};
  }
  if (state.planGraph && state.planGraph.graphId) {
    state.graphs[state.planGraph.graphId] = state.planGraph;
  }
  return state;
}

function getGraph(executionState = null, graphId = "") {
  const state = ensureGraphs(executionState);
  const id = String(graphId || "").trim();
  if (id && state.graphs[id]) return state.graphs[id];
  if (state.planGraph && (!id || state.planGraph.graphId === id)) return state.planGraph;
  return null;
}

function setGraph(executionState = null, graph = null) {
  const state = ensureGraphs(executionState);
  if (!graph || !graph.graphId) return;
  state.graphs[graph.graphId] = graph;
  if (!state.planGraph || state.planGraph.graphId === graph.graphId || !state.planGraph.graphId) {
    // Keep parent as planGraph when this is parent; child graphs stay in graphs map.
    if (graph.owner && graph.owner.kind === "agent_loop") {
      state.planGraph = graph;
    }
  }
}

function createChildGraphState({
  parentGraphId = "",
  parentNodeId = "",
  taskRunId = "",
  objective = "",
} = {}) {
  const graph = emptyPlanGraphState();
  graph.graphId = createPlanId("child");
  graph.objective = String(objective || "").trim();
  graph.owner = taskLoopOwner(taskRunId);
  graph.parentGraphId = String(parentGraphId || "").trim();
  graph.parentNodeId = String(parentNodeId || "").trim();
  graph.nodes = [
    {
      id: "root",
      type: "task",
      title: objective || "Execute task",
      objective: objective || "Execute task",
      execution: { kind: "expand" },
      dependsOn: [],
      status: "pending",
    },
  ];
  return graph;
}

function emitParentReadyChanged(executionState = null) {
  const parent = executionState && executionState.planGraph;
  if (!parent) return;
  const readyNodes = (Array.isArray(parent.nodes) ? parent.nodes : [])
    .filter((n) => n && n.status === "ready")
    .map((n) => n.id);
  enqueueAgentRuntime(executionState, createRuntimeEvent("parent_graph_ready_changed", {
    readyNodes,
    graphId: parent.graphId || "",
  }));
}

function syncParentNodeFromRun(executionState = null, run = null) {
  if (!run) return;
  const parent = getGraph(executionState, run.parentGraphId) || executionState.planGraph;
  if (!parent || !Array.isArray(parent.nodes)) return;
  const node = parent.nodes.find((n) => n && n.id === run.parentNodeId);
  if (!node) return;
  if (!node.runtime || typeof node.runtime !== "object") node.runtime = {};
  node.runtime.taskRunId = run.id;
  node.runtime.childGraphId = run.childGraphId;
  node.runtime.phase = run.phase;
  if (run.status === "running" || run.status === "queued" || run.status === "cancelling") {
    node.status = "running";
  } else if (run.status === "succeeded") {
    node.status = "succeeded";
    node.result = run.result;
    node.runtime.result = run.result;
  } else if (run.status === "failed") {
    node.status = "failed";
    node.error = (run.error && run.error.message) || run.error || "task failed";
    node.runtime.error = run.error;
  } else if (run.status === "cancelled") {
    node.status = "cancelled";
    node.runtime.error = run.error;
  }
  setGraph(executionState, parent);
  if (executionState.planGraph && executionState.planGraph.graphId === parent.graphId) {
    executionState.planGraph = parent;
  }
}

function finalizeSuccess(executionState = null, taskRunId = "", result = {}) {
  const provenanceFiles = getProvenanceChangedFiles(executionState, taskRunId);
  const mergedResult = result && typeof result === "object" ? { ...result } : {};
  const fromResult = Array.isArray(mergedResult.changedFiles) ? mergedResult.changedFiles.map(String) : [];
  mergedResult.changedFiles = Array.from(new Set(provenanceFiles.concat(fromResult)));
  const cas = casTaskRunStatus(executionState, taskRunId, {
    expectedStatus: "running",
    nextStatus: "succeeded",
    phase: "finalizing",
    result: mergedResult,
    changedFiles: mergedResult.changedFiles,
  });
  if (!cas.ok) return cas;
  releaseTaskWriteLease(executionState, taskRunId);
  syncParentNodeFromRun(executionState, cas.run);
  enqueueAgentRuntime(executionState, createRuntimeEvent("task_succeeded", {
    taskId: cas.run.parentNodeId,
    taskRunId: cas.run.id,
    result: mergedResult,
  }));
  emitParentReadyChanged(executionState);
  return cas;
}

function finalizeFailure(executionState = null, taskRunId = "", error = {}, expectedStatus = "running") {
  const cas = casTaskRunStatus(executionState, taskRunId, {
    expectedStatus,
    nextStatus: expectedStatus === "cancelling" ? "cancelled" : "failed",
    phase: "finalizing",
    error,
  });
  if (!cas.ok) {
    // If already cancelling and we wanted failed, try cancelled path
    if (expectedStatus === "running") {
      return casTaskRunStatus(executionState, taskRunId, {
        expectedStatus: "cancelling",
        nextStatus: "failed",
        phase: "finalizing",
        error,
      });
    }
    return cas;
  }
  releaseTaskWriteLease(executionState, taskRunId);
  syncParentNodeFromRun(executionState, cas.run);
  const eventType = cas.run.status === "cancelled" ? "task_cancelled" : "task_failed";
  enqueueAgentRuntime(executionState, createRuntimeEvent(eventType, {
    taskId: cas.run.parentNodeId,
    taskRunId: cas.run.id,
    error,
  }));
  emitParentReadyChanged(executionState);
  return cas;
}

/**
 * One worker tick for a TaskRun.
 */
function processTaskRun(executionState = null, taskRunId = "", options = {}) {
  const run = getTaskRun(executionState, taskRunId);
  if (!run) return { ok: false, code: "TASK_RUN_NOT_FOUND" };
  if (isTerminalTaskRun(run)) return { ok: true, status: run.status, terminal: true };

  if (run.cancelRequested || run.status === "cancelling") {
    return finalizeFailure(executionState, taskRunId, {
      code: "TASK_CANCELLED",
      message: (run.error && run.error.message) || "cancelled",
    }, "cancelling");
  }

  if (run.status === "queued") {
    const lease = acquireTaskWriteLease(executionState, run.id);
    if (!lease.ok) {
      return { ok: false, code: lease.code, owner: lease.owner, deferred: true };
    }
    casTaskRunStatus(executionState, run.id, {
      expectedStatus: "queued",
      nextStatus: "running",
      phase: "planning",
    });
    enqueueAgentRuntime(executionState, createRuntimeEvent("task_started", {
      taskId: run.parentNodeId,
      taskRunId: run.id,
    }));
  }

  const live = getTaskRun(executionState, taskRunId);
  const child = getGraph(executionState, live.childGraphId);
  if (!child) {
    return finalizeFailure(executionState, taskRunId, {
      code: "CHILD_GRAPH_MISSING",
      message: "child graph missing",
    });
  }

  // Drain control signals from task mailbox
  const events = drainTaskMailbox(executionState, taskRunId);
  for (const evt of events) {
    if (evt.kind === "control" && evt.op === "complete_task") {
      return finalizeSuccess(executionState, taskRunId, evt.result || {});
    }
    if (evt.kind === "control" && (evt.op === "fail_current_task" || evt.op === "fail_task")) {
      return finalizeFailure(executionState, taskRunId, {
        code: "TASK_FAILED",
        message: String(evt.reason || "failed"),
      });
    }
  }

  const parent = live.parentGraphId
    ? (getGraph(executionState, live.parentGraphId) || executionState.planGraph)
    : null;
  const standalone = !live.parentNodeId;
  const focus = buildTaskFocus({
    nodes: parent && parent.nodes ? parent.nodes : [],
    currentNodeId: live.parentNodeId,
    taskRunsById: (executionState.taskRuns && executionState.taskRuns.byId) || {},
    recentlyChangedFiles: executionState.modifiedFiles || [],
    standaloneTask: standalone
      ? {
        id: live.id,
        objective: live.objective || live.title || "",
        title: live.title || live.objective || live.id,
        status: live.status,
      }
      : null,
  });
  live.lastFocusText = renderTaskFocusText(focus);
  putTaskRun(executionState, live);

  // Advance child graph tools if runTool provided
  if (typeof options.runTool === "function") {
    const previousActive = executionState.planGraph;
    executionState.planGraph = child;
    const wrappedRunTool = (toolInput = {}) => {
      const current = getTaskRun(executionState, taskRunId);
      if (!current || current.cancelRequested || current.status === "cancelling") {
        return { ok: false, error: "task cancelled", code: "TASK_CANCELLED" };
      }
      const leaseCheck = checkWriteAllowed(executionState, {
        tool: toolInput.tool || (toolInput.node && toolInput.node.tool),
        originKind: "task_loop",
        taskRunId,
      });
      if (!leaseCheck.ok) {
        return {
          ok: false,
          error: leaseCheck.code,
          code: leaseCheck.code,
          owner: leaseCheck.owner,
        };
      }
      const toolName = toolInput.tool || (toolInput.node && toolInput.node.tool) || "";
      const args = toolInput.args || {};
      recordToolProvenance(executionState, {
        taskRunId,
        tool: toolName,
        args,
        graphId: live.childGraphId,
        nodeId: (toolInput.node && toolInput.node.id) || toolInput.stepId || "",
      });
      return options.runTool(toolInput);
    };
    try {
      const advanced = runPlanGraphCommand({
        operation: "patch",
        operations: [],
        commandId: `advance_${live.id}_${Date.now()}`,
      }, {
        executionState,
        runTool: wrappedRunTool,
        autoAdvance: true,
        knownTools: options.knownTools,
      });
      // Persist child back
      if (executionState.planGraph) {
        executionState.planGraph.owner = child.owner;
        executionState.planGraph.parentGraphId = child.parentGraphId;
        executionState.planGraph.parentNodeId = child.parentNodeId;
        setGraph(executionState, executionState.planGraph);
      }
      const after = getGraph(executionState, live.childGraphId) || executionState.planGraph;
      casTaskRunStatus(executionState, live.id, {
        expectedStatus: "running",
        nextStatus: "running",
        phase: after && after.waitingFor ? "waiting_model" : "executing_tools",
      });
      syncParentNodeFromRun(executionState, getTaskRun(executionState, taskRunId));

      if (after && after.waitingFor) {
        routeGraphYield(executionState, {
          graph: after,
          reason: after.lastYieldReason || "llm_required",
          waitingFor: after.waitingFor,
        });
        enqueueTaskEvent(executionState, live.id, {
          kind: "model_turn",
          waitingFor: after.waitingFor,
          focusText: live.lastFocusText,
        });
        return {
          ok: true,
          status: "running",
          yieldReason: "llm_required",
          focusText: live.lastFocusText,
          waitingFor: after.waitingFor,
          advance: advanced.modelPayload || advanced,
        };
      }
      return {
        ok: true,
        status: "running",
        yieldReason: "awaiting_complete_task",
        focusText: live.lastFocusText,
        advance: advanced.modelPayload || advanced,
      };
    } finally {
      executionState.planGraph = previousActive;
    }
  }

  enqueueTaskEvent(executionState, live.id, {
    kind: "model_turn",
    focusText: live.lastFocusText,
  });
  return {
    ok: true,
    status: "running",
    yieldReason: "llm_required",
    focusText: live.lastFocusText,
  };
}

/**
 * Resume queued/running TaskRuns after process restart (executionState restored).
 * Requeues interrupted mid-tool/model runs, releases stale leases, then advances.
 */
function resumePersistedTaskRuns(executionState = null, options = {}) {
  const state = ensureGraphs(executionState);
  const {
    recoverTaskRunsAfterRestart,
  } = require("./taskRun");
  const { releaseStaleWriteLeases } = require("./workspaceLease");
  const recovery = recoverTaskRunsAfterRestart(state);
  const leases = releaseStaleWriteLeases(state, {
    maxAgeMs: options.leaseStaleMs,
  });
  const byId = state.taskRuns && state.taskRuns.byId ? state.taskRuns.byId : {};
  const results = [];
  for (const run of Object.values(byId)) {
    if (!run) continue;
    if (run.status !== "queued" && run.status !== "running" && run.status !== "cancelling") {
      continue;
    }
    results.push(processTaskRun(state, run.id, options));
  }
  return { recovery, leases, results };
}

module.exports = {
  ensureGraphs,
  getGraph,
  setGraph,
  createChildGraphState,
  processTaskRun,
  finalizeSuccess,
  finalizeFailure,
  syncParentNodeFromRun,
  resumePersistedTaskRuns,
};

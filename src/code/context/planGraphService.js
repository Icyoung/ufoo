"use strict";

/**
 * Control-plane Graph Service for plan_graph tool + legacy side-effect bridge.
 *
 * Ownership:
 * - Models mutate graph *spec* via create/patch (no arbitrary status writes).
 * - Scheduler/Executor owns ready/running/succeeded/failed/blocked for tools.
 * - control.complete_task is the model path to finish waiting_llm / TaskRuns.
 * - control.skip_node / cancel_subtree are runtime status actions (not patch).
 */

const {
  createPlanId,
  normalizePlanGraph,
  normalizePlanNode,
  compilePlanGraph,
  applyPlanOperations,
  executePlanGraph,
  planGraphFromExecutionSegment,
  getReadyNodes,
  isAggregateTask,
} = require("./planGraph");

function emptyPlanGraphState() {
  return {
    graphId: "",
    specRevision: 0,
    stateRevision: 0,
    // Compatibility alias used by older callers/tests.
    revision: 0,
    objective: "",
    failurePolicy: "continue_independent",
    nodes: [],
    outputs: {},
    waitingFor: null,
    lastStoppedAt: "",
    lastYieldReason: "",
    commandLog: {},
  };
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function ensurePlanGraphState(executionState = null) {
  const state = executionState && typeof executionState === "object"
    ? executionState
    : {};
  if (!state.planGraph || typeof state.planGraph !== "object") {
    state.planGraph = emptyPlanGraphState();
  } else {
    const pg = state.planGraph;
    if (!Number.isFinite(pg.specRevision)) pg.specRevision = Number(pg.revision) || 0;
    if (!Number.isFinite(pg.stateRevision)) pg.stateRevision = Number(pg.revision) || 0;
    if (!Number.isFinite(pg.revision)) pg.revision = pg.specRevision;
    if (!pg.commandLog || typeof pg.commandLog !== "object") pg.commandLog = {};
  }
  return state;
}

function listNodeIds(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).map((node) => node.id).filter(Boolean);
}

function summarizeReadyWaiting(nodes = []) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  const ready = getReadyNodes(byId).map((node) => node.id);
  const waiting = [];
  for (const node of byId.values()) {
    if (node.status === "pending" && !ready.includes(node.id)) waiting.push(node.id);
    if (node.status === "waiting_llm" || node.status === "waiting_approval") waiting.push(node.id);
  }
  return { readyNodes: ready, waitingNodes: Array.from(new Set(waiting)) };
}

function validationErrorsFromCompile(compiled = {}) {
  return (Array.isArray(compiled.errors) ? compiled.errors : []).map((message) => ({
    code: /cycle/i.test(message)
      ? "CYCLE_DETECTED"
      : (/unknown node|references unknown/i.test(message)
        ? "UNKNOWN_OUTPUT_REFERENCE"
        : (/duplicate/i.test(message) ? "DUPLICATE_NODE_ID" : "VALIDATION_ERROR")),
    message: String(message),
  }));
}

function rejected(errors = [], extras = {}) {
  return {
    ok: false,
    status: "rejected",
    errors: Array.isArray(errors) ? errors : [{ code: "VALIDATION_ERROR", message: String(errors) }],
    validationWarnings: [],
    ...extras,
  };
}

function accepted(payload = {}) {
  return {
    ok: true,
    status: "accepted",
    ...payload,
  };
}

function stripModelStatuses(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).map((node, index) => normalizePlanNode({
    ...node,
    status: "pending",
    attempt: 0,
    result: null,
    error: "",
    createdSeq: Number.isFinite(node.createdSeq) ? node.createdSeq : index + 1,
    // Models cannot author aggregate nodes.
    execution: node.type === "task" && node.execution === "aggregate" ? "llm" : node.execution,
  }, `n${index + 1}`));
}

function normalizeExpandOp(op = {}) {
  const next = { ...op };
  const type = String(op.op || op.type || "").trim().toLowerCase();
  if ((type === "expand" || type === "expand_node") && Array.isArray(op.children) && !op.with && !op.subgraph && !op.node) {
    // Keep children form; applyPlanOperations understands it as aggregate expand.
    next.op = "expand_node";
  }
  return next;
}

function executionSegmentToCreateGraph(segment = {}) {
  return planGraphFromExecutionSegment(segment);
}

/**
 * Normalize tool args OR legacy structured side effects into a plan_graph command.
 * Legacy body bridge is intentionally narrow: only explicit execution_segment.
 */
function normalizePlanGraphCommand(input = {}) {
  const source = input && typeof input === "object" ? input : null;
  if (!source) return null;

  const operation = String(source.operation || "").trim().toLowerCase();
  if (
    operation === "create"
    || operation === "patch"
    || operation === "inspect"
    || operation === "clear"
    || operation === "cancel_graph"
    || operation === "archive_graph"
    || operation === "control"
  ) {
    return {
      operation: operation === "clear" || operation === "archive_graph" ? "cancel_graph" : operation,
      graph: source.graph && typeof source.graph === "object" ? source.graph : null,
      operations: Array.isArray(source.operations) ? source.operations.map(normalizeExpandOp) : [],
      actions: Array.isArray(source.actions) ? source.actions : [],
      commandId: String(source.commandId || "").trim(),
      expectedSpecRevision: Number.isFinite(source.expectedSpecRevision)
        ? Math.floor(source.expectedSpecRevision)
        : null,
      graphId: String(source.graphId || "").trim(),
      reason: String(source.reason || "").trim(),
      source: "tool",
    };
  }

  // Strict legacy: only top-level execution_segment / nextSegment.
  if (source.nextSegment && typeof source.nextSegment === "object") {
    return {
      operation: "create",
      graph: executionSegmentToCreateGraph(source.nextSegment),
      operations: [],
      source: "legacy_segment",
    };
  }
  if (source.type === "execution_segment") {
    return {
      operation: "create",
      graph: executionSegmentToCreateGraph(source),
      operations: [],
      source: "legacy_segment",
    };
  }

  return null;
}

function snapshotNodes(planGraph = {}) {
  return Array.isArray(planGraph.nodes) ? cloneJson(planGraph.nodes) : [];
}

function applyStatusesFromStore(compiledNodes = [], storeNodes = [], options = {}) {
  const prior = new Map((Array.isArray(storeNodes) ? storeNodes : []).map((node) => [node.id, node]));
  const preferSourceStatus = options.preferSourceStatus === true;
  return compiledNodes.map((node) => {
    const old = prior.get(node.id);
    const sourceStatus = String(node.status || "").trim();
    let status = "pending";
    if (preferSourceStatus && sourceStatus && sourceStatus !== "pending") {
      status = sourceStatus;
    } else if (old && old.status) {
      status = old.status;
    } else if (sourceStatus) {
      status = sourceStatus;
    }
    if (!old) {
      return {
        ...node,
        status,
        result: node.result || null,
        error: node.error || "",
        attempt: Number.isFinite(node.attempt) ? node.attempt : 0,
      };
    }
    return {
      ...node,
      status,
      result: (preferSourceStatus && node.result) ? node.result : (old.result || node.result || null),
      error: (preferSourceStatus && node.error) ? node.error : (old.error || node.error || ""),
      stopKind: node.stopKind || old.stopKind || "",
      attempt: Number.isFinite(node.attempt) ? node.attempt : (Number.isFinite(old.attempt) ? old.attempt : 0),
      parentTaskId: node.parentTaskId || old.parentTaskId || "",
      execution: node.execution || old.execution,
      createdSeq: Number.isFinite(node.createdSeq) && node.createdSeq > 0
        ? node.createdSeq
        : (old.createdSeq || 0),
      generated: Boolean(node.generated || old.generated),
      displayOrder: Number.isFinite(node.displayOrder) ? node.displayOrder : (old.displayOrder || 0),
    };
  });
}

function restoreOutputsMap(planGraph = {}) {
  const outputs = new Map();
  const source = planGraph.outputs && typeof planGraph.outputs === "object" ? planGraph.outputs : {};
  for (const [id, value] of Object.entries(source)) {
    outputs.set(id, value);
  }
  for (const node of Array.isArray(planGraph.nodes) ? planGraph.nodes : []) {
    if (node && node.result && !outputs.has(node.id)) {
      outputs.set(node.id, node.result);
    }
  }
  return outputs;
}

function persistOutputs(outputs = new Map()) {
  const out = {};
  for (const [id, value] of outputs.entries()) out[id] = value;
  return out;
}

function compileStoredGraph(planGraph = {}, options = {}) {
  const compiled = compilePlanGraph({
    id: planGraph.graphId || createPlanId("plan"),
    objective: planGraph.objective || "",
    nodes: Array.isArray(planGraph.nodes) ? planGraph.nodes : [],
  }, options);
  if (!compiled.ok) return compiled;
  const withStatus = applyStatusesFromStore(compiled.nodes, planGraph.nodes);
  return {
    ...compiled,
    nodes: withStatus,
    nodeMap: new Map(withStatus.map((node) => [node.id, node])),
  };
}

function buildAdvanceSummary(result = {}, beforeStatuses = new Map()) {
  const nodes = Array.isArray(result.nodes) ? result.nodes : [];
  const executedNodes = [];
  const failedNodes = [];
  for (const node of nodes) {
    const before = beforeStatuses.get(node.id);
    const becameTerminal = node.status === "succeeded" || node.status === "failed";
    const wasPending = !before || before === "pending" || before === "waiting_llm" || before === "ready" || before === "running";
    if (becameTerminal && wasPending && before !== node.status) {
      const entry = {
        id: node.id,
        type: node.type,
        status: node.status,
        summary: (node.result && node.result.summary) || node.error || node.status,
      };
      if (node.status === "succeeded") executedNodes.push(entry);
      if (node.status === "failed") failedNodes.push(entry);
    }
  }
  const yieldReason = result.yieldReason
    || (result.stoppedAt === "waiting_llm" ? "task_ready" : (result.stoppedAt || ""));
  let advanceStatus = "completed";
  if (yieldReason === "graph_terminal") advanceStatus = "completed";
  else if (yieldReason) advanceStatus = "waiting";
  return {
    status: advanceStatus,
    yieldReason,
    executedNodes,
    failedNodes,
    waitingFor: result.waitingFor || null,
    stoppedAt: result.stoppedAt || "",
  };
}

function advanceStoredGraph(planGraph = {}, options = {}) {
  const beforeStatuses = new Map(
    (Array.isArray(planGraph.nodes) ? planGraph.nodes : []).map((node) => [node.id, node.status || "pending"]),
  );
  const compiled = compileStoredGraph(planGraph, options);
  if (!compiled.ok) {
    return {
      ok: false,
      compile: compiled,
      planGraph,
      errors: validationErrorsFromCompile(compiled),
    };
  }

  const seededOutputs = restoreOutputsMap(planGraph);
  const result = executePlanGraph(
    {
      id: compiled.planId,
      objective: compiled.objective,
      nodes: compiled.nodes,
    },
    {
      ...options,
      compiled,
      seedNodeMap: compiled.nodeMap,
      seedOutputs: seededOutputs,
      parallel: options.parallel !== false,
      failurePolicy: planGraph.failurePolicy || compiled.failurePolicy || "continue_independent",
    },
  );

  const next = {
    ...planGraph,
    graphId: compiled.planId || planGraph.graphId || createPlanId("plan"),
    objective: compiled.objective || planGraph.objective || "",
    failurePolicy: compiled.failurePolicy || planGraph.failurePolicy || "continue_independent",
    nodes: Array.isArray(result.nodes) ? result.nodes : compiled.nodes,
    outputs: persistOutputs(result.outputs || seededOutputs),
    waitingFor: result.waitingFor || null,
    lastStoppedAt: result.stoppedAt || "",
    lastYieldReason: result.yieldReason || "",
    stateRevision: (Number(planGraph.stateRevision) || 0) + 1,
  };
  next.revision = next.specRevision;

  return {
    ok: result.ok !== false,
    compile: compiled,
    planGraph: next,
    result,
    advance: buildAdvanceSummary(result, beforeStatuses),
    errors: result.ok === false && result.stoppedAt === "compile"
      ? validationErrorsFromCompile(compiled)
      : [],
  };
}

function projectPlanView(planGraph = {}) {
  const nodes = Array.isArray(planGraph.nodes) ? planGraph.nodes : [];
  const byParent = new Map();
  for (const node of nodes) {
    const parent = String(node.parentTaskId || "").trim();
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(node.id);
  }
  return nodes
    .filter((node) => !node.generated || node.type === "task")
    .concat(nodes.filter((node) => node.generated))
    .map((node) => ({
      id: node.id,
      title: node.title || node.objective || node.tool || node.id,
      parentId: node.parentTaskId || undefined,
      displayOrder: Number(node.displayOrder) || 0,
      status: node.status || "pending",
      type: node.type,
      execution: node.execution || "",
      generated: Boolean(node.generated),
      summary: (node.result && node.result.summary) || "",
      children: byParent.get(node.id) || [],
    }));
}

function inspectPlanGraph(planGraph = {}) {
  const nodes = Array.isArray(planGraph.nodes) ? planGraph.nodes : [];
  const { readyNodes, waitingNodes } = summarizeReadyWaiting(
    nodes.map((node) => ({ ...node, status: node.status || "pending" })),
  );
  return accepted({
    graphId: planGraph.graphId || "",
    commandRevision: Number(planGraph.specRevision) || 0,
    stateRevision: Number(planGraph.stateRevision) || 0,
    revision: Number(planGraph.specRevision) || 0,
    objective: planGraph.objective || "",
    nodesAdded: [],
    nodesUpdated: [],
    readyNodes,
    waitingNodes,
    waitingFor: planGraph.waitingFor || null,
    stoppedAt: planGraph.lastStoppedAt || "",
    yieldReason: planGraph.lastYieldReason || "",
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      status: node.status || "pending",
      tool: node.tool || "",
      title: node.title || node.objective || "",
      dependsOn: Array.isArray(node.dependsOn) ? node.dependsOn : [],
      parentTaskId: node.parentTaskId || "",
      execution: node.execution || "",
      generated: Boolean(node.generated),
    })),
    planView: projectPlanView(planGraph),
    validationWarnings: [],
  });
}

function cacheCommand(planGraph, commandId, payload) {
  if (!commandId) return;
  const log = planGraph.commandLog && typeof planGraph.commandLog === "object"
    ? { ...planGraph.commandLog }
    : {};
  log[commandId] = cloneJson(payload);
  planGraph.commandLog = log;
}

/**
 * Resolve which graph a plan_graph command targets.
 * Parent lives in executionState.planGraph; TaskLoop children live in graphs[].
 */
function selectGraphForCommand(executionState = null, command = {}) {
  const state = ensurePlanGraphState(executionState);
  if (!state.graphs || typeof state.graphs !== "object") state.graphs = {};
  const primary = state.planGraph && typeof state.planGraph === "object"
    ? state.planGraph
    : emptyPlanGraphState();
  if (primary.graphId) state.graphs[primary.graphId] = primary;

  const requested = String(command && command.graphId || "").trim();
  if (!requested) {
    return {
      ok: true,
      graph: primary,
      isPrimary: true,
      primaryGraphId: String(primary.graphId || ""),
    };
  }
  if (primary.graphId && primary.graphId === requested) {
    return {
      ok: true,
      graph: primary,
      isPrimary: true,
      primaryGraphId: primary.graphId,
    };
  }
  const mapped = state.graphs[requested];
  if (mapped && typeof mapped === "object") {
    return {
      ok: true,
      graph: mapped,
      isPrimary: false,
      primaryGraphId: String(primary.graphId || ""),
    };
  }
  return {
    ok: false,
    code: "GRAPH_NOT_FOUND",
    message: `graphId ${requested} not found`,
  };
}

/**
 * Apply a normalized plan_graph command against executionState.planGraph
 * (or a TaskLoop child graph when command.graphId selects it).
 */
function runPlanGraphCommand(commandInput = {}, options = {}) {
  const command = normalizePlanGraphCommand(commandInput) || commandInput;
  const operation = String(command && command.operation || "").trim().toLowerCase();
  const executionState = ensurePlanGraphState(options.executionState);
  if (!executionState.graphs || typeof executionState.graphs !== "object") {
    executionState.graphs = {};
  }
  const commandId = String(command.commandId || "").trim();

  if (!operation) {
    const payload = rejected([{ code: "MISSING_OPERATION", message: "operation is required" }]);
    return { ...payload, executionState, modelPayload: payload };
  }

  // create/control always target the primary agent graph; patch/inspect may
  // select a TaskLoop child via command.graphId.
  const selected = (operation === "patch" || operation === "inspect")
    ? selectGraphForCommand(executionState, command)
    : {
      ok: true,
      graph: executionState.planGraph,
      isPrimary: true,
      primaryGraphId: String(executionState.planGraph && executionState.planGraph.graphId || ""),
    };

  if (!selected.ok) {
    const payload = rejected([{
      code: selected.code || "GRAPH_NOT_FOUND",
      message: selected.message || "graph not found",
    }]);
    return { ...payload, executionState, modelPayload: payload };
  }

  const primaryGraphId = selected.primaryGraphId
    || String(executionState.planGraph && executionState.planGraph.graphId || "");
  // Work on the selected graph for this command; restore primary afterward if child.
  if (!selected.isPrimary) {
    executionState.planGraph = selected.graph;
  }
  const planGraph = executionState.planGraph;

  function restorePrimaryGraph() {
    if (executionState.planGraph && executionState.planGraph.graphId) {
      executionState.graphs[executionState.planGraph.graphId] = executionState.planGraph;
    }
    if (!selected.isPrimary && primaryGraphId && executionState.graphs[primaryGraphId]) {
      executionState.planGraph = executionState.graphs[primaryGraphId];
    } else if (executionState.planGraph && executionState.planGraph.graphId) {
      executionState.graphs[executionState.planGraph.graphId] = executionState.planGraph;
    }
  }

  function resumeChildTaskLoopIfNeeded(payload = null) {
    if (selected.isPrimary) return null;
    if (!payload || payload.status !== "accepted") return null;
    if (typeof options.runTool !== "function") return null;
    const childId = String((selected.graph && selected.graph.graphId) || "").trim();
    const childLive = childId ? executionState.graphs[childId] : null;
    const owner = childLive && childLive.owner;
    if (!owner || owner.kind !== "task_loop" || !owner.taskRunId) return null;
    try {
      const { processTaskRun } = require("../runtime/taskLoop");
      return processTaskRun(executionState, owner.taskRunId, {
        runTool: options.runTool,
        knownTools: options.knownTools,
      });
    } catch {
      return null;
    }
  }

  if (commandId && planGraph.commandLog && planGraph.commandLog[commandId]) {
    const cached = cloneJson(planGraph.commandLog[commandId]);
    restorePrimaryGraph();
    return {
      ...cached,
      ok: cached.status === "accepted",
      idempotentReplay: true,
      executionState,
      modelPayload: cached,
    };
  }

  if (operation === "inspect") {
    const payload = inspectPlanGraph(planGraph);
    restorePrimaryGraph();
    return { ...payload, executionState, modelPayload: payload };
  }

  if (operation === "control") {
    const { runControlActions } = require("../runtime/taskControl");
    const controlResult = runControlActions(executionState, {
      actions: Array.isArray(command.actions) ? command.actions : [],
      commandId,
      runTool: options.runTool,
      knownTools: options.knownTools,
    });
    let advance = {
      status: "completed",
      yieldReason: "control",
      executedNodes: [],
      failedNodes: [],
      waitingFor: null,
      stoppedAt: "",
    };
    // Status-changing control actions may unblock ready tool nodes.
    const statusOps = new Set([
      "complete_task",
      "skip_node",
      "cancel_subtree",
      "cancel_task",
      "fail_task",
      "mark_task_failed",
    ]);
    const touchedStatus = (Array.isArray(command.actions) ? command.actions : [])
      .some((a) => statusOps.has(String(a && a.op || "").trim().toLowerCase()));
    if (
      controlResult.ok
      && touchedStatus
      && options.autoAdvance !== false
      && typeof options.runTool === "function"
    ) {
      const advanced = advanceStoredGraph(executionState.planGraph, {
        knownTools: options.knownTools,
        runTool: options.runTool,
        parallel: options.parallel !== false,
        maxNodeRuns: options.maxNodeRuns,
      });
      if (advanced.planGraph) {
        executionState.planGraph = {
          ...advanced.planGraph,
          commandLog: executionState.planGraph.commandLog || {},
        };
      }
      if (advanced.advance) advance = advanced.advance;
    }
    const live = executionState.planGraph;
    const { readyNodes, waitingNodes } = summarizeReadyWaiting(live.nodes);
    const payload = controlResult.ok
      ? accepted({
        graphId: live.graphId || "",
        commandRevision: Number(live.specRevision) || 0,
        stateRevision: Number(live.stateRevision) || 0,
        revision: Number(live.specRevision) || 0,
        control: controlResult,
        summary: advance.waitingFor
          ? `waiting on ${advance.waitingFor.type}:${advance.waitingFor.id || ""}`
          : (advance.yieldReason || "control actions applied"),
        changes: { nodesAdded: [], nodesUpdated: [] },
        nodesAdded: [],
        nodesUpdated: [],
        readyNodes,
        waitingNodes,
        waitingFor: live.waitingFor || null,
        advance,
        planView: projectPlanView(live),
        validationWarnings: [],
      })
      : rejected(controlResult.errors || [{
        code: "CONTROL_REJECTED",
        message: "one or more control actions rejected",
      }], { control: controlResult });
    if (commandId && payload.status === "accepted") {
      cacheCommand(executionState.planGraph, commandId, payload);
    }
    return { ...payload, executionState, modelPayload: payload, ok: payload.status === "accepted" };
  }

  if (operation === "cancel_graph" || operation === "clear") {
    const previousId = planGraph.graphId || "";
    executionState.planGraph = emptyPlanGraphState();
    executionState.mode = "single_action";
    const payload = accepted({
      graphId: "",
      commandRevision: 0,
      stateRevision: 0,
      revision: 0,
      changes: { nodesAdded: [], nodesUpdated: [], archivedGraphId: previousId },
      nodesAdded: [],
      nodesUpdated: [],
      readyNodes: [],
      waitingNodes: [],
      advance: { status: "completed", yieldReason: "cancelled", executedNodes: [], failedNodes: [] },
      validationWarnings: [],
    });
    restorePrimaryGraph();
    return { ...payload, executionState, modelPayload: payload };
  }

  function rejectWorking(payload, extra = {}) {
    restorePrimaryGraph();
    return { ...payload, executionState, modelPayload: payload, ...extra };
  }

  if (
    Number.isFinite(command.expectedSpecRevision)
    && command.expectedSpecRevision !== null
    && Number(planGraph.specRevision) !== Number(command.expectedSpecRevision)
  ) {
    const payload = rejected([{
      code: "SPEC_REVISION_MISMATCH",
      message: `expectedSpecRevision ${command.expectedSpecRevision}, actual ${planGraph.specRevision}`,
    }], {
      graphId: planGraph.graphId || "",
      commandRevision: Number(planGraph.specRevision) || 0,
      stateRevision: Number(planGraph.stateRevision) || 0,
    });
    return rejectWorking(payload);
  }

  if (command.graphId && planGraph.graphId && command.graphId !== planGraph.graphId) {
    // Should not happen after selectGraphForCommand switched the working graph.
    const payload = rejected([{
      code: "GRAPH_ID_MISMATCH",
      message: `expected graphId ${command.graphId}, actual ${planGraph.graphId}`,
    }]);
    return rejectWorking(payload);
  }

  const beforeIds = new Set(listNodeIds(planGraph.nodes));
  let nextPlan = {
    id: planGraph.graphId || createPlanId("plan"),
    objective: planGraph.objective || "",
    nodes: snapshotNodes(planGraph),
  };
  let nodesUpdated = [];

  if (operation === "create") {
    const graphSource = command.graph || {};
    if (Array.isArray(graphSource.nodes)) {
      nextPlan = normalizePlanGraph({
        ...graphSource,
        nodes: stripModelStatuses(graphSource.nodes),
      });
    } else {
      nextPlan = normalizePlanGraph(graphSource);
      nextPlan.nodes = stripModelStatuses(nextPlan.nodes);
    }
    if (!nextPlan.id) nextPlan.id = createPlanId("plan");
    nodesUpdated = listNodeIds(nextPlan.nodes);
    // Parent graphs are owned by the agent loop.
    const { agentLoopOwner } = require("../runtime/graphOwner");
    nextPlan.owner = agentLoopOwner(
      (executionState.agentLoopId) || "agent",
    );
  } else if (operation === "patch") {
    const ops = Array.isArray(command.operations) ? command.operations.map(normalizeExpandOp) : [];
    // Freeze: reject patch that mutates running task_loop contract fields.
    const { getTaskExecutionKind } = require("./planGraph");
    for (const op of ops) {
      const type = String(op && (op.op || op.type) || "").trim().toLowerCase();
      if (type === "add_node" && op.node && getTaskExecutionKind(op.node) === "task_loop") {
        // Disallow nesting task_loop when current graph is owned by a task_loop
        if (planGraph.owner && planGraph.owner.kind === "task_loop") {
          const payload = rejected([{
            code: "NESTED_TASK_LOOP_NOT_SUPPORTED",
            message: "V1 child graphs cannot create task_loop nodes",
          }]);
          return rejectWorking(payload);
        }
      }
      const targetId = String(op.nodeId || (op.node && op.node.id) || "").trim();
      if (targetId) {
        const existing = (planGraph.nodes || []).find((n) => n && n.id === targetId);
        if (existing && existing.status === "running" && getTaskExecutionKind(existing) === "task_loop") {
          const touchesSpec = type === "expand_node"
            || type === "add_dependency"
            || type === "remove_dependency"
            || (type === "add_node" && op.node)
            || Boolean(op.objective || op.title || op.execution || op.dependsOn);
          if (touchesSpec) {
            const payload = rejected([{
              code: "RUNNING_TASK_SPEC_FROZEN",
              message: `cannot mutate running task_loop ${targetId}`,
            }]);
            return rejectWorking(payload);
          }
        }
      }
    }
    const applied = applyPlanOperations(nextPlan, ops);
    if (Array.isArray(applied.errors) && applied.errors.length > 0) {
      const payload = rejected(applied.errors.map((message) => ({
        code: "PATCH_ERROR",
        message: String(message),
      })), {
        graphId: planGraph.graphId || "",
        commandRevision: Number(planGraph.specRevision) || 0,
        stateRevision: Number(planGraph.stateRevision) || 0,
      });
      return rejectWorking(payload);
    }
    nextPlan = applied;
    for (const op of ops) {
      const nodeId = String(op.nodeId || (op.node && op.node.id) || "").trim();
      if (nodeId) nodesUpdated.push(nodeId);
      if (Array.isArray(op.children)) {
        for (const child of op.children) {
          if (child && child.id) nodesUpdated.push(String(child.id));
        }
      }
    }
  } else {
    const payload = rejected([{ code: "UNKNOWN_OPERATION", message: `unknown operation: ${operation}` }]);
    return rejectWorking(payload);
  }

  // Validate. Do not rewrite aggregate sinks via group rewrite when storing flat nodes.
  const compiled = compilePlanGraph(nextPlan, options);
  if (!compiled.ok) {
    const payload = rejected(validationErrorsFromCompile(compiled), {
      graphId: planGraph.graphId || "",
      commandRevision: Number(planGraph.specRevision) || 0,
      stateRevision: Number(planGraph.stateRevision) || 0,
      validationWarnings: compiled.warnings || [],
    });
    return rejectWorking(payload, { compile: compiled });
  }

  // Prefer the patched node list (includes aggregate expand status).
  const preferredNodes = applyStatusesFromStore(
    (Array.isArray(nextPlan.nodes) ? nextPlan.nodes : []).map((node) => normalizePlanNode(node, node.id)),
    planGraph.nodes,
    { preferSourceStatus: operation === "patch" },
  );

  // Re-validate preferred nodes for cycles/refs.
  const preferredCompile = compilePlanGraph({
    id: nextPlan.id,
    objective: nextPlan.objective,
    nodes: preferredNodes,
  }, options);
  if (!preferredCompile.ok) {
    const payload = rejected(validationErrorsFromCompile(preferredCompile), {
      graphId: planGraph.graphId || "",
      commandRevision: Number(planGraph.specRevision) || 0,
      stateRevision: Number(planGraph.stateRevision) || 0,
    });
    return rejectWorking(payload, { compile: preferredCompile });
  }

  const mergedNodes = applyStatusesFromStore(preferredCompile.nodes, preferredNodes, {
    preferSourceStatus: true,
  });
  if (operation === "create") {
    for (const node of mergedNodes) {
      node.status = "pending";
      node.result = null;
      node.error = "";
      node.attempt = 0;
    }
  }

  const specRevision = (Number(planGraph.specRevision) || 0) + 1;
  executionState.planGraph = {
    ...planGraph,
    graphId: preferredCompile.planId || nextPlan.id,
    specRevision,
    stateRevision: Number(planGraph.stateRevision) || 0,
    revision: specRevision,
    objective: preferredCompile.objective || nextPlan.objective || "",
    failurePolicy: preferredCompile.failurePolicy
      || nextPlan.failurePolicy
      || planGraph.failurePolicy
      || "continue_independent",
    nodes: mergedNodes,
    outputs: operation === "create" ? {} : { ...(planGraph.outputs || {}) },
    waitingFor: null,
    lastStoppedAt: "",
    lastYieldReason: "",
    commandLog: planGraph.commandLog || {},
    owner: nextPlan.owner || planGraph.owner || null,
    parentGraphId: planGraph.parentGraphId || "",
    parentNodeId: planGraph.parentNodeId || "",
  };
  if (!executionState.graphs || typeof executionState.graphs !== "object") {
    executionState.graphs = {};
  }
  executionState.graphs[executionState.planGraph.graphId] = executionState.planGraph;
  executionState.mode = "plan_graph";

  const afterIds = listNodeIds(mergedNodes);
  const nodesAdded = afterIds.filter((id) => !beforeIds.has(id));

  let advance = {
    status: "completed",
    yieldReason: "",
    executedNodes: [],
    failedNodes: [],
    waitingFor: null,
    stoppedAt: "",
  };
  if (options.autoAdvance !== false && typeof options.runTool === "function") {
    const advanced = advanceStoredGraph(executionState.planGraph, {
      knownTools: options.knownTools,
      runTool: options.runTool,
      parallel: options.parallel !== false,
      maxNodeRuns: options.maxNodeRuns,
    });
    if (advanced.ok === false && advanced.errors && advanced.errors.length > 0 && advanced.result && advanced.result.stoppedAt === "compile") {
      const payload = rejected(advanced.errors, {
        graphId: executionState.planGraph.graphId,
        commandRevision: specRevision,
        stateRevision: Number(executionState.planGraph.stateRevision) || 0,
      });
      return rejectWorking(payload);
    }
    if (advanced.planGraph) {
      executionState.planGraph = {
        ...advanced.planGraph,
        specRevision,
        revision: specRevision,
        commandLog: planGraph.commandLog || {},
        owner: advanced.planGraph.owner || planGraph.owner || null,
        parentGraphId: advanced.planGraph.parentGraphId || planGraph.parentGraphId || "",
        parentNodeId: advanced.planGraph.parentNodeId || planGraph.parentNodeId || "",
      };
    }
    if (advanced.advance) advance = advanced.advance;
  }

  const live = executionState.planGraph;
  const { readyNodes, waitingNodes } = summarizeReadyWaiting(live.nodes);
  const payload = accepted({
    graphId: live.graphId,
    commandRevision: live.specRevision,
    stateRevision: live.stateRevision,
    revision: live.specRevision,
    changes: {
      nodesAdded,
      nodesUpdated: Array.from(new Set(nodesUpdated)),
    },
    nodesAdded,
    nodesUpdated: Array.from(new Set(nodesUpdated)),
    readyNodes,
    waitingNodes,
    waitingFor: live.waitingFor || null,
    stoppedAt: live.lastStoppedAt || "",
    advance,
    planView: projectPlanView(live),
    validationWarnings: preferredCompile.warnings || [],
    summary: advance.waitingFor
      ? `waiting on ${advance.waitingFor.type}:${advance.waitingFor.id || ""}`
      : (advance.yieldReason || "graph updated"),
  });

  cacheCommand(executionState.planGraph, commandId, payload);

  // Agent Loop create enables Plan Mode; TaskLoop child graphs must not.
  let planModeEntered = null;
  if (operation === "create" && payload.status === "accepted") {
    const ownerKind = String(
      (executionState.planGraph && executionState.planGraph.owner && executionState.planGraph.owner.kind)
      || "agent_loop",
    ).trim();
    if (ownerKind === "agent_loop") {
      const { enterPlanModeAfterGraphCreate } = require("./planMode");
      planModeEntered = enterPlanModeAfterGraphCreate(executionState, {
        reason: "plan_graph create",
      });
    }
  }

  restorePrimaryGraph();
  const resumed = resumeChildTaskLoopIfNeeded(payload);

  return {
    ...payload,
    executionState,
    modelPayload: payload,
    compile: preferredCompile,
    planModeEntered,
    taskLoopResume: resumed || null,
  };
}

function activePlanRequiresExpansion(planGraph = {}) {
  if (!planGraph || !planGraph.graphId) return false;
  const waiting = planGraph.waitingFor;
  if (!waiting || waiting.type !== "task") return false;
  const node = (Array.isArray(planGraph.nodes) ? planGraph.nodes : [])
    .find((entry) => entry.id === waiting.id);
  if (!node || node.type !== "task") return false;
  if (isAggregateTask(node)) return false;
  return node.status === "waiting_llm";
}

module.exports = {
  emptyPlanGraphState,
  ensurePlanGraphState,
  normalizePlanGraphCommand,
  normalizeExpandOp,
  runPlanGraphCommand,
  inspectPlanGraph,
  advanceStoredGraph,
  executionSegmentToCreateGraph,
  projectPlanView,
  activePlanRequiresExpansion,
  selectGraphForCommand,
  stripModelStatuses,
};

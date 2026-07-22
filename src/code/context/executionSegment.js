"use strict";

const { randomUUID } = require("crypto");
const {
  executePlanGraph,
  planGraphFromExecutionSegment,
  compilePlanGraph,
} = require("./planGraph");

function emptyExecutionState() {
  // Durable execution control plane. Field ownership: see
  // src/code/protocol/ownership.js (STATE_OWNERSHIP / DURABLE_FIELDS).
  return {
    currentSegmentId: "",
    mode: "single_action",
    planMode: false,
    planModeSource: "",
    // R5 orthognal fields (dual-written with planMode during migration)
    planningPolicy: "direct_allowed",
    executionOwner: { kind: "none", id: "" },
    steps: {},
    modifiedFiles: [],
    lastExitCodes: [],
    approvals: [],
    retries: {},
    segments: [],
    pendingUserPrompts: [],
    planGraph: require("./planGraphService").emptyPlanGraphState(),
    graphs: {},
    archivedPlans: [],
    taskRuns: require("../runtime/taskRun").emptyTaskRunStore(),
    agentMailbox: require("../runtime/loopMailbox").emptyMailbox(),
    taskMailboxes: {},
    workspaceLease: require("../runtime/workspaceLease").emptyWorkspaceLease(),
    planUi: { bandMode: "auto" },
    pendingUserInteraction: null,
  };
}

function createSegmentId() {
  return `seg_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
}

function normalizeExecutionSegment(segment = {}) {
  const source = segment && typeof segment === "object" ? segment : {};
  const steps = Array.isArray(source.steps) ? source.steps : [];
  return {
    type: String(source.type || "execution_segment").trim(),
    objective: String(source.objective || "").trim(),
    steps: steps.map((step, index) => ({
      id: String(step.id || `s${index + 1}`).trim(),
      tool: String(step.tool || "").trim(),
      args: step.args && typeof step.args === "object" ? step.args : {},
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
    })),
    checkpoint: source.checkpoint && typeof source.checkpoint === "object"
      ? source.checkpoint
      : { after: [] },
  };
}

function startExecutionSegment(executionState = null, segment = {}) {
  const state = executionState && typeof executionState === "object"
    ? { ...executionState }
    : emptyExecutionState();
  const normalized = normalizeExecutionSegment(segment);
  const segmentId = createSegmentId();
  state.currentSegmentId = segmentId;
  state.mode = normalized.type === "execution_segment" ? "execution_segment" : "single_action";
  state.segments = Array.isArray(state.segments) ? state.segments : [];
  state.segments.push({
    segmentId,
    objective: normalized.objective,
    startedAt: new Date().toISOString(),
    steps: normalized.steps,
    checkpoint: normalized.checkpoint,
    status: "running",
  });
  state.steps = {};
  return { state, segmentId, segment: normalized };
}

function recordStepResult(executionState = null, {
  stepId = "",
  status = "success",
  artifactId = "",
  exitCode = null,
  error = "",
} = {}) {
  const state = executionState && typeof executionState === "object"
    ? { ...executionState }
    : emptyExecutionState();
  state.steps = state.steps && typeof state.steps === "object" ? { ...state.steps } : {};
  state.steps[stepId] = {
    status: String(status || "success"),
    artifactId: String(artifactId || ""),
    exitCode,
    error: String(error || ""),
    at: new Date().toISOString(),
  };
  return state;
}

function shouldStopSegment(executionState = null, {
  hadError = false,
  schemaMismatch = false,
  sideEffect = false,
  reachedCheckpoint = false,
} = {}) {
  if (hadError || schemaMismatch || sideEffect) return true;
  if (reachedCheckpoint) return true;
  const state = executionState && typeof executionState === "object" ? executionState : null;
  if (!state || state.mode !== "execution_segment") return true;
  return false;
}

function renderExecutionSegmentContext(executionState = null) {
  if (!executionState || typeof executionState !== "object") return "";
  const lines = [];
  if (executionState.planMode) {
    // Detailed plan-mode instructions come from renderPlanModeContext.
    lines.push("Execution mode: plan_mode");
  }
  if (!executionState.currentSegmentId && !(executionState.planGraph && executionState.planGraph.graphId)) {
    return lines.join("\n");
  }
  if (executionState.currentSegmentId) {
    lines.push(
      "Current Execution Segment:",
      `- Segment: ${executionState.currentSegmentId}`,
      `- Mode: ${executionState.mode || "single_action"}`,
    );
    const steps = executionState.steps && typeof executionState.steps === "object"
      ? Object.entries(executionState.steps)
      : [];
    if (steps.length > 0) {
      lines.push("Step status:");
      for (const [id, info] of steps) {
        lines.push(`- ${id}: ${info.status}${info.error ? ` (${info.error})` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

function parseExecutionSegment(sideEffects = null) {
  if (!sideEffects || typeof sideEffects !== "object") return null;
  if (sideEffects.nextSegment) return normalizeExecutionSegment(sideEffects.nextSegment);
  if (sideEffects.type === "execution_segment") return normalizeExecutionSegment(sideEffects);
  return null;
}

const DEFAULT_MAX_SEGMENT_STEPS = 16;
const SIDE_EFFECT_TOOLS = new Set(["write", "edit"]);

function isSideEffectTool(tool = "") {
  return SIDE_EFFECT_TOOLS.has(String(tool || "").trim().toLowerCase());
}

function formatSegmentResultMessage(result = {}) {
  return JSON.stringify({
    type: "execution_segment_result",
    segmentId: result.segmentId || "",
    ok: result.ok !== false,
    objective: result.objective || "",
    stoppedAt: result.stoppedAt || "",
    steps: Array.isArray(result.results) ? result.results : [],
    error: result.error || "",
    plan: result.summary || null,
  });
}

/**
 * Execute a legacy execution_segment via the unified plan graph engine.
 * Preserves the previous return shape used by agent/nativeRunner.
 */
function executeExecutionSegment({
  segment = {},
  executionState = null,
  runStep = () => ({ ok: false, error: "no runner" }),
  onStepStart = null,
  onStepComplete = null,
  maxSteps = DEFAULT_MAX_SEGMENT_STEPS,
} = {}) {
  const normalized = normalizeExecutionSegment(segment);
  const cappedSteps = normalized.steps.slice(0, Math.max(1, Math.floor(maxSteps)));
  const cappedSegment = { ...normalized, steps: cappedSteps };
  const { state: startedState, segmentId } = startExecutionSegment(executionState, cappedSegment);
  let state = startedState;

  const plan = planGraphFromExecutionSegment(cappedSegment);
  plan.id = segmentId;

  const graphResult = executePlanGraph(plan, {
    maxNodeRuns: Math.max(1, Math.floor(maxSteps)) * 2,
    runStep: ({ stepId, tool, args }) => {
      if (typeof onStepStart === "function") {
        try {
          onStepStart({ stepId, tool, args });
        } catch {
          // ignore
        }
      }
      const result = runStep({ stepId, tool, args }) || { ok: false, error: "step failed" };
      if (typeof onStepComplete === "function") {
        try {
          onStepComplete({ stepId, tool, args, result });
        } catch {
          // ignore
        }
      }
      if (result && result.ok !== false) {
        state = recordStepResult(state, {
          stepId,
          status: "success",
          artifactId: result.artifactId || "",
          exitCode: Number.isFinite(result.code) ? result.code : null,
        });
      } else {
        state = recordStepResult(state, {
          stepId,
          status: "failed",
          error: String((result && result.error) || "step failed"),
        });
      }
      return result;
    },
  });

  const results = Array.isArray(graphResult.results) ? graphResult.results : [];
  const stoppedAt = String(graphResult.stoppedAt || "");
  const fatalError = graphResult.ok === false
    ? String(graphResult.error || "segment failed")
    : "";

  let finalStatus = "success";
  if (fatalError) finalStatus = "failed";
  else if (stoppedAt === "checkpoint" || stoppedAt === "waiting_llm") finalStatus = "checkpoint";
  else if (stoppedAt === "side_effect") finalStatus = "success";

  state = completeExecutionSegment(state, { status: finalStatus, error: fatalError });
  return {
    ok: graphResult.ok !== false,
    segmentId,
    objective: cappedSegment.objective,
    executionState: state,
    results,
    error: fatalError,
    stoppedAt,
    waitingFor: graphResult.waitingFor || null,
    summary: graphResult.summary || null,
    compile: graphResult.compile || null,
  };
}

function completeExecutionSegment(executionState = null, { status = "success", error = "" } = {}) {
  const state = executionState && typeof executionState === "object"
    ? { ...executionState }
    : emptyExecutionState();
  const segments = Array.isArray(state.segments) ? state.segments.slice() : [];
  const currentId = String(state.currentSegmentId || "").trim();
  if (currentId) {
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i].segmentId === currentId) {
        segments[i] = {
          ...segments[i],
          status,
          error: String(error || ""),
          endedAt: new Date().toISOString(),
        };
        break;
      }
    }
  }
  state.segments = segments;
  state.currentSegmentId = "";
  state.mode = "single_action";
  return state;
}

module.exports = {
  DEFAULT_MAX_SEGMENT_STEPS,
  emptyExecutionState,
  createSegmentId,
  normalizeExecutionSegment,
  startExecutionSegment,
  recordStepResult,
  shouldStopSegment,
  renderExecutionSegmentContext,
  parseExecutionSegment,
  completeExecutionSegment,
  executeExecutionSegment,
  formatSegmentResultMessage,
  isSideEffectTool,
  planGraphFromExecutionSegment,
  compilePlanGraph,
  executePlanGraph,
};

"use strict";

const { randomUUID } = require("crypto");

function emptyExecutionState() {
  return {
    currentSegmentId: "",
    mode: "single_action",
    steps: {},
    modifiedFiles: [],
    lastExitCodes: [],
    approvals: [],
    retries: {},
    segments: [],
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
  if (!executionState || !executionState.currentSegmentId) return "";
  const lines = [
    "Current Execution Segment:",
    `- Segment: ${executionState.currentSegmentId}`,
    `- Mode: ${executionState.mode || "single_action"}`,
  ];
  const steps = executionState.steps && typeof executionState.steps === "object"
    ? Object.entries(executionState.steps)
    : [];
  if (steps.length > 0) {
    lines.push("Step status:");
    for (const [id, info] of steps) {
      lines.push(`- ${id}: ${info.status}${info.error ? ` (${info.error})` : ""}`);
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

const DEFAULT_MAX_SEGMENT_STEPS = 4;
const SIDE_EFFECT_TOOLS = new Set(["write", "edit"]);

function resolveStepArgs(args = {}, stepOutputs = new Map()) {
  const next = args && typeof args === "object" ? { ...args } : {};
  const argsJson = JSON.stringify(next);
  for (const [depId, depValue] of stepOutputs.entries()) {
    const token = `\${${depId}.matches}`;
    if (argsJson.includes(token) && depValue && depValue.matches) {
      next.matches = depValue.matches;
    }
  }
  return next;
}

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
  });
}

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
  const stepOutputs = new Map();
  const results = [];
  const checkpointAfter = new Set(
    Array.isArray(cappedSegment.checkpoint && cappedSegment.checkpoint.after)
      ? cappedSegment.checkpoint.after.map(String)
      : [],
  );
  let stoppedAt = "";
  let fatalError = "";

  for (const step of cappedSteps) {
    const deps = Array.isArray(step.dependsOn) ? step.dependsOn : [];
    for (const dep of deps) {
      if (!stepOutputs.has(dep)) {
        state = recordStepResult(state, {
          stepId: step.id,
          status: "failed",
          error: `missing dependency ${dep}`,
        });
        fatalError = `segment dependency missing: ${dep}`;
        state = completeExecutionSegment(state, { status: "failed", error: fatalError });
        return {
          ok: false,
          segmentId,
          objective: cappedSegment.objective,
          executionState: state,
          results,
          error: fatalError,
          stoppedAt: "dependency",
        };
      }
    }

    const args = resolveStepArgs(step.args, stepOutputs);
    if (typeof onStepStart === "function") {
      try {
        onStepStart({ stepId: step.id, tool: step.tool, args });
      } catch {
        // ignore
      }
    }

    const result = runStep({ stepId: step.id, tool: step.tool, args }) || { ok: false, error: "step failed" };
    const stepRecord = {
      stepId: step.id,
      tool: step.tool,
      ok: result.ok !== false,
      artifactId: result.artifactId || "",
      error: result.error || "",
    };
    results.push(stepRecord);

    if (result.ok === false) {
      state = recordStepResult(state, {
        stepId: step.id,
        status: "failed",
        error: String(result.error || "step failed"),
      });
      fatalError = String(result.error || "segment step failed");
      state = completeExecutionSegment(state, { status: "failed", error: fatalError });
      return {
        ok: false,
        segmentId,
        objective: cappedSegment.objective,
        executionState: state,
        results,
        error: fatalError,
        stoppedAt: "error",
      };
    }

    stepOutputs.set(step.id, result);
    state = recordStepResult(state, {
      stepId: step.id,
      status: "success",
      artifactId: result.artifactId || "",
      exitCode: Number.isFinite(result.code) ? result.code : null,
    });

    if (typeof onStepComplete === "function") {
      try {
        onStepComplete({ stepId: step.id, tool: step.tool, args, result });
      } catch {
        // ignore
      }
    }

    if (checkpointAfter.has(step.id)) {
      stoppedAt = "checkpoint";
      break;
    }
    if (isSideEffectTool(step.tool)) {
      stoppedAt = "side_effect";
      break;
    }
  }

  const finalStatus = stoppedAt === "checkpoint" ? "checkpoint" : "success";
  state = completeExecutionSegment(state, { status: finalStatus });
  return {
    ok: true,
    segmentId,
    objective: cappedSegment.objective,
    executionState: state,
    results,
    error: "",
    stoppedAt,
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
};

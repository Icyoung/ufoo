"use strict";

const dispatchTools = require("../dispatch");
const runToolCall = dispatchTools.runToolCall;
const runToolCallAsync = typeof dispatchTools.runToolCallAsync === "function"
  ? dispatchTools.runToolCallAsync : async (...args) => runToolCall(...args);
const { runTaskRunTool } = require("./taskRun");
const { persistToolResultToContext } = require("../context/assembler");
const { emptyExecutionState } = require("../context/executionSegment");
const { runPlanGraphCommand } = require("../context/planGraphService");
const { runAskUserTool, syncInteractionFromPlanGraph } = require("../context/userInteraction");
const fs = require("fs");
const path = require("path");
const { createResourceLease } = require("../../agents/runtime/tasks/resourceLease");
function writerLease(options) {
  const workspaceRoot = fs.realpathSync(options.workspaceRoot || process.cwd());
  return { lease: createResourceLease({ file: path.join(workspaceRoot, ".ufoo", "agent", "runtime", "workspace-leases.json") }),
    key: workspaceRoot, ownerId: options.taskRunId || options.sessionId || `process-${process.pid}` };
}
function runCoreTool(options = {}) {
  if (!["write", "edit", "bash"].includes(normalizeToolName(options.tool))) return runCoreToolUnlocked(options);
  const { lease, key, ownerId } = writerLease(options);
  const acquired = lease.acquire({ key, ownerId });
  if (!acquired.ok) return { ...acquired, error: "workspace writer is active" };
  try { return runCoreToolUnlocked(options); }
  finally { if (!acquired.reentrant) lease.release({ key, token: acquired.token }); }
}

const CORE_TOOL_NAMES = new Set([
  "read",
  "read_image",
  "write",
  "edit",
  "bash",
  "artifact_read",
  "plan_graph",
  "task_run",
  "ask_user",
]);
const EXECUTABLE_GRAPH_TOOLS = new Set([
  "read",
  "read_image",
  "write",
  "edit",
  "bash",
  "artifact_read",
]);
const CONTROL_PLANE_TOOLS = new Set(["plan_graph", "task_run"]);
function normalizeToolName(value = "") {
  const name = String(value || "").trim().toLowerCase();
  if (!CORE_TOOL_NAMES.has(name)) return "";
  return name;
}

function emitToolEvent(callback, event = {}) {
  if (typeof callback !== "function") return;
  try {
    const payload = event && typeof event === "object" ? { ...event } : {};
    if (payload.origin == null) delete payload.origin;
    callback(payload);
  } catch {
    // ignore callback failures
  }
}

function runCoreToolUnlocked({
  tool = "",
  args = {},
  workspaceRoot = process.cwd(),
  onToolEvent = null,
  sessionId = "",
  onArtifactPersisted = null,
  executionState = null,
  origin = null,
  resume = null,
  artifactNamespace = "ucode",
} = {}) {
  const normalizedTool = normalizeToolName(tool);
  if (!normalizedTool) {
    emitToolEvent(onToolEvent, {
      tool: String(tool || "unknown"),
      phase: "error",
      args: args && typeof args === "object" ? { ...args } : {},
      error: `unsupported tool: ${tool}`,
      origin,
    });
    return {
      ok: false,
      error: `unsupported tool: ${tool}`,
    };
  }

  const safeArgs = args && typeof args === "object" ? { ...args } : {};
  if (normalizedTool === "artifact_read" && sessionId && !safeArgs.sessionId) {
    safeArgs.sessionId = sessionId;
  }
  emitToolEvent(onToolEvent, {
    tool: normalizedTool,
    phase: "start",
    args: safeArgs,
    error: "",
    origin,
  });

  if (normalizedTool === "plan_graph") {
    const state = executionState && typeof executionState === "object"
      ? executionState
      : emptyExecutionState();
    const result = runPlanGraphCommand(safeArgs, {
      executionState: state,
      autoAdvance: true,
      parallel: true,
      runTool: ({ node, args: nestedArgs, tool: nestedTool, stepId }) => {
        const nested = runCoreTool({
          tool: nestedTool,
          args: nestedArgs,
          workspaceRoot,
          onToolEvent,
          sessionId,
          onArtifactPersisted,
          executionState: state,
          origin: {
            kind: "plan_graph",
            graphId: String(state.planGraph && state.planGraph.graphId || ""),
            graphRevision: Number(state.planGraph && state.planGraph.specRevision) || 0,
            commandRevision: Number(state.planGraph && state.planGraph.specRevision) || 0,
            nodeId: stepId || (node && node.id) || "",
            attempt: Number(node && node.attempt) || 0,
          },
        });
        return nested;
      },
    });
    if (result.ok === false) {
      emitToolEvent(onToolEvent, {
        tool: "plan_graph",
        phase: "error",
        args: safeArgs,
        error: Array.isArray(result.errors)
          ? result.errors.map((e) => e.message || e.code).join("; ")
          : "plan_graph rejected",
        origin,
      });
    } else {
      syncInteractionFromPlanGraph(result.executionState || state);
    }
    return {
      ...result.modelPayload,
      ok: result.status === "accepted",
      // Keep executionState for the runner only; sanitizeToolResultForModel
      // strips it before the payload enters provider messages.
      executionState: result.executionState || state,
    };
  }

  if (normalizedTool === "task_run") {
    const state = executionState && typeof executionState === "object"
      ? executionState
      : emptyExecutionState();
    const result = runTaskRunTool(safeArgs, {
      executionState: state,
      runTool: ({ node, args: nestedArgs, tool: nestedTool, stepId }) => {
        const nested = runCoreTool({
          tool: nestedTool,
          args: nestedArgs,
          workspaceRoot,
          onToolEvent,
          sessionId,
          onArtifactPersisted,
          executionState: state,
          origin: {
            kind: "task_run",
            taskRunId: String(safeArgs.taskRunId || ""),
            nodeId: stepId || (node && node.id) || "",
            attempt: Number(node && node.attempt) || 0,
          },
        });
        return nested;
      },
    });
    const ok = result.ok !== false && result.status !== "rejected";
    emitToolEvent(onToolEvent, {
      tool: "task_run",
      phase: ok ? "end" : "error",
      args: safeArgs,
      result,
      error: ok
        ? ""
        : (Array.isArray(result.errors)
          ? result.errors.map((e) => e.message || e.code).join("; ")
          : (result.error || "task_run rejected")),
      origin,
    });
    return {
      ...result,
      ok,
      executionState: result.executionState || state,
    };
  }

  if (normalizedTool === "ask_user") {
    const state = executionState && typeof executionState === "object"
      ? executionState
      : emptyExecutionState();
    const result = runAskUserTool(safeArgs, {
      executionState: state,
      resume: resume || null,
    });
    const ok = result.ok !== false && result.status !== "rejected";
    emitToolEvent(onToolEvent, {
      tool: "ask_user",
      phase: ok ? "end" : "error",
      args: safeArgs,
      result: result.modelPayload || result,
      error: ok ? "" : (result.error || "ask_user rejected"),
      origin,
    });
    return {
      ...(result.modelPayload || result),
      ok,
      status: result.status,
      waiting_user: Boolean(result.waiting_user || result.status === "waiting_user"),
      interactionId: result.interactionId || "",
      executionState: result.executionState || state,
      deferToolResult: ok && result.status === "waiting_user",
    };
  }

  const toolOptions = { workspaceRoot, cwd: workspaceRoot };
  if (artifactNamespace !== "ucode") toolOptions.artifactNamespace = artifactNamespace;
  if (normalizedTool === "artifact_read" && sessionId) {
    toolOptions.sessionId = sessionId;
  }
  const result = runToolCall(
    { tool: normalizedTool, args: safeArgs },
    toolOptions,
  );

  if (!result || result.ok === false) {
    emitToolEvent(onToolEvent, {
      tool: normalizedTool,
      phase: "error",
      args: safeArgs,
      error: String((result && result.error) || `${normalizedTool} failed`),
      origin,
    });
    return result;
  }

  emitToolEvent(onToolEvent, { tool: normalizedTool, phase: "end", args: safeArgs, result, error: "", origin });

  if (normalizedTool !== "artifact_read" && EXECUTABLE_GRAPH_TOOLS.has(normalizedTool)) {
    const persisted = persistToolResultToContext({
      workspaceRoot,
      sessionId,
      tool: normalizedTool,
      args: safeArgs,
      rawResult: result,
      artifactNamespace,
    });
    if (typeof onArtifactPersisted === "function") {
      try {
        onArtifactPersisted(persisted);
      } catch {
        // ignore
      }
    }
    const payload = persisted.modelPayload || result;
    if (origin) payload.origin = origin;
    return payload;
  }

  if (origin && result && typeof result === "object") {
    return { ...result, origin };
  }
  return result;
}

/**
 * Async companion for the native loop. Control-plane tools intentionally keep
 * their synchronous scheduler for now; data-plane tools use the async
 * dispatcher so bash can terminate on the caller's AbortSignal.
 */
async function runCoreToolAsync(options = {}) {
  if (["write", "edit", "bash"].includes(normalizeToolName(options.tool))) {
    const { lease, key, ownerId } = writerLease(options);
    return lease.run({ key, ownerId, signal: options.signal }, () => runCoreToolAsyncUnlocked(options));
  }
  return runCoreToolAsyncUnlocked(options);
}
async function runCoreToolAsyncUnlocked(options = {}) {
  const normalizedTool = normalizeToolName(options.tool);
  if (!normalizedTool || CONTROL_PLANE_TOOLS.has(normalizedTool) || normalizedTool === "ask_user") {
    return runCoreTool(options);
  }

  const {
    args = {},
    workspaceRoot = process.cwd(),
    onToolEvent = null,
    sessionId = "",
    onArtifactPersisted = null,
    origin = null,
    signal = null,
    artifactNamespace = "ucode",
  } = options;
  const safeArgs = args && typeof args === "object" ? { ...args } : {};
  if (normalizedTool === "artifact_read" && sessionId && !safeArgs.sessionId) {
    safeArgs.sessionId = sessionId;
  }
  emitToolEvent(onToolEvent, {
    tool: normalizedTool,
    phase: "start",
    args: safeArgs,
    error: "",
    origin,
  });

  const toolOptions = {
    workspaceRoot,
    cwd: workspaceRoot,
  };
  if (artifactNamespace !== "ucode") toolOptions.artifactNamespace = artifactNamespace;
  if (signal) toolOptions.signal = signal;
  if (normalizedTool === "artifact_read" && sessionId) {
    toolOptions.sessionId = sessionId;
  }
  const result = await runToolCallAsync(
    { tool: normalizedTool, args: safeArgs },
    toolOptions,
  );

  if (!result || result.ok === false) {
    emitToolEvent(onToolEvent, {
      tool: normalizedTool,
      phase: "error",
      args: safeArgs,
      error: String((result && result.error) || `${normalizedTool} failed`),
      origin,
    });
    return result;
  }

  emitToolEvent(onToolEvent, { tool: normalizedTool, phase: "end", args: safeArgs, result, error: "", origin });

  if (normalizedTool !== "artifact_read" && EXECUTABLE_GRAPH_TOOLS.has(normalizedTool)) {
    const persisted = persistToolResultToContext({
      workspaceRoot,
      sessionId,
      tool: normalizedTool,
      args: safeArgs,
      rawResult: result,
      artifactNamespace,
    });
    if (typeof onArtifactPersisted === "function") {
      try {
        onArtifactPersisted(persisted);
      } catch {
        // ignore
      }
    }
    const payload = persisted.modelPayload || result;
    if (origin) payload.origin = origin;
    return payload;
  }

  if (origin && result && typeof result === "object") {
    return { ...result, origin };
  }
  return result;
}

module.exports = { runCoreTool, runCoreToolAsync };

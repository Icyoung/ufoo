"use strict";

const {
  startStandaloneTask,
  cancelTask,
  failTask,
  completeTaskFromLoop,
} = require("../runtime/taskControl");
const { getTaskRun } = require("../runtime/taskRun");
const { emptyExecutionState } = require("../context/executionSegment");

function normalizeTaskRunCommand(args = {}) {
  if (!args || typeof args !== "object") return null;
  const operation = String(args.operation || args.op || "").trim().toLowerCase();
  if (!operation) return null;
  return {
    operation,
    objective: args.objective,
    title: args.title,
    taskRunId: args.taskRunId || args.task_run_id,
    nodeId: args.nodeId || args.node_id,
    reason: args.reason,
    result: args.result,
    commandId: args.commandId || args.command_id,
  };
}

function runTaskRunTool(args = {}, options = {}) {
  const command = normalizeTaskRunCommand(args) || args;
  const operation = String(command.operation || "").trim().toLowerCase();
  const executionState = options.executionState && typeof options.executionState === "object"
    ? options.executionState
    : emptyExecutionState();
  const commandId = String(command.commandId || "").trim();
  const runTool = options.runTool || null;
  const knownTools = options.knownTools || null;

  let payload;
  if (operation === "start") {
    payload = startStandaloneTask(executionState, {
      objective: command.objective,
      title: command.title,
      commandId,
      runTool,
      knownTools,
      processImmediately: options.processImmediately !== false,
    });
  } else if (operation === "cancel") {
    payload = cancelTask(executionState, {
      taskRunId: command.taskRunId,
      nodeId: command.nodeId,
      reason: command.reason,
      commandId,
    });
  } else if (operation === "fail") {
    payload = failTask(executionState, {
      taskRunId: command.taskRunId,
      nodeId: command.nodeId,
      reason: command.reason,
      commandId,
    });
  } else if (operation === "complete") {
    payload = completeTaskFromLoop(executionState, {
      taskRunId: command.taskRunId,
      result: command.result,
      commandId,
    });
  } else if (operation === "inspect") {
    const run = getTaskRun(executionState, command.taskRunId);
    if (!run) {
      payload = {
        status: "rejected",
        ok: false,
        errors: [{ code: "TASK_RUN_NOT_FOUND", message: "task run missing" }],
      };
    } else {
      payload = {
        status: "accepted",
        ok: true,
        taskRun: {
          id: run.id,
          kind: run.kind || "",
          status: run.status,
          phase: run.phase,
          objective: run.objective || "",
          title: run.title || "",
          parentGraphId: run.parentGraphId || "",
          parentNodeId: run.parentNodeId || "",
          childGraphId: run.childGraphId || "",
          result: run.result,
          error: run.error,
          changedFiles: Array.isArray(run.changedFiles) ? run.changedFiles.slice() : [],
        },
      };
    }
  } else {
    payload = {
      status: "rejected",
      ok: false,
      errors: [{
        code: "UNKNOWN_TASK_RUN_OP",
        message: `unknown task_run operation: ${operation || "(empty)"}`,
      }],
    };
  }

  const ok = payload && payload.ok !== false && payload.status !== "rejected";
  return {
    ok,
    ...payload,
    executionState,
  };
}

module.exports = {
  normalizeTaskRunCommand,
  runTaskRunTool,
};

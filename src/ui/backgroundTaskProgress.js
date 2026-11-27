"use strict";

const path = require("path");
const { createAgentSurfaceReader, createJsonlEventReader } = require("../coordination/history/agentSurface");
const { normalizeToolLogDetail, buildUcodeToolRowText } = require("./format");

function taskReader(root, task) {
  if (task.workerId) {
    const reader = createAgentSurfaceReader(root);
    return () => reader.read([task.workerId]).map(row => row.data.surface)
      .filter(event => (event.taskId || event.task_id) === task.id);
  }
  if (!/^child-[a-f0-9-]+$/i.test(task.childSession || "")) return () => [];
  const dir = path.join(root, ".ufoo/agent/main-task/runtimes", task.childSession);
  const reader = createJsonlEventReader(dir, () => ["events.jsonl"]);
  return () => reader.read(event => event.taskRunId === task.id);
}

function resultText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(block => block?.text || "").join("\n");
  return [output?.error, output?.stderrTail || output?.stderr, output?.stdoutTail || output?.stdout, output?.preview || output?.content]
    .filter(value => typeof value === "string" && value).join("\n");
}

function applyProgress(state, event) {
  switch (event.type) {
    case "task_completed":
    case "task.completed":
    case "task.failed":
    case "task.cancelled":
    case "task.interrupted":
      state.finished = true;
      return;
    case "task_started":
    case "task.started":
      state.started = true;
      return;
    case "message.delta":
    case "text_delta": {
      const delta = event.text || event.delta;
      if (!delta) return;
      const previous = state.progress?.kind === "text" ? state.progress.text : "";
      state.progress = { kind: "text", text: (previous + delta).slice(-2400) };
      break;
    }
    case "tool_call":
    case "tool.started": {
      const tool = event.name || event.toolName || "tool";
      const detail = normalizeToolLogDetail(tool, event.args);
      const title = buildUcodeToolRowText([{ tool, detail }]).replace(/^• /, "");
      state.calls.set(event.toolCallId, title);
      state.progress = { kind: "tool", title, status: "running", text: "" };
      break;
    }
    case "tool_result":
    case "tool.completed": {
      const output = event.output ?? event.result;
      const title = state.calls.get(event.toolCallId) || event.name || event.toolName || "Tool";
      const failed = event.is_error || output?.ok === false || Boolean(event.exitCode || output?.exitCode);
      const status = event.status === "in_progress" ? "running" : failed ? "failed" : "done";
      if (status !== "running") state.calls.delete(event.toolCallId);
      state.progress = { kind: "tool", title, status, text: resultText(output).trim().slice(-1200) };
      break;
    }
    default: return;
  }
  state.started = true;
}

function createBackgroundTaskProgress() {
  let project = "";
  const states = new Map();
  return (root, tasks) => {
    if (root !== project) { states.clear(); project = root; }
    const ids = new Set(tasks.map(task => task.id));
    for (const id of states.keys()) if (!ids.has(id)) states.delete(id);
    const visible = [];
    for (const task of tasks) {
      let state = states.get(task.id);
      if (!state || state.workerId !== task.workerId) {
        state = { read: taskReader(root, task), workerId: task.workerId, calls: new Map() };
        states.set(task.id, state);
      }
      if (!state.finished) for (const event of state.read()) applyProgress(state, event);
      if (!state.finished) visible.push({ ...task, status: state.started ? "running" : task.status, progress: state.progress });
    }
    return visible;
  };
}

module.exports = { createBackgroundTaskProgress };

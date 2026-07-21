"use strict";

/**
 * Dynamic TaskFocus for each TaskLoop model turn (siblings + deps, no user text).
 */

function nodeSummary(node = {}, run = null) {
  if (!node) return null;
  const result = (run && run.result) || node.result || null;
  return {
    id: node.id,
    title: node.title || node.objective || node.id,
    objective: node.objective || node.title || "",
    status: (run && run.status) || node.status || "pending",
    summary: result && result.summary ? String(result.summary) : "",
    changedFiles: Array.isArray(run && run.changedFiles)
      ? run.changedFiles.slice()
      : (result && Array.isArray(result.changedFiles) ? result.changedFiles.slice() : []),
  };
}

function canReach(nodesById = new Map(), fromId = "", toId = "", seen = new Set()) {
  if (fromId === toId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  const node = nodesById.get(fromId);
  if (!node) return false;
  for (const dep of node.dependsOn || []) {
    if (canReach(nodesById, dep, toId, seen)) return true;
  }
  return false;
}

function listParallelSiblings(nodes = [], nodeId = "") {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((n) => [n.id, n]));
  const self = byId.get(nodeId);
  if (!self || self.type !== "task") return [];
  const siblings = [];
  for (const node of list) {
    if (!node || node.id === nodeId || node.type !== "task") continue;
    const exec = getExecutionKind(node);
    if (exec !== "task_loop" && exec !== "llm" && exec !== "inline_llm" && exec !== "expand") {
      // still show other tasks as siblings for awareness
    }
    if (canReach(byId, nodeId, node.id) || canReach(byId, node.id, nodeId)) continue;
    siblings.push(node);
  }
  return siblings;
}

function getExecutionKind(node = {}) {
  const exec = node.execution;
  if (exec && typeof exec === "object") {
    return String(exec.kind || "").trim().toLowerCase() || "inline_llm";
  }
  const raw = String(exec || "llm").trim().toLowerCase();
  if (raw === "task_loop") return "task_loop";
  if (raw === "expand") return "expand";
  if (raw === "aggregate") return "aggregate";
  if (raw === "inline_llm") return "inline_llm";
  return raw === "llm" ? "inline_llm" : raw;
}

function listDependencySummaries(nodes = [], nodeId = "", taskRunsById = {}) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((n) => [n.id, n]));
  const self = byId.get(nodeId);
  if (!self) return [];
  const runs = taskRunsById && typeof taskRunsById === "object" ? taskRunsById : {};
  return (self.dependsOn || []).map((depId) => {
    const node = byId.get(depId);
    if (!node) return { id: depId, status: "missing", title: depId, objective: "", summary: "", changedFiles: [] };
    const activeRun = Object.values(runs).find((r) => (
      r && r.parentNodeId === depId && (r.status === "succeeded" || r.status === "failed" || r.status === "cancelled")
    )) || Object.values(runs).find((r) => r && r.parentNodeId === depId);
    return nodeSummary(node, activeRun || null);
  }).filter(Boolean);
}

function buildTaskFocus({
  nodes = [],
  currentNodeId = "",
  taskRunsById = {},
  recentlyChangedFiles = [],
} = {}) {
  const byId = new Map((Array.isArray(nodes) ? nodes : []).map((n) => [n.id, n]));
  const current = byId.get(currentNodeId);
  const runs = taskRunsById && typeof taskRunsById === "object" ? taskRunsById : {};
  const currentRun = Object.values(runs).find((r) => (
    r && r.parentNodeId === currentNodeId
    && (r.status === "queued" || r.status === "running" || r.status === "cancelling")
  ));
  const siblings = listParallelSiblings(nodes, currentNodeId).map((node) => {
    const run = Object.values(runs).find((r) => r && r.parentNodeId === node.id) || null;
    return nodeSummary(node, run);
  });
  const writers = Object.values(runs)
    .filter((r) => r && (r.status === "running" || r.status === "cancelling"))
    .map((r) => r.parentNodeId)
    .filter(Boolean);

  return {
    currentTask: current
      ? {
        id: current.id,
        objective: current.objective || current.title || "",
        title: current.title || current.objective || current.id,
        status: (currentRun && currentRun.status) || current.status,
      }
      : { id: currentNodeId, objective: "", title: currentNodeId, status: "unknown" },
    dependencies: listDependencySummaries(nodes, currentNodeId, runs),
    parallelSiblings: siblings,
    workspace: {
      concurrentWriters: writers,
      recentlyChangedFiles: Array.isArray(recentlyChangedFiles)
        ? recentlyChangedFiles.map(String).slice(-40)
        : [],
    },
  };
}

function renderTaskFocusText(focus = {}) {
  const lines = [
    "TaskFocus (runtime; not a user message):",
    `Current task: ${focus.currentTask && focus.currentTask.id} — ${focus.currentTask && focus.currentTask.objective}`,
  ];
  const deps = Array.isArray(focus.dependencies) ? focus.dependencies : [];
  if (deps.length > 0) {
    lines.push("Dependencies:");
    for (const dep of deps) {
      lines.push(`  - ${dep.id} [${dep.status}] ${dep.summary || dep.objective || ""}`
        + (dep.changedFiles && dep.changedFiles.length
          ? ` files=[${dep.changedFiles.join(", ")}]`
          : ""));
    }
  }
  const siblings = Array.isArray(focus.parallelSiblings) ? focus.parallelSiblings : [];
  if (siblings.length > 0) {
    lines.push("Parallel siblings sharing this workspace:");
    for (const sib of siblings) {
      lines.push(`  - ${sib.id} [${sib.status}] ${sib.summary || sib.objective || ""}`
        + (sib.changedFiles && sib.changedFiles.length
          ? ` files=[${sib.changedFiles.join(", ")}]`
          : ""));
    }
    lines.push("Expect their edits already present or upcoming; coordinate rather than overwrite blindly.");
  } else {
    lines.push("Parallel siblings: (none)");
  }
  const writers = focus.workspace && Array.isArray(focus.workspace.concurrentWriters)
    ? focus.workspace.concurrentWriters
    : [];
  if (writers.length > 0) {
    lines.push(`Concurrent writers: ${writers.join(", ")}`);
  }
  return lines.join("\n");
}

module.exports = {
  getExecutionKind,
  listParallelSiblings,
  buildTaskFocus,
  renderTaskFocusText,
  nodeSummary,
};

"use strict";

/**
 * Per-TaskRun tool provenance for changedFiles (not git diff attribution).
 */

function ensureProvenanceStore(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  if (!state.toolProvenance || typeof state.toolProvenance !== "object") {
    state.toolProvenance = { byTaskRunId: {} };
  }
  if (!state.toolProvenance.byTaskRunId || typeof state.toolProvenance.byTaskRunId !== "object") {
    state.toolProvenance.byTaskRunId = {};
  }
  return state.toolProvenance;
}

function touchedPathsFromTool(tool = "", args = {}) {
  const name = String(tool || "").trim().toLowerCase();
  const paths = [];
  if (name === "write" || name === "edit") {
    const path = String(args && args.path || "").trim();
    if (path) paths.push(path);
  }
  return paths;
}

function recordToolProvenance(executionState = null, {
  taskRunId = "",
  tool = "",
  args = {},
  graphId = "",
  nodeId = "",
} = {}) {
  const id = String(taskRunId || "").trim();
  if (!id) return [];
  const store = ensureProvenanceStore(executionState);
  if (!store.byTaskRunId[id]) {
    store.byTaskRunId[id] = { paths: [], events: [] };
  }
  const bucket = store.byTaskRunId[id];
  const paths = touchedPathsFromTool(tool, args);
  for (const path of paths) {
    if (!bucket.paths.includes(path)) bucket.paths.push(path);
  }
  bucket.events.push({
    at: new Date().toISOString(),
    tool: String(tool || ""),
    graphId: String(graphId || ""),
    nodeId: String(nodeId || ""),
    paths,
  });
  // Cap event log
  if (bucket.events.length > 200) bucket.events = bucket.events.slice(-200);
  return paths;
}

function getProvenanceChangedFiles(executionState = null, taskRunId = "") {
  const store = ensureProvenanceStore(executionState);
  const id = String(taskRunId || "").trim();
  const bucket = store.byTaskRunId[id];
  return bucket && Array.isArray(bucket.paths) ? bucket.paths.slice() : [];
}

module.exports = {
  ensureProvenanceStore,
  touchedPathsFromTool,
  recordToolProvenance,
  getProvenanceChangedFiles,
};

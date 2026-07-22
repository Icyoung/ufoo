"use strict";

/**
 * Plan UI projection — user-facing progress view over planGraph + TaskRuns.
 * Hides IR fields (dependsOn, childGraphId, revisions) from the default surface.
 */

const { projectPlanView } = require("./planGraphService");
const { listActiveWritingTaskRuns } = require("../runtime/taskRun");
const { hasActiveWriteLease } = require("../runtime/workspaceLease");

const ACTIVE_STATUSES = new Set(["running", "waiting_llm", "waiting_approval"]);
const DONE_STATUSES = new Set(["succeeded"]);
const FAILED_STATUSES = new Set(["failed", "blocked"]);
const CANCELLED_STATUSES = new Set(["cancelled", "skipped"]);

function ensurePlanUiState(executionState = null) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  if (!state.planUi || typeof state.planUi !== "object") {
    state.planUi = { bandMode: "auto" };
  }
  if (!state.planUi.bandMode) state.planUi.bandMode = "auto";
  return state.planUi;
}

function getBandMode(executionState = null) {
  return ensurePlanUiState(executionState).bandMode || "auto";
}

function setBandMode(executionState = null, mode = "auto") {
  const ui = ensurePlanUiState(executionState);
  const next = String(mode || "auto").trim().toLowerCase();
  const allowed = new Set(["auto", "hidden", "expanded", "debug"]);
  ui.bandMode = allowed.has(next) ? next : "auto";
  return ui.bandMode;
}

function statusToMark(status = "") {
  const value = String(status || "").trim().toLowerCase();
  if (DONE_STATUSES.has(value)) return { mark: "✓", kind: "done" };
  if (FAILED_STATUSES.has(value)) return { mark: "✗", kind: "failed" };
  if (CANCELLED_STATUSES.has(value)) return { mark: "⊘", kind: "cancelled" };
  if (ACTIVE_STATUSES.has(value)) return { mark: "→", kind: "active" };
  return { mark: "○", kind: "pending" };
}

function nodeTitle(node = null) {
  if (!node) return "";
  if (node.type === "tool") {
    return node.tool ? `${node.id}:${node.tool}` : (node.title || node.id);
  }
  return String(node.title || node.objective || node.id || "").trim();
}

function executionKind(node = null) {
  if (!node || node.type !== "task") return "";
  const exec = node.execution;
  if (exec && typeof exec === "object") {
    return String(exec.kind || "").trim().toLowerCase();
  }
  return String(exec || "").trim().toLowerCase();
}

function truncate(text = "", max = 48) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 48;
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(1, limit - 1))}…`;
}

function basenamePath(filePath = "") {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const parts = raw.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || raw;
}

function countTaskProgress(view = []) {
  const tasks = view.filter((node) => node && node.type === "task" && !node.generated);
  const total = tasks.length;
  const done = tasks.filter((node) => DONE_STATUSES.has(String(node.status || "").toLowerCase())).length;
  return { done, total };
}

function resolveFocus(view = [], planGraph = {}, activeRuns = []) {
  const byId = new Map(view.map((node) => [node.id, node]));

  for (const run of activeRuns) {
    const parent = byId.get(run.parentNodeId);
    if (parent) {
      return {
        nodeId: parent.id,
        title: nodeTitle(parent),
        kind: executionKind(parent) === "task_loop" ? "task_loop" : "task",
        status: parent.status || "running",
        taskRunId: run.id,
      };
    }
  }

  const waiting = planGraph.waitingFor;
  if (waiting && waiting.id && byId.has(waiting.id)) {
    const node = byId.get(waiting.id);
    return {
      nodeId: node.id,
      title: nodeTitle(node),
      kind: node.type === "tool" ? "tool" : (executionKind(node) === "task_loop" ? "task_loop" : "task"),
      status: node.status || "waiting_llm",
      taskRunId: "",
    };
  }

  const active = view.find((node) => ACTIVE_STATUSES.has(String(node.status || "").toLowerCase()));
  if (active) {
    return {
      nodeId: active.id,
      title: nodeTitle(active),
      kind: active.type === "tool" ? "tool" : (executionKind(active) === "task_loop" ? "task_loop" : "task"),
      status: active.status,
      taskRunId: "",
    };
  }

  const ready = view.find((node) => String(node.status || "").toLowerCase() === "ready" && node.type === "task");
  if (ready) {
    return {
      nodeId: ready.id,
      title: nodeTitle(ready),
      kind: executionKind(ready) === "task_loop" ? "task_loop" : "task",
      status: ready.status,
      taskRunId: "",
    };
  }

  return null;
}

function buildTreeRows(view = [], {
  focusId = "",
  includeToolsUnderFocus = false,
  debug = false,
} = {}) {
  const byId = new Map(view.map((node) => [node.id, node]));
  const roots = view.filter((node) => (
    node
    && !node.parentId
    && node.type === "task"
    && !node.generated
  ));
  const rows = [];

  function walk(node, depth) {
    if (!node) return;
    const isTool = node.type === "tool";
    if (isTool && !debug) {
      if (!includeToolsUnderFocus || node.parentId !== focusId) return;
    }
    if (!debug && node.generated && node.type !== "task" && node.type !== "tool") return;
    if (!debug && node.type !== "task" && node.type !== "tool") return;

    const { mark, kind } = statusToMark(node.status);
    rows.push({
      depth,
      id: node.id,
      title: nodeTitle(node),
      mark,
      kind,
      type: node.type,
      status: node.status || "pending",
    });

    const childIds = Array.isArray(node.children) ? node.children : [];
    for (const childId of childIds) {
      const child = byId.get(childId);
      if (!child) continue;
      if (child.type === "task") {
        walk(child, depth + 1);
      } else if (
        child.type === "tool"
        && (debug || (includeToolsUnderFocus && node.id === focusId))
      ) {
        walk(child, depth + 1);
      }
    }
  }

  for (const root of roots) walk(root, 0);
  return rows;
}

function formatTreeLine(row = {}) {
  const indent = row.depth > 0
    ? `${"  ".repeat(Math.max(0, row.depth - 1))}├─ `
    : "";
  return `${indent}${row.mark} ${row.title}`;
}

function buildCompactSummary(rows = [], focusId = "") {
  const top = rows.filter((row) => row.depth === 0 && row.type === "task");
  if (top.length === 0) return "";
  return top
    .map((row) => `${row.title} ${row.mark}`)
    .join(" · ");
}

/**
 * Top-level plan tasks from planGraph JSON (no parent, not generated tools).
 */
function listTopLevelPlanTasks(planGraph = {}) {
  const nodes = Array.isArray(planGraph.nodes) ? planGraph.nodes : [];
  return nodes.filter((node) => (
    node
    && node.type === "task"
    && !String(node.parentTaskId || "").trim()
    && !node.generated
  ));
}

/**
 * Parse planGraph JSON into a DAG IR: nodes, edges, dependency waves.
 */
function buildPlanDag(planGraph = {}) {
  const tasks = listTopLevelPlanTasks(planGraph);
  const idSet = new Set(tasks.map((node) => String(node.id || "").trim()).filter(Boolean));
  const nodes = tasks.map((task) => {
    const id = String(task.id || "").trim();
    const deps = (Array.isArray(task.dependsOn) ? task.dependsOn : [])
      .map((dep) => String(dep || "").trim())
      .filter((dep) => dep && idSet.has(dep));
    const { mark, kind } = statusToMark(task.status);
    return {
      id,
      title: nodeTitle(task),
      status: String(task.status || "pending"),
      mark,
      kind,
      dependsOn: deps,
      displayOrder: Number(task.displayOrder) || 0,
    };
  }).filter((node) => node.id);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      edges.push({ from: dep, to: node.id });
    }
  }

  const depthMemo = new Map();
  function depthOf(id, stack = new Set()) {
    if (depthMemo.has(id)) return depthMemo.get(id);
    if (stack.has(id)) return 0;
    stack.add(id);
    const node = byId.get(id);
    let depth = 0;
    if (node) {
      for (const dep of node.dependsOn) {
        depth = Math.max(depth, depthOf(dep, stack) + 1);
      }
    }
    stack.delete(id);
    depthMemo.set(id, depth);
    return depth;
  }

  for (const node of nodes) depthOf(node.id);

  const maxDepth = nodes.reduce((max, node) => Math.max(max, depthMemo.get(node.id) || 0), 0);
  const buckets = Array.from({ length: maxDepth + 1 }, () => []);
  const ordered = nodes.slice().sort((a, b) => {
    const depthDiff = (depthMemo.get(a.id) || 0) - (depthMemo.get(b.id) || 0);
    if (depthDiff !== 0) return depthDiff;
    if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
    return a.id.localeCompare(b.id);
  });
  for (const node of ordered) {
    buckets[depthMemo.get(node.id) || 0].push(node);
  }
  const waves = buckets.filter((wave) => wave.length > 0);
  return {
    nodes,
    edges,
    waves,
    linear: waves.length > 0 && waves.every((wave) => wave.length === 1),
  };
}

function waveStepLabel(waveIndex = 0, nodeIndex = 0, waveSize = 1) {
  const step = Math.max(1, Math.floor(Number(waveIndex) || 0) + 1);
  if (waveSize <= 1) return String(step);
  const letter = String.fromCharCode(97 + Math.max(0, Math.min(25, Math.floor(Number(nodeIndex) || 0))));
  return `${step}${letter}`;
}

function formatParallelWaveLines(wave = [], waveIndex = 0, titleMax = 40) {
  const lines = [];
  const size = wave.length;
  wave.forEach((node, nodeIndex) => {
    const label = waveStepLabel(waveIndex, nodeIndex, size);
    const body = `${label} ${node.mark} ${truncate(node.title, titleMax)}`;
    if (nodeIndex === 0) {
      lines.push(`  ┌─ ${body}`);
      if (size > 1) lines.push("──┤");
      return;
    }
    if (nodeIndex === size - 1) {
      lines.push(`  └─ ${body}`);
      return;
    }
    lines.push(`  ├─ ${body}`);
  });
  return lines;
}

/**
 * Build markdown (linear list) or ASCII flowchart (parallel waves) from planGraph JSON.
 */
function buildRoadmapMarkdown(planGraph = {}, {
  cols = 80,
  taskRunLine = "",
  maxRows = 10,
} = {}) {
  const dag = buildPlanDag(planGraph);
  if (dag.nodes.length === 0) {
    return { markdown: "", lines: [], dag };
  }

  const titleMax = Math.max(12, Math.min(48, Math.floor(Number(cols) || 80) - 12));
  const objective = truncate(String(planGraph.objective || "").trim(), titleMax);
  const lines = [objective ? `**Plan** · ${objective}` : "**Plan**"];

  if (dag.linear) {
    dag.waves.forEach((wave, waveIndex) => {
      const node = wave[0];
      lines.push(`${waveIndex + 1}. ${node.mark} ${truncate(node.title, titleMax)}`);
    });
  } else {
    dag.waves.forEach((wave, waveIndex) => {
      if (wave.length === 1) {
        const node = wave[0];
        lines.push(`${waveStepLabel(waveIndex, 0, 1)} ${node.mark} ${truncate(node.title, titleMax)}`);
        return;
      }
      for (const line of formatParallelWaveLines(wave, waveIndex, Math.max(8, titleMax - 4))) {
        lines.push(line);
      }
    });
  }

  const extra = String(taskRunLine || "").trim();
  if (extra) lines.push(extra);

  const limit = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 10;
  let clipped = lines.slice(0, Math.max(1, limit));
  if (lines.length > clipped.length) {
    clipped = clipped.slice(0, Math.max(1, limit - 1));
    clipped.push(`… +${lines.length - clipped.length} more`);
  }

  return {
    markdown: clipped.join("\n"),
    lines: clipped,
    dag,
  };
}

function buildDebugLines(executionState = null, planGraph = {}) {
  const lines = [];
  const pg = planGraph && typeof planGraph === "object" ? planGraph : {};
  lines.push(`graphId=${pg.graphId || "-"} spec=${Number(pg.specRevision) || 0} state=${Number(pg.stateRevision) || 0}`);
  const nodes = Array.isArray(pg.nodes) ? pg.nodes : [];
  for (const node of nodes.slice(0, 12)) {
    const deps = Array.isArray(node.dependsOn) ? node.dependsOn.join(",") : "";
    lines.push(
      `${node.id} type=${node.type} status=${node.status || "pending"}`
      + (deps ? ` deps=[${deps}]` : "")
      + (node.parentTaskId ? ` parent=${node.parentTaskId}` : "")
    );
  }
  if (nodes.length > 12) lines.push(`… +${nodes.length - 12} nodes`);
  const runs = listActiveWritingTaskRuns(executionState);
  for (const run of runs) {
    lines.push(`taskRun ${run.id} node=${run.parentNodeId} status=${run.status} phase=${run.phase || ""}`);
  }
  const lease = executionState && executionState.workspaceLease;
  if (lease && lease.holder) {
    lines.push(`lease ${lease.holder.kind}${lease.holder.taskRunId ? `:${lease.holder.taskRunId}` : ""}`);
  }
  return lines;
}

function buildTaskRunProjection(executionState = null, view = []) {
  const active = listActiveWritingTaskRuns(executionState)[0] || null;
  if (!active) return null;
  const byId = new Map(view.map((node) => [node.id, node]));
  const parent = byId.get(active.parentNodeId);
  const files = Array.isArray(active.changedFiles) ? active.changedFiles : [];
  const hint = files.slice(-2).map(basenamePath).filter(Boolean).join(", ");
  return {
    phase: String(active.phase || active.status || "running"),
    status: String(active.status || ""),
    parentTitle: parent ? nodeTitle(parent) : active.parentNodeId,
    taskRunId: active.id,
    changedFilesHint: hint,
  };
}

function projectionHash({
  bandMode = "auto",
  specRevision = 0,
  stateRevision = 0,
  focusId = "",
  taskRunId = "",
  leaseHeld = false,
  progressDone = 0,
  progressTotal = 0,
  bandLines = [],
} = {}) {
  return [
    bandMode,
    specRevision,
    stateRevision,
    focusId,
    taskRunId,
    leaseHeld ? "1" : "0",
    progressDone,
    progressTotal,
    bandLines.join("\n"),
  ].join("|");
}

/**
 * Build TUI-facing plan projection.
 *
 * @param {object|null} executionState
 * @param {{ cols?: number, activityMessage?: string, maxBandRows?: number }} [options]
 */
function buildPlanUiProjection(executionState = null, options = {}) {
  const state = executionState && typeof executionState === "object" ? executionState : {};
  const bandMode = getBandMode(state);
  const cols = Number(options.cols) > 0 ? Math.floor(Number(options.cols)) : 80;
  const narrow = cols < 60;
  const activityMessage = String(options.activityMessage || "").trim();

  const pg = state.planGraph && typeof state.planGraph === "object" ? state.planGraph : {};
  const view = projectPlanView(pg);
  const taskNodes = view.filter((node) => node && node.type === "task" && !node.generated);
  const hasPlan = Boolean(pg.graphId) && taskNodes.length > 0;
  const progress = countTaskProgress(view);
  const activeRuns = listActiveWritingTaskRuns(state);
  const focus = resolveFocus(view, pg, activeRuns);
  const taskRun = buildTaskRunProjection(state, view);
  const leaseHeld = hasActiveWriteLease(state);

  const includeTools = bandMode === "expanded" || bandMode === "debug";
  const tree = hasPlan
    ? buildTreeRows(view, {
      focusId: focus ? focus.nodeId : "",
      includeToolsUnderFocus: includeTools,
      debug: bandMode === "debug",
    })
    : [];

  const progressLabel = progress.total > 0 ? `${progress.done}/${progress.total}` : "";
  const focusTitle = focus ? truncate(focus.title, narrow ? 18 : 28) : "";

  let bandLines = [];
  let roadmapMarkdown = "";
  let visible = false;
  let planDag = null;

  const taskRunSuffix = (() => {
    if (!taskRun) return "";
    const leaseBit = leaseHeld ? "writing" : taskRun.phase;
    const files = taskRun.changedFilesHint ? ` · ${taskRun.changedFilesHint}` : "";
    return `TaskLoop ${leaseBit}${files}`;
  })();

  if (hasPlan && bandMode !== "hidden") {
    visible = true;
    if (bandMode === "debug") {
      bandLines = buildDebugLines(state, pg);
      roadmapMarkdown = "";
    } else if (narrow) {
      const summary = buildCompactSummary(tree, focus && focus.nodeId);
      bandLines = [truncate(
        `Plan${focusTitle ? ` · ${focusTitle}` : ""}${progressLabel ? ` (${progressLabel})` : ""}${summary && !focusTitle ? `  ${summary}` : ""}`,
        Math.max(24, cols - 2)
      )];
      roadmapMarkdown = "";
    } else {
      // auto + expanded: JSON → DAG → roadmap markdown
      const maxRows = Number.isFinite(options.maxBandRows)
        ? options.maxBandRows
        : (bandMode === "expanded" ? 16 : 10);
      const roadmap = buildRoadmapMarkdown(pg, {
        cols,
        taskRunLine: taskRunSuffix,
        maxRows,
      });
      planDag = roadmap.dag;
      roadmapMarkdown = roadmap.markdown;
      bandLines = roadmap.lines.slice();
      if (bandMode === "expanded" && tree.length > 0) {
        // Keep tree as fallback detail only when roadmap empty (shouldn't happen).
        if (bandLines.length === 0) {
          const title = pg.objective ? `Plan · ${pg.objective}` : "Plan";
          bandLines = [truncate(title, Math.max(24, cols - 2))];
          for (const row of tree) {
            bandLines.push(truncate(formatTreeLine(row), Math.max(24, cols - 2)));
          }
        }
      }
    }
  }

  const progressLabelForStatus = progress.total > 0 ? `${progress.done}/${progress.total}` : "";
  let statusLine = "";
  if (hasPlan) {
    const parts = ["Plan"];
    if (focusTitle) parts.push(focusTitle);
    if (progressLabelForStatus) parts.push(`(${progressLabelForStatus})`);
    if (taskRun) parts.push(`TaskLoop ${taskRun.phase || "running"}`);
    else if (focus && ACTIVE_STATUSES.has(String(focus.status || "").toLowerCase())) {
      parts.push(String(focus.status).replace(/_/g, " "));
    }
    statusLine = parts.join(" · ");
  }

  let idleHint = "";
  if (hasPlan && progress.total > 0 && progress.done < progress.total) {
    idleHint = focusTitle
      ? `Plan waiting: ${focusTitle}${progressLabelForStatus ? ` (${progressLabelForStatus})` : ""}`
      : `Plan (${progressLabelForStatus})`;
  }

  let activityStatusLine = activityMessage;
  if (hasPlan && statusLine) {
    if (!activityMessage) {
      activityStatusLine = statusLine;
    } else {
      const tail = truncate(activityMessage, narrow ? 24 : 36);
      activityStatusLine = `${statusLine} · ${tail}`;
    }
  }

  const hash = projectionHash({
    bandMode,
    specRevision: Number(pg.specRevision) || 0,
    stateRevision: Number(pg.stateRevision) || 0,
    focusId: focus ? focus.nodeId : "",
    taskRunId: taskRun ? taskRun.taskRunId : "",
    leaseHeld,
    progressDone: progress.done,
    progressTotal: progress.total,
    bandLines: roadmapMarkdown ? [roadmapMarkdown] : bandLines,
  });

  return {
    hasPlan,
    visible,
    bandMode,
    objective: String(pg.objective || "").trim(),
    progress,
    focus,
    tree,
    dag: planDag,
    taskRun,
    leaseHeld,
    statusLine,
    idleHint,
    activityStatusLine,
    roadmapMarkdown,
    bandLines,
    hash,
  };
}

module.exports = {
  ensurePlanUiState,
  getBandMode,
  setBandMode,
  statusToMark,
  buildPlanDag,
  buildRoadmapMarkdown,
  buildPlanUiProjection,
};

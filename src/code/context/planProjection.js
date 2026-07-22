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

function countDagProgress(dag = {}) {
  const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
  const total = nodes.length;
  const done = nodes.filter((node) => node && node.kind === "done").length;
  return { done, total };
}

function titleMaxForCols(cols = 80, reserved = 12) {
  return Math.max(12, Math.min(48, Math.floor(Number(cols) || 80) - reserved));
}

function pickFocusActiveNodes(dag = {}) {
  const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
  const active = nodes.filter((node) => node && node.kind === "active");
  if (active.length > 0) return active;

  const waves = Array.isArray(dag.waves) ? dag.waves : [];
  for (const wave of waves) {
    const incomplete = (Array.isArray(wave) ? wave : []).filter((node) => (
      node
      && node.kind !== "done"
      && node.kind !== "cancelled"
    ));
    if (incomplete.length === 0) continue;
    const ready = incomplete.filter((node) => String(node.status || "").toLowerCase() === "ready");
    return ready.length > 0 ? ready : incomplete.slice(0, 1);
  }
  return [];
}

function pickUpcomingNodes(dag = {}, activeIds = new Set(), limit = 2) {
  const upcoming = [];
  const waves = Array.isArray(dag.waves) ? dag.waves : [];
  for (const wave of waves) {
    for (const node of (Array.isArray(wave) ? wave : [])) {
      if (!node || activeIds.has(node.id)) continue;
      if (node.kind === "done" || node.kind === "cancelled") continue;
      upcoming.push(node);
      if (upcoming.length >= limit) return upcoming;
    }
    if (upcoming.length >= limit) break;
  }
  return upcoming;
}

function clipRoadmapLines(lines = [], maxRows = 10) {
  const list = Array.isArray(lines) ? lines : [];
  const limit = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : 10;
  if (list.length <= limit) return list.slice();
  const clipped = list.slice(0, Math.max(1, limit - 1));
  clipped.push(`… +${list.length - clipped.length} more`);
  return clipped;
}

/**
 * Default auto band: progress + current task(s) + next titles.
 * No ASCII tree, no 4a/4b labels.
 */
function buildFocusRoadmap(planGraph = {}, {
  cols = 80,
  taskRunLine = "",
  maxRows = 4,
} = {}) {
  const dag = buildPlanDag(planGraph);
  if (dag.nodes.length === 0) {
    return { markdown: "", lines: [], dag };
  }

  const titleMax = titleMaxForCols(cols, 8);
  const { done, total } = countDagProgress(dag);
  const lines = [`**Plan** · ${done}/${total}`];

  const active = pickFocusActiveNodes(dag);
  const activeIds = new Set(active.map((node) => node.id));
  for (const node of active) {
    lines.push(`${node.mark} ${truncate(node.title, titleMax)}`);
  }

  const upcoming = pickUpcomingNodes(dag, activeIds, 2);
  if (upcoming.length > 0) {
    const titles = upcoming.map((node) => truncate(node.title, Math.max(8, Math.floor(titleMax / upcoming.length))));
    lines.push(`接下来 · ${titles.join(" · ")}`);
  }

  const extra = String(taskRunLine || "").trim();
  if (extra) lines.push(truncate(extra, Math.max(24, titleMax + 8)));

  const clipped = clipRoadmapLines(lines, maxRows);
  return {
    markdown: clipped.join("\n"),
    lines: clipped,
    dag,
  };
}

/**
 * Expanded (/plan focus): flat numbered list; parallel waves share a step number.
 */
function buildExpandedRoadmap(planGraph = {}, {
  cols = 80,
  taskRunLine = "",
  maxRows = 16,
} = {}) {
  const dag = buildPlanDag(planGraph);
  if (dag.nodes.length === 0) {
    return { markdown: "", lines: [], dag };
  }

  const titleMax = titleMaxForCols(cols, 14);
  const { done, total } = countDagProgress(dag);
  const objective = truncate(String(planGraph.objective || "").trim(), Math.max(12, titleMax - 8));
  const header = objective
    ? `**Plan** · ${done}/${total} · ${objective}`
    : `**Plan** · ${done}/${total}`;
  const body = [];

  dag.waves.forEach((wave, waveIndex) => {
    const step = waveIndex + 1;
    for (const node of wave) {
      body.push(`${node.mark} ${step} ${truncate(node.title, titleMax)}`);
    }
  });

  const extra = String(taskRunLine || "").trim();
  if (extra) body.push(truncate(extra, Math.max(24, titleMax + 8)));

  const budget = Math.max(1, (Number.isFinite(maxRows) ? Math.floor(maxRows) : 16) - 1);
  let clippedBody = body;
  if (body.length > budget) {
    let windowStart = 0;
    while (
      windowStart < body.length
      && (body[windowStart].startsWith("✓") || body[windowStart].startsWith("⊘"))
    ) {
      windowStart += 1;
    }
    // Keep one completed row before the live window for context.
    windowStart = Math.max(0, windowStart - 1);
    const window = body.slice(windowStart);
    if (window.length <= budget) {
      clippedBody = windowStart > 0
        ? [`… +${windowStart} more`, ...window]
        : window;
    } else {
      const kept = window.slice(0, Math.max(1, budget - 1));
      const omittedAfter = body.length - (windowStart + kept.length);
      clippedBody = windowStart > 0
        ? [`… +${windowStart} more`, ...kept.slice(0, Math.max(1, budget - 2)), `… +${omittedAfter} more`]
        : [...kept, `… +${omittedAfter} more`];
      // If double ellipsis blew the budget, fall back to simple clip.
      if (clippedBody.length > budget) {
        clippedBody = clipRoadmapLines(body, budget);
      }
    }
  }

  const lines = [header, ...clippedBody];
  return {
    markdown: lines.join("\n"),
    lines,
    dag,
  };
}

/**
 * Build roadmap markdown from planGraph JSON.
 * variant=focus (default auto band) or expanded (/plan focus).
 */
function buildRoadmapMarkdown(planGraph = {}, options = {}) {
  const variant = String(options.variant || "focus").trim().toLowerCase() === "expanded"
    ? "expanded"
    : "focus";
  if (variant === "expanded") {
    return buildExpandedRoadmap(planGraph, options);
  }
  return buildFocusRoadmap(planGraph, options);
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
      // auto → progress-focus; expanded → flat numbered list (no ASCII tree)
      const variant = bandMode === "expanded" ? "expanded" : "focus";
      const maxRows = Number.isFinite(options.maxBandRows)
        ? options.maxBandRows
        : (variant === "expanded" ? 16 : 4);
      const roadmap = buildRoadmapMarkdown(pg, {
        cols,
        taskRunLine: taskRunSuffix,
        maxRows,
        variant,
      });
      planDag = roadmap.dag;
      roadmapMarkdown = roadmap.markdown;
      bandLines = roadmap.lines.slice();
      if (bandLines.length === 0 && tree.length > 0) {
        const title = pg.objective ? `Plan · ${pg.objective}` : "Plan";
        bandLines = [truncate(title, Math.max(24, cols - 2))];
        for (const row of tree) {
          bandLines.push(truncate(formatTreeLine(row), Math.max(24, cols - 2)));
        }
        roadmapMarkdown = "";
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
  buildFocusRoadmap,
  buildExpandedRoadmap,
  buildPlanUiProjection,
};

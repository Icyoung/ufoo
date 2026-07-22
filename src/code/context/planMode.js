"use strict";

/**
 * Plan mode: agent-runtime session posture (not part of the plan_graph engine).
 *
 * Plan Mode gates side-effect tools at the runtime boundary. The plan_graph
 * engine remains available independently for structured execution.
 *
 * Surfaces (no agent tool toggle):
 * - User: /plan on|off|show|hide|focus|debug|clear
 * - Runtime: auto-enter after successful plan_graph create
 */

const { projectPlanView } = require("./planGraphService");
const {
  buildPlanUiProjection,
  setBandMode,
  ensurePlanUiState,
  getBandMode,
} = require("./planProjection");

function getBandModeSafe(executionState = null) {
  return getBandMode(executionState);
}

function ensureExecutionState(sessionState = {}) {
  const state = sessionState && typeof sessionState === "object" ? sessionState : {};
  if (!state.executionState || typeof state.executionState !== "object") {
    state.executionState = require("./executionSegment").emptyExecutionState();
  }
  if (typeof state.executionState.planMode !== "boolean") {
    state.executionState.planMode = false;
  }
  if (!state.executionState.planModeSource) {
    state.executionState.planModeSource = "";
  }
  return state;
}

function normalizePlanModeState(executionState = null) {
  const state = executionState && typeof executionState === "object"
    ? executionState
    : {};
  if (typeof state.planMode !== "boolean") state.planMode = false;
  if (typeof state.planModeSource !== "string") state.planModeSource = "";
  return state;
}

function isPlanModeEnabled(executionState = null) {
  return Boolean(executionState && executionState.planMode === true);
}

function getPlanModeSource(executionState = null) {
  const state = normalizePlanModeState(executionState);
  return String(state.planModeSource || "").trim().toLowerCase();
}

function setPlanMode(executionState = null, enabled = true, {
  reason = "",
  source = "",
} = {}) {
  const state = normalizePlanModeState(executionState);
  const next = Boolean(enabled);
  const wasOn = state.planMode === true;
  state.planMode = next;
  // R5 dual-write: Plan Mode UI maps to planningPolicy only.
  state.planningPolicy = next ? "graph_required" : "direct_allowed";
  if (!state.executionOwner || typeof state.executionOwner !== "object") {
    state.executionOwner = { kind: "none", id: "" };
  }
  if (next) {
    if (!wasOn) state.planModeEnteredAt = new Date().toISOString();
    state.planModeReason = String(reason || state.planModeReason || "").trim();
    const src = String(source || "").trim().toLowerCase();
    if (src === "user" || src === "auto") {
      state.planModeSource = src;
    } else if (!state.planModeSource) {
      state.planModeSource = "auto";
    }
  } else {
    state.planModeEnteredAt = "";
    state.planModeReason = String(reason || "").trim();
    state.planModeSource = "";
  }
  return state;
}

/**
 * Enter Plan Mode after the agent successfully creates a plan graph.
 * No-op if already enabled (preserves user source).
 */
function enterPlanModeAfterGraphCreate(executionState = null, {
  reason = "plan_graph create",
} = {}) {
  const state = normalizePlanModeState(executionState);
  if (state.planMode) {
    return { changed: false, planMode: true, source: state.planModeSource || "auto" };
  }
  setPlanMode(state, true, { reason, source: "auto" });
  return { changed: true, planMode: true, source: "auto" };
}

function planHasNodes(executionState = null) {
  const pg = executionState && executionState.planGraph;
  return Boolean(pg && pg.graphId && Array.isArray(pg.nodes) && pg.nodes.length > 0);
}

function planModeBlocksDirectTool(tool = "", executionState = null) {
  const { getPlanningPolicy } = require("../protocol/controlPlane");
  const policy = getPlanningPolicy(executionState);
  if (policy !== "graph_required") return false;
  const name = String(tool || "").trim().toLowerCase();
  return name === "write" || name === "edit" || name === "bash";
}

function statusMark(status = "") {
  const value = String(status || "").trim().toLowerCase();
  if (value === "succeeded") return "✓";
  if (value === "failed" || value === "blocked" || value === "cancelled") return "✗";
  if (value === "waiting_llm" || value === "waiting_approval" || value === "running") return "→";
  if (value === "skipped") return "·";
  return "○";
}

function formatPlanTreeLines(planGraph = {}, { includeGenerated = true } = {}) {
  const pg = planGraph && typeof planGraph === "object" ? planGraph : {};
  const view = projectPlanView(pg);
  if (view.length === 0) return ["(no plan graph yet — call plan_graph create)"];

  const byId = new Map(view.map((node) => [node.id, node]));
  const roots = view.filter((node) => !node.parentId && (!node.generated || node.type === "task"));
  const lines = [];

  function walk(node, depth) {
    if (!node) return;
    if (!includeGenerated && node.generated && node.type !== "task") return;
    const indent = "  ".repeat(depth);
    const label = node.type === "tool"
      ? `${node.id}${node.tool ? `:${node.tool}` : ""}`
      : (node.title || node.id);
    const extra = node.type === "task" && node.execution === "aggregate"
      ? " [aggregate]"
      : "";
    lines.push(`${indent}${statusMark(node.status)} ${label}${extra}`);
    for (const childId of node.children || []) {
      walk(byId.get(childId), depth + 1);
    }
  }

  for (const root of roots) walk(root, 0);

  if (includeGenerated) {
    for (const node of view) {
      if (node.parentId) continue;
      if (roots.some((root) => root.id === node.id)) continue;
      walk(node, 0);
    }
  }

  return lines.length > 0 ? lines : ["(empty plan)"];
}

function formatPlanModeStatus(executionState = null) {
  const state = normalizePlanModeState(executionState);
  const pg = state.planGraph && typeof state.planGraph === "object" ? state.planGraph : {};
  const waiting = pg.waitingFor && pg.waitingFor.id
    ? `${pg.waitingFor.type}:${pg.waitingFor.id}`
    : "-";
  const source = getPlanModeSource(state) || "-";
  const lines = [
    `Plan mode: ${state.planMode ? "ON" : "OFF"} (source=${source})`,
    `Graph: ${pg.graphId || "(none)"}`,
    `Revisions: spec=${Number(pg.specRevision) || 0} state=${Number(pg.stateRevision) || 0}`,
    `Waiting: ${waiting}`,
    `Yield: ${pg.lastYieldReason || "-"}`,
    "Plan:",
    ...formatPlanTreeLines(pg).map((line) => `  ${line}`),
  ];
  if (state.planMode) {
    lines.push("");
    lines.push("Rules while ON:");
    lines.push("  - Use plan_graph to create/expand/complete the plan");
    lines.push("  - write / edit / bash are blocked as direct tools");
    lines.push("  - read / artifact_read allowed for exploration");
    lines.push("  - Runtime auto-advances ready tool nodes after plan_graph");
    lines.push("  - User leaves with /plan off (agents cannot toggle Plan Mode)");
  } else {
    lines.push("");
    lines.push("User can enable with /plan on. Creating a plan_graph also enables Plan Mode.");
    lines.push("Simple multi-step tool calls do not need Plan Mode.");
  }
  return lines.join("\n");
}

/**
 * Injected into turnDynamic so the model sees plan-mode constraints every turn.
 */
function renderPlanModeContext(executionState = null) {
  if (!isPlanModeEnabled(executionState)) return "";
  const pg = executionState.planGraph && typeof executionState.planGraph === "object"
    ? executionState.planGraph
    : {};
  const source = getPlanModeSource(executionState);
  const hasPlan = planHasNodes(executionState);
  const lines = [
    "Plan Mode: ON",
  ];

  if (source === "user" && !hasPlan) {
    lines.push(
      "The user enabled Plan Mode. You must plan before executing side effects.",
      "First call plan_graph create with a small set of high-level tasks (progressive planning).",
      "Do not call write/edit/bash directly until the plan exists and work is routed through it.",
    );
  } else if (source === "user") {
    lines.push(
      "The user enabled Plan Mode — keep work on the plan graph; expand/complete tasks deliberately.",
    );
  } else {
    lines.push(
      "Plan Mode was enabled automatically after plan_graph create.",
    );
  }

  lines.push(
    "Allowed direct tools: read, artifact_read, plan_graph, ask_user.",
    "Blocked direct tools: write, edit, bash (route them as plan_graph tool nodes or task_loop).",
    "Plan Mode constrains the Agent Loop only; running TaskLoops are not paused or reconfigured by /plan off.",
    "Only the user can leave Plan Mode (/plan off). That does not cancel the graph or TaskRuns — use cancel_graph / control.cancel_task.",
    "Workflow while ON:",
    "  1) Ensure a plan_graph exists (create if missing)",
    "  2) expand_node on the current ready/waiting task when needed",
    "  3) Runtime executes ready tools / TaskLoops; continue from results",
    "  4) control.complete_task (inline) or control.start_task (task_loop)",
    "Do not mix plan_graph with data-plane tools in the same turn.",
  );

  if (pg.graphId) {
    lines.push(`Active graph: ${pg.graphId} (specRev ${Number(pg.specRevision) || 0})`);
  }
  if (pg.waitingFor && pg.waitingFor.id) {
    lines.push(`Currently waiting on: ${pg.waitingFor.type} ${pg.waitingFor.id}`
      + (pg.waitingFor.title || pg.waitingFor.objective
        ? ` — ${pg.waitingFor.title || pg.waitingFor.objective}`
        : ""));
  }
  const tree = formatPlanTreeLines(pg);
  if (tree.length > 0) {
    lines.push("Current plan:");
    for (const line of tree) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}

function applyUcodePlanCommand(sessionState = {}, result = {}) {
  const action = String(result.action || "").trim().toLowerCase();
  const state = ensureExecutionState(sessionState);
  normalizePlanModeState(state.executionState);
  ensurePlanUiState(state.executionState);

  if (action === "show" || action === "" || action === "status") {
    if (getBandModeSafe(state.executionState) === "hidden") {
      setBandMode(state.executionState, "auto");
    }
    return {
      ok: true,
      output: formatPlanModeStatus(state.executionState),
      state,
      planMode: state.executionState.planMode,
      planUi: buildPlanUiProjection(state.executionState),
      refreshPlanUi: true,
    };
  }

  if (action === "hide") {
    setBandMode(state.executionState, "hidden");
    return {
      ok: true,
      output: "Plan band hidden. Use /plan show to reveal it again.",
      state,
      planMode: state.executionState.planMode,
      planUi: buildPlanUiProjection(state.executionState),
      refreshPlanUi: true,
    };
  }

  if (action === "focus") {
    setBandMode(state.executionState, "expanded");
    const projection = buildPlanUiProjection(state.executionState);
    const lines = projection.bandLines.length > 0
      ? projection.bandLines
      : ["(no plan graph yet)"];
    return {
      ok: true,
      output: ["Plan band: expanded", ...lines].join("\n"),
      state,
      planMode: state.executionState.planMode,
      planUi: projection,
      refreshPlanUi: true,
    };
  }

  if (action === "debug") {
    setBandMode(state.executionState, "debug");
    const projection = buildPlanUiProjection(state.executionState);
    return {
      ok: true,
      output: ["Plan band: debug", ...projection.bandLines].join("\n"),
      state,
      planMode: state.executionState.planMode,
      planUi: projection,
      refreshPlanUi: true,
    };
  }

  if (action === "on" || action === "enable") {
    const wasOn = isPlanModeEnabled(state.executionState);
    setPlanMode(state.executionState, true, {
      reason: "user /plan on",
      source: "user",
    });
    const hasPlan = planHasNodes(state.executionState);
    const lines = [
      wasOn ? "Plan mode already ON." : "Plan mode: ON (user)",
      "",
      "Side-effect tools (write/edit/bash) are blocked as direct calls.",
      hasPlan
        ? "Continue via plan_graph expand/control; Runtime advances ready tool nodes."
        : "No plan yet — the agent will be prompted to create a plan_graph first.",
      "Use /plan to inspect the tree, /plan off to leave.",
    ];
    const tree = formatPlanTreeLines(state.executionState.planGraph || {});
    if (tree[0] && !tree[0].startsWith("(no plan")) {
      lines.push("", "Current plan:", ...tree.map((line) => `  ${line}`));
    }
    return {
      ok: true,
      output: lines.join("\n"),
      state,
      planMode: true,
      planUi: buildPlanUiProjection(state.executionState),
      refreshPlanUi: true,
    };
  }

  if (action === "off" || action === "disable") {
    setPlanMode(state.executionState, false, { reason: "user /plan off" });
    return {
      ok: true,
      output: "Plan mode: OFF\nDirect write/edit/bash tools are allowed again.",
      state,
      planMode: false,
      planUi: buildPlanUiProjection(state.executionState),
      refreshPlanUi: true,
    };
  }

  if (action === "clear") {
    const { runPlanGraphCommand } = require("./planGraphService");
    const cleared = runPlanGraphCommand({ operation: "cancel_graph" }, {
      executionState: state.executionState,
      autoAdvance: false,
    });
    state.executionState = cleared.executionState || state.executionState;
    const modeNote = isPlanModeEnabled(state.executionState)
      ? "Plan mode stays ON."
      : "Plan mode is OFF.";
    return {
      ok: true,
      output: `Plan graph cleared. ${modeNote}`,
      state,
      planMode: isPlanModeEnabled(state.executionState),
      planUi: buildPlanUiProjection(state.executionState),
      refreshPlanUi: true,
    };
  }

  if (action === "toggle") {
    return applyUcodePlanCommand(state, {
      action: isPlanModeEnabled(state.executionState) ? "off" : "on",
    });
  }

  return {
    ok: false,
    error: "usage: /plan [on|off|show|hide|focus|debug|clear]",
    output: "usage: /plan [on|off|show|hide|focus|debug|clear]",
    state,
    planMode: isPlanModeEnabled(state.executionState),
  };
}

module.exports = {
  ensureExecutionState,
  normalizePlanModeState,
  isPlanModeEnabled,
  getPlanModeSource,
  setPlanMode,
  enterPlanModeAfterGraphCreate,
  planModeBlocksDirectTool,
  formatPlanTreeLines,
  formatPlanModeStatus,
  renderPlanModeContext,
  applyUcodePlanCommand,
};

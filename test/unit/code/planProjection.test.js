"use strict";

const {
  buildPlanUiProjection,
  buildPlanDag,
  buildRoadmapMarkdown,
  setBandMode,
  getBandMode,
} = require("../../../src/code/context/planProjection");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const { runPlanGraphCommand } = require("../../../src/code/context/planGraphService");
const { applyUcodePlanCommand } = require("../../../src/code/context/planMode");
const { runSingleCommand } = require("../../../src/code/repl");
const { computeStatusText } = require("../../../src/ui/ink/UcodeApp");

function seedPlan(executionState) {
  runPlanGraphCommand({
    operation: "create",
    graph: {
      objective: "fix cancel race",
      nodes: [
        { id: "locate", type: "task", title: "Locate issue" },
        { id: "fix", type: "task", title: "Apply fix", dependsOn: ["locate"] },
        { id: "verify", type: "task", title: "Verify", dependsOn: ["fix"] },
      ],
    },
  }, { executionState, autoAdvance: false });

  runPlanGraphCommand({
    operation: "patch",
    operations: [{
      op: "expand_node",
      nodeId: "locate",
      children: [
        { id: "search", type: "tool", tool: "bash", args: { command: "rg cancel" } },
      ],
    }],
  }, {
    executionState,
    autoAdvance: true,
    runTool: () => ({ ok: true, summary: "found", output: {} }),
  });
}

function seedParallelPlan(executionState) {
  runPlanGraphCommand({
    operation: "create",
    graph: {
      objective: "parallel lanes",
      nodes: [
        { id: "inspect", type: "task", title: "Inspect APIs" },
        { id: "home", type: "task", title: "Home Rank", dependsOn: ["inspect"] },
        { id: "market", type: "task", title: "Market entry", dependsOn: ["inspect"] },
        { id: "verify", type: "task", title: "Verify all", dependsOn: ["home", "market"] },
      ],
    },
  }, { executionState, autoAdvance: false });
}

describe("planProjection", () => {
  test("empty state has no visible band", () => {
    const projection = buildPlanUiProjection(emptyExecutionState());
    expect(projection.hasPlan).toBe(false);
    expect(projection.visible).toBe(false);
    expect(projection.bandLines).toEqual([]);
    expect(projection.roadmapMarkdown).toBe("");
  });

  test("auto band shows progress-focus roadmap (not full list)", () => {
    const executionState = emptyExecutionState();
    seedPlan(executionState);
    const projection = buildPlanUiProjection(executionState, { cols: 100 });
    expect(projection.hasPlan).toBe(true);
    expect(projection.visible).toBe(true);
    expect(projection.roadmapMarkdown).toMatch(/\*\*Plan\*\* · \d+\/\d+/);
    expect(projection.roadmapMarkdown).toMatch(/Locate issue|Apply fix|Verify/);
    // Default auto should not dump every numbered step like expanded does.
    expect(projection.roadmapMarkdown).not.toMatch(/✓ 1 |○ 1 |→ 1 /);
    expect(projection.bandLines.join("\n")).not.toMatch(/dependsOn/);
    expect(projection.bandLines.join("\n")).not.toMatch(/childGraphId/);
    expect(projection.bandLines.join("\n")).not.toMatch(/┌─|└─|──┤/);
    expect(projection.progress.total).toBe(3);
    expect(projection.focus).toBeTruthy();
    expect(projection.statusLine).toMatch(/Plan ·/);
    expect(projection.idleHint).toMatch(/Plan waiting:/);
    expect(projection.dag && projection.dag.linear).toBe(true);
  });

  test("buildPlanDag parses parallel JSON into waves", () => {
    const executionState = emptyExecutionState();
    seedParallelPlan(executionState);
    const dag = buildPlanDag(executionState.planGraph);
    expect(dag.linear).toBe(false);
    expect(dag.waves).toHaveLength(3);
    expect(dag.waves[0].map((n) => n.id)).toEqual(["inspect"]);
    expect(dag.waves[1].map((n) => n.id).sort()).toEqual(["home", "market"]);
    expect(dag.waves[2].map((n) => n.id)).toEqual(["verify"]);
    expect(dag.edges).toEqual(expect.arrayContaining([
      { from: "inspect", to: "home" },
      { from: "inspect", to: "market" },
      { from: "home", to: "verify" },
      { from: "market", to: "verify" },
    ]));
  });

  test("parallel focus roadmap has no ASCII tree or 2a/2b labels", () => {
    const executionState = emptyExecutionState();
    seedParallelPlan(executionState);
    const { markdown, dag } = buildRoadmapMarkdown(executionState.planGraph, {
      cols: 100,
      variant: "focus",
    });
    expect(dag.linear).toBe(false);
    expect(markdown).toMatch(/\*\*Plan\*\* · 0\/4/);
    expect(markdown).toMatch(/Inspect APIs|Home Rank|Market entry/);
    expect(markdown).not.toMatch(/┌─|└─|──┤|├─/);
    expect(markdown).not.toMatch(/2a |2b /);
    const projection = buildPlanUiProjection(executionState, { cols: 100 });
    expect(projection.roadmapMarkdown).not.toMatch(/┌─|2a |2b /);
    expect(projection.roadmapMarkdown).toMatch(/接下来 ·|→ |○ /);
  });

  test("expanded roadmap uses shared step numbers for parallel waves", () => {
    const executionState = emptyExecutionState();
    seedParallelPlan(executionState);
    const inspect = executionState.planGraph.nodes.find((n) => n.id === "inspect");
    inspect.status = "succeeded";
    const home = executionState.planGraph.nodes.find((n) => n.id === "home");
    home.status = "waiting_llm";

    const { markdown, dag } = buildRoadmapMarkdown(executionState.planGraph, {
      cols: 100,
      variant: "expanded",
    });
    expect(dag.linear).toBe(false);
    expect(markdown).toMatch(/✓ 1 Inspect APIs/);
    expect(markdown).toMatch(/→ 2 Home Rank/);
    expect(markdown).toMatch(/○ 2 Market entry/);
    expect(markdown).toMatch(/○ 3 Verify all/);
    expect(markdown).not.toMatch(/┌─|2a |2b /);
  });

  test("roadmap status marks update when node status changes", () => {
    const executionState = emptyExecutionState();
    seedParallelPlan(executionState);
    const before = buildRoadmapMarkdown(executionState.planGraph, {
      cols: 80,
      variant: "expanded",
    });
    expect(before.markdown).toMatch(/○ 1 Inspect APIs|→ 1 Inspect APIs/);

    const inspect = executionState.planGraph.nodes.find((n) => n.id === "inspect");
    inspect.status = "succeeded";
    const home = executionState.planGraph.nodes.find((n) => n.id === "home");
    home.status = "waiting_llm";

    const after = buildRoadmapMarkdown(executionState.planGraph, {
      cols: 80,
      variant: "expanded",
    });
    expect(after.markdown).toMatch(/✓ 1 Inspect APIs/);
    expect(after.markdown).toMatch(/→ 2 Home Rank/);

    const focus = buildRoadmapMarkdown(executionState.planGraph, {
      cols: 80,
      variant: "focus",
    });
    expect(focus.markdown).toMatch(/\*\*Plan\*\* · 1\/4/);
    expect(focus.markdown).toMatch(/→ Home Rank/);
    expect(focus.markdown).toMatch(/接下来 ·/);
  });

  test("hide / focus / debug band modes", () => {
    const executionState = emptyExecutionState();
    seedPlan(executionState);

    setBandMode(executionState, "hidden");
    expect(buildPlanUiProjection(executionState).visible).toBe(false);

    setBandMode(executionState, "expanded");
    const expanded = buildPlanUiProjection(executionState, { cols: 100 });
    expect(expanded.visible).toBe(true);
    expect(expanded.roadmapMarkdown).toMatch(/Locate issue|Apply fix|Verify/);
    expect(expanded.roadmapMarkdown).toMatch(/1 |2 |3 /);
    expect(expanded.roadmapMarkdown).not.toMatch(/┌─/);

    setBandMode(executionState, "debug");
    const debug = buildPlanUiProjection(executionState, { cols: 100 });
    expect(debug.bandLines.some((line) => /graphId=/.test(line))).toBe(true);
    expect(debug.bandLines.some((line) => /deps=/.test(line))).toBe(true);
    expect(debug.roadmapMarkdown).toBe("");
  });

  test("activity status composes plan focus with tool message", () => {
    const executionState = emptyExecutionState();
    seedPlan(executionState);
    const projection = buildPlanUiProjection(executionState, {
      cols: 100,
      activityMessage: "Reading foo.js...",
    });
    expect(projection.activityStatusLine).toMatch(/Plan ·/);
    expect(projection.activityStatusLine).toMatch(/Reading foo\.js/);
  });

  test("hash stable when nothing changes", () => {
    const executionState = emptyExecutionState();
    seedPlan(executionState);
    const a = buildPlanUiProjection(executionState, { cols: 80 });
    const b = buildPlanUiProjection(executionState, { cols: 80 });
    expect(a.hash).toBe(b.hash);
  });

  test("/plan hide|focus|debug parse and apply", () => {
    expect(runSingleCommand("/plan hide").action).toBe("hide");
    expect(runSingleCommand("/plan focus").action).toBe("focus");
    expect(runSingleCommand("/plan debug").action).toBe("debug");

    const state = { executionState: emptyExecutionState() };
    seedPlan(state.executionState);
    applyUcodePlanCommand(state, { action: "hide" });
    expect(getBandMode(state.executionState)).toBe("hidden");
    applyUcodePlanCommand(state, { action: "focus" });
    expect(getBandMode(state.executionState)).toBe("expanded");
    applyUcodePlanCommand(state, { action: "show" });
    expect(getBandMode(state.executionState)).toBe("expanded");
    applyUcodePlanCommand(state, { action: "hide" });
    applyUcodePlanCommand(state, { action: "show" });
    expect(getBandMode(state.executionState)).toBe("auto");
  });

  test("idle status line includes plan hint", () => {
    const text = computeStatusText(
      { message: "", type: "thinking", showTimer: false, startedAt: 0 },
      0,
      "",
      "Plan waiting: Apply fix (1/3)"
    );
    expect(text).toBe("UCODE · Ready · Plan waiting: Apply fix (1/3)");
  });
});

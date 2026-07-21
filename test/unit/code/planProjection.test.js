"use strict";

const {
  buildPlanUiProjection,
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

describe("planProjection", () => {
  test("empty state has no visible band", () => {
    const projection = buildPlanUiProjection(emptyExecutionState());
    expect(projection.hasPlan).toBe(false);
    expect(projection.visible).toBe(false);
    expect(projection.bandLines).toEqual([]);
  });

  test("auto band shows compact progress without IR fields", () => {
    const executionState = emptyExecutionState();
    seedPlan(executionState);
    const projection = buildPlanUiProjection(executionState, { cols: 100 });
    expect(projection.hasPlan).toBe(true);
    expect(projection.visible).toBe(true);
    expect(projection.bandLines[0]).toMatch(/^Plan/);
    expect(projection.bandLines.join("\n")).toMatch(/Locate issue/);
    expect(projection.bandLines.join("\n")).not.toMatch(/dependsOn/);
    expect(projection.bandLines.join("\n")).not.toMatch(/childGraphId/);
    expect(projection.progress.total).toBe(3);
    expect(projection.focus).toBeTruthy();
    expect(projection.statusLine).toMatch(/Plan ·/);
    expect(projection.idleHint).toMatch(/Plan waiting:/);
  });

  test("hide / focus / debug band modes", () => {
    const executionState = emptyExecutionState();
    seedPlan(executionState);

    setBandMode(executionState, "hidden");
    expect(buildPlanUiProjection(executionState).visible).toBe(false);

    setBandMode(executionState, "expanded");
    const expanded = buildPlanUiProjection(executionState, { cols: 100 });
    expect(expanded.visible).toBe(true);
    expect(expanded.bandLines.some((line) => /Locate issue|Apply fix|Verify/.test(line))).toBe(true);

    setBandMode(executionState, "debug");
    const debug = buildPlanUiProjection(executionState, { cols: 100 });
    expect(debug.bandLines.some((line) => /graphId=/.test(line))).toBe(true);
    expect(debug.bandLines.some((line) => /deps=/.test(line))).toBe(true);
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

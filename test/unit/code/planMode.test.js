"use strict";

const {
  applyUcodePlanCommand,
  isPlanModeEnabled,
  planModeBlocksDirectTool,
  renderPlanModeContext,
  formatPlanTreeLines,
  formatPlanModeStatus,
} = require("../../../src/code/context/planMode");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const { runPlanGraphCommand } = require("../../../src/code/context/planGraphService");
const { runSingleCommand } = require("../../../src/code/repl");
const { assembleModelContext } = require("../../../src/code/context/assembler");
const { buildUcodeBannerLines } = require("../../../src/ui/format");

describe("plan mode product surface", () => {
  test("/plan parses on/off/show/hide/focus/debug/clear", () => {
    expect(runSingleCommand("/plan").action).toBe("show");
    expect(runSingleCommand("/plan on").action).toBe("on");
    expect(runSingleCommand("/plan off").action).toBe("off");
    expect(runSingleCommand("/plan clear").action).toBe("clear");
    expect(runSingleCommand("/plan hide").action).toBe("hide");
    expect(runSingleCommand("/plan focus").action).toBe("focus");
    expect(runSingleCommand("/plan debug").action).toBe("debug");
  });

  test("enter plan mode blocks side-effect tools and injects prompt context", () => {
    const state = { executionState: emptyExecutionState(), workspaceRoot: process.cwd() };
    const on = applyUcodePlanCommand(state, { action: "on" });
    expect(on.ok).toBe(true);
    expect(isPlanModeEnabled(state.executionState)).toBe(true);
    expect(state.executionState.planModeSource).toBe("user");
    expect(planModeBlocksDirectTool("bash", state.executionState)).toBe(true);
    expect(planModeBlocksDirectTool("write", state.executionState)).toBe(true);
    expect(planModeBlocksDirectTool("read", state.executionState)).toBe(false);
    expect(planModeBlocksDirectTool("plan_graph", state.executionState)).toBe(false);

    const ctx = renderPlanModeContext(state.executionState);
    expect(ctx).toMatch(/Plan Mode: ON/);
    expect(ctx).toMatch(/user enabled Plan Mode/i);
    expect(ctx).toMatch(/must plan before executing/i);
    expect(ctx).toMatch(/Blocked direct tools/);
    expect(ctx).not.toMatch(/plan_mode action/);
  });

  test("plan tree renders after create + expand", () => {
    const state = { executionState: emptyExecutionState() };
    applyUcodePlanCommand(state, { action: "on" });
    runPlanGraphCommand({
      operation: "create",
      graph: {
        nodes: [
          { id: "inspect", type: "task", title: "Locate code" },
          { id: "fix", type: "task", title: "Apply fix", dependsOn: ["inspect"] },
        ],
      },
    }, { executionState: state.executionState, autoAdvance: false });

    runPlanGraphCommand({
      operation: "patch",
      operations: [{
        op: "expand_node",
        nodeId: "inspect",
        children: [
          { id: "search", type: "tool", tool: "bash", args: { command: "rg x" } },
        ],
      }],
    }, {
      executionState: state.executionState,
      autoAdvance: true,
      runTool: () => ({ ok: true, summary: "search ok", output: {} }),
    });

    const tree = formatPlanTreeLines(state.executionState.planGraph);
    expect(tree.some((line) => /Locate code/.test(line))).toBe(true);
    expect(tree.some((line) => /search/.test(line))).toBe(true);

    const shown = formatPlanModeStatus(state.executionState);
    expect(shown).toMatch(/Plan mode: ON/);
    expect(shown).toMatch(/Locate code/);
  });

  test("assembleModelContext includes plan mode block when enabled", () => {
    const session = {
      sessionId: "sess-plan-mode",
      workspaceRoot: process.cwd(),
      model: "test",
      provider: "openai",
      executionState: emptyExecutionState(),
      nlMessages: [],
    };
    applyUcodePlanCommand(session, { action: "on" });
    const assembled = assembleModelContext(session, {});
    expect(assembled.systemPrompt).toMatch(/Plan Mode: ON/);
  });

  test("banner shows PLAN when planMode true", () => {
    const lines = buildUcodeBannerLines({
      model: "gpt",
      workspaceRoot: "/tmp",
      sessionId: "s1",
      planMode: true,
    });
    expect(lines.join("\n")).toMatch(/PLAN/);
  });

  test("plan_graph create auto-enters Plan Mode; agent has no plan_mode tool", () => {
    const executionState = emptyExecutionState();
    expect(isPlanModeEnabled(executionState)).toBe(false);

    runPlanGraphCommand({
      operation: "create",
      graph: { nodes: [{ id: "t1", type: "task", title: "one" }] },
    }, { executionState, autoAdvance: false });

    expect(executionState.planMode).toBe(true);
    expect(executionState.planModeSource).toBe("auto");
    expect(executionState.planGraph.nodes.length).toBe(1);

    const ctx = renderPlanModeContext(executionState);
    expect(ctx).toMatch(/enabled automatically after plan_graph create/i);
    expect(ctx).not.toMatch(/plan_mode action/);

    // User source is preserved if already on.
    applyUcodePlanCommand({ executionState }, { action: "off" });
    applyUcodePlanCommand({ executionState }, { action: "on" });
    expect(executionState.planModeSource).toBe("user");
    runPlanGraphCommand({
      operation: "create",
      graph: { nodes: [{ id: "t2", type: "task", title: "two" }] },
    }, { executionState, autoAdvance: false });
    expect(executionState.planModeSource).toBe("user");
  });

  test("dispatch does not expose plan_mode tool", () => {
    const { TOOL_NAMES, runToolCall } = require("../../../src/code/dispatch");
    expect(TOOL_NAMES).not.toContain("plan_mode");
    const result = runToolCall({ tool: "plan_mode", args: { action: "enter" } }, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown tool");
  });

  test("/plan clear archives graph but keeps mode", () => {
    const state = { executionState: emptyExecutionState() };
    applyUcodePlanCommand(state, { action: "on" });
    runPlanGraphCommand({
      operation: "create",
      graph: { nodes: [{ id: "t1", type: "task", title: "one" }] },
    }, { executionState: state.executionState, autoAdvance: false });
    expect(state.executionState.planGraph.nodes.length).toBe(1);

    const cleared = applyUcodePlanCommand(state, { action: "clear" });
    expect(cleared.ok).toBe(true);
    expect(state.executionState.planMode).toBe(true);
    expect(state.executionState.planGraph.nodes).toEqual([]);
  });
});

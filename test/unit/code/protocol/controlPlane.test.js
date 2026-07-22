"use strict";

const { emptyExecutionState } = require("../../../../src/code/context/executionSegment");
const { setPlanMode, planModeBlocksDirectTool } = require("../../../../src/code/context/planMode");
const {
  getPlanningPolicy,
  setPlanningPolicy,
  setExecutionOwner,
  getExecutionOwner,
  syncPlanningFields,
} = require("../../../../src/code/protocol/controlPlane");
const {
  ATOMIC_COMMIT_BOUNDARIES,
  SIDE_EFFECT_INVOCATION_PHASES,
} = require("../../../../src/code/protocol/ownership");
const {
  armFault,
  disarmFault,
  withFaultPoint,
  FaultInjectedError,
} = require("../../../../src/code/protocol/faultHarness");
const {
  createToolCallLedger,
  declareCalls,
  resolveCall,
  materializeResolvedToolResults,
} = require("../../../../src/code/protocol");

describe("controlPlane R5", () => {
  test("/plan on dual-writes planningPolicy=graph_required", () => {
    const state = emptyExecutionState();
    setPlanMode(state, true, { source: "user" });
    expect(state.planMode).toBe(true);
    expect(getPlanningPolicy(state)).toBe("graph_required");
    expect(planModeBlocksDirectTool("write", state)).toBe(true);
  });

  test("/plan off clears policy but does not imply cancel TaskRun", () => {
    const state = emptyExecutionState();
    setPlanMode(state, true, { source: "user" });
    setExecutionOwner(state, { kind: "task_run", id: "trun_1" });
    setPlanMode(state, false, { source: "user" });
    expect(getPlanningPolicy(state)).toBe("direct_allowed");
    expect(getExecutionOwner(state)).toEqual({ kind: "task_run", id: "trun_1" });
    expect(planModeBlocksDirectTool("write", state)).toBe(false);
  });

  test("setPlanningPolicy dual-writes planMode", () => {
    const state = emptyExecutionState();
    setPlanningPolicy(state, "graph_required", { source: "user" });
    expect(state.planMode).toBe(true);
    setPlanningPolicy(state, "direct_allowed");
    expect(state.planMode).toBe(false);
  });

  test("syncPlanningFields backfills from legacy planMode", () => {
    const state = emptyExecutionState();
    state.planMode = true;
    delete state.planningPolicy;
    syncPlanningFields(state);
    expect(state.planningPolicy).toBe("graph_required");
  });
});

describe("R4 atomic boundaries + crash fixture", () => {
  afterEach(() => disarmFault());

  test("commit boundary constants are locked", () => {
    expect(ATOMIC_COMMIT_BOUNDARIES).toContain("tool_result_committed_to_ledger");
    expect(ATOMIC_COMMIT_BOUNDARIES).toContain("after_resume_answer_committed");
    expect(SIDE_EFFECT_INVOCATION_PHASES).toEqual([
      "prepared",
      "started",
      "effect_observed",
      "result_committed",
    ]);
  });

  test("crash after declare before materialize leaves unresolved ledger", async () => {
    const ledger = createToolCallLedger({ provider: "openai" });
    declareCalls(ledger, [{ callId: "c1", name: "read", args: {} }]);
    armFault("before_tool_exec");
    await expect(withFaultPoint("before_tool_exec", async () => {
      resolveCall(ledger, "c1", { result: { ok: true } });
    })).rejects.toBeInstanceOf(FaultInjectedError);

    // Recovery rule: unresolved declared call must not be auto-re-executed
    // without reconciliation — materialize skips unresolved.
    const messages = [];
    materializeResolvedToolResults(ledger, {
      transport: {
        appendToolResult({ messages: msgs, call, toolResult }) {
          msgs.push({ role: "tool", tool_call_id: call.source.id, content: JSON.stringify(toolResult) });
        },
      },
      messages,
      pendingById: { c1: { source: { id: "c1" }, name: "read", args: {} } },
    });
    expect(messages).toHaveLength(0);
    expect(ledger.calls.c1.state).toBe("declared");
  });
});

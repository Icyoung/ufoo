"use strict";

const {
  shouldIsolateTaskFocusTurn,
  buildIsolatedTaskFocusTurn,
  sanitizeToolResultForModel,
} = require("../../../src/code/runtime/taskFocusContext");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");

describe("taskFocusContext", () => {
  test("isolates when a TaskRun is waiting_model", () => {
    const state = emptyExecutionState();
    state.taskRuns = {
      byId: {
        trun_1: {
          id: "trun_1",
          status: "running",
          phase: "waiting_model",
          objective: "Implement login",
          title: "Login",
          parentNodeId: "n1",
          childGraphId: "child_1",
          lastFocusText: "Focus: Implement login",
        },
      },
    };
    state.graphs = {
      child_1: {
        graphId: "child_1",
        objective: "Login details",
        nodes: [{ id: "c1", status: "ready", title: "Write tests" }],
        waitingFor: { type: "node", id: "c1" },
      },
    };

    expect(shouldIsolateTaskFocusTurn(state)).toBe(true);
    const turn = buildIsolatedTaskFocusTurn(state);
    expect(turn.isolated).toBe(true);
    expect(turn.taskRunId).toBe("trun_1");
    expect(turn.messages).toHaveLength(1);
    expect(turn.messages[0].role).toBe("user");
    expect(turn.messages[0].content).toMatch(/Isolated TaskFocus turn/);
    expect(turn.messages[0].content).toMatch(/Focus: Implement login/);
    expect(turn.messages[0].content).toMatch(/child_1/);
    expect(turn.messages[0].content).not.toMatch(/prior Agent Loop transcript was huge/);
  });

  test("does not isolate when plan yield requires approval", () => {
    const state = emptyExecutionState();
    state.planGraph = {
      graphId: "plan_appr",
      waitingFor: { id: "t1", type: "task", title: "Needs approval" },
      lastYieldReason: "approval_required",
      nodes: [{ id: "t1", type: "task", status: "waiting_llm" }],
    };
    expect(shouldIsolateTaskFocusTurn(state)).toBe(false);
  });

  test("isolates plan waiting on a task_loop node", () => {
    const state = emptyExecutionState();
    state.planGraph = {
      graphId: "plan_1",
      nodes: [{
        id: "n1",
        type: "task",
        status: "waiting_llm",
        execution: { kind: "task_loop" },
        objective: "Ship feature",
      }],
      waitingFor: { type: "task", id: "n1" },
    };
    expect(shouldIsolateTaskFocusTurn(state)).toBe(true);
    const turn = buildIsolatedTaskFocusTurn(state);
    expect(turn.messages[0].content).toMatch(/Ship feature|n1/);
  });

  test("sanitizeToolResultForModel strips executionState", () => {
    const fat = {
      status: "accepted",
      ok: true,
      summary: "ok",
      executionState: { planGraph: { nodes: new Array(100).fill({ id: "x" }) } },
      modelPayload: {
        status: "accepted",
        executionState: { huge: true },
        readyNodes: ["a"],
      },
      compile: { ignored: true },
      taskLoopResume: { ignored: true },
    };
    const clean = sanitizeToolResultForModel(fat);
    expect(clean.executionState).toBeUndefined();
    expect(clean.compile).toBeUndefined();
    expect(clean.taskLoopResume).toBeUndefined();
    expect(clean.summary).toBe("ok");
    expect(clean.modelPayload.executionState).toBeUndefined();
    expect(clean.modelPayload.readyNodes).toEqual(["a"]);
    expect(JSON.stringify(clean).length).toBeLessThan(JSON.stringify(fat).length);
  });
});

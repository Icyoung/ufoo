"use strict";

const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const {
  createTaskRun,
  putTaskRun,
  casTaskRunStatus,
  beginWakeup,
  completeWakeup,
  recoverTaskRunsAfterRestart,
  getTaskRun,
} = require("../../../src/code/runtime/taskRun");
const {
  acquireTaskWriteLease,
  releaseStaleWriteLeases,
  listWriteLeaseHolders,
} = require("../../../src/code/runtime/workspaceLease");
const { cancelTask } = require("../../../src/code/runtime/taskControl");
const { runPlanGraphCommand } = require("../../../src/code/context/planGraphService");
const { startTask } = require("../../../src/code/runtime/taskControl");

describe("TaskRun R6 recovery and idempotency", () => {
  test("cas forbids reverse transitions and terminal overwrite", () => {
    const state = emptyExecutionState();
    const run = createTaskRun({ parentNodeId: "n1" });
    putTaskRun(state, run);
    expect(casTaskRunStatus(state, run.id, {
      expectedStatus: "queued",
      nextStatus: "running",
    }).ok).toBe(true);
    expect(casTaskRunStatus(state, run.id, {
      expectedStatus: "running",
      nextStatus: "succeeded",
    }).ok).toBe(true);
    expect(casTaskRunStatus(state, run.id, {
      expectedStatus: "succeeded",
      nextStatus: "running",
    }).code).toBe("TASK_ALREADY_TERMINAL");
  });

  test("duplicate wakeup id does not re-run work", () => {
    const state = emptyExecutionState();
    const first = beginWakeup(state, "wake-1", { taskRunId: "t1" });
    expect(first.fresh).toBe(true);
    completeWakeup(state, "wake-1", { ok: true, tools: 1 });
    const second = beginWakeup(state, "wake-1");
    expect(second.idempotentReplay).toBe(true);
    expect(second.result).toMatchObject({ ok: true, tools: 1 });
  });

  test("recoverTaskRunsAfterRestart requeues interrupted running runs", () => {
    const state = emptyExecutionState();
    const run = createTaskRun({ parentNodeId: "n1" });
    putTaskRun(state, run);
    casTaskRunStatus(state, run.id, {
      expectedStatus: "queued",
      nextStatus: "running",
      phase: "executing_tools",
    });
    const recovered = recoverTaskRunsAfterRestart(state);
    expect(recovered.some((r) => r.action === "requeued")).toBe(true);
    expect(getTaskRun(state, run.id).status).toBe("queued");
  });

  test("stale lease released when task is terminal", () => {
    const state = emptyExecutionState();
    const run = createTaskRun({ parentNodeId: "n1" });
    putTaskRun(state, run);
    acquireTaskWriteLease(state, run.id);
    expect(listWriteLeaseHolders(state)).toHaveLength(1);
    casTaskRunStatus(state, run.id, {
      expectedStatus: "queued",
      nextStatus: "running",
    });
    casTaskRunStatus(state, run.id, {
      expectedStatus: "running",
      nextStatus: "succeeded",
    });
    const out = releaseStaleWriteLeases(state, { maxAgeMs: 0 });
    expect(out.released.some((r) => r.taskRunId === run.id)).toBe(true);
    expect(listWriteLeaseHolders(state)).toHaveLength(0);
  });

  test("duplicate cancel command is idempotent", () => {
    const executionState = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "x",
        nodes: [{
          id: "impl",
          type: "task",
          title: "Implement",
          execution: { kind: "task_loop" },
        }],
      },
    }, { executionState, autoAdvance: false });
    const started = startTask(executionState, {
      nodeId: "impl",
      commandId: "start-1",
      processImmediately: false,
    });
    const first = cancelTask(executionState, {
      nodeId: "impl",
      taskRunId: started.taskRunId,
      commandId: "cancel-1",
    });
    const second = cancelTask(executionState, {
      nodeId: "impl",
      taskRunId: started.taskRunId,
      commandId: "cancel-1",
    });
    expect(second.idempotentReplay).toBe(true);
    expect(second.taskRunId || second.status).toBeTruthy();
    expect(first.status || first.ok).toBeTruthy();
  });
});

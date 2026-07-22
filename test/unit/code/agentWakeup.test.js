"use strict";

const {
  hasPendingAgentMailbox,
  listTaskRunsAwaitingModel,
  shouldAutoContinueForTaskWake,
  buildTaskRunWakeReminder,
  drainAgentMailboxForTurn,
} = require("../../../src/code/runtime/agentWakeup");
const { enqueueAgentRuntime } = require("../../../src/code/runtime/loopMailbox");
const { createRuntimeEvent } = require("../../../src/code/runtime/runtimeEvents");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");

describe("agentWakeup", () => {
  test("detects pending mailbox and awaiting TaskRuns", () => {
    const state = emptyExecutionState();
    expect(hasPendingAgentMailbox(state)).toBe(false);
    expect(shouldAutoContinueForTaskWake(state)).toBe(false);

    enqueueAgentRuntime(state, createRuntimeEvent("task_started", {
      taskId: "t1",
      taskRunId: "trun_1",
    }));
    expect(hasPendingAgentMailbox(state)).toBe(true);
    expect(shouldAutoContinueForTaskWake(state)).toBe(true);

    drainAgentMailboxForTurn(state);
    expect(hasPendingAgentMailbox(state)).toBe(false);

    state.taskRuns = {
      byId: {
        trun_1: {
          id: "trun_1",
          status: "running",
          phase: "waiting_model",
          objective: "Work",
        },
      },
    };
    expect(listTaskRunsAwaitingModel(state)).toHaveLength(1);
    expect(shouldAutoContinueForTaskWake(state)).toBe(true);
    expect(buildTaskRunWakeReminder(state)).toMatch(/trun_1/);
    expect(buildTaskRunWakeReminder(state)).toMatch(/Runtime wake/);
  });

  test("does not wake when pending user interaction", () => {
    const state = emptyExecutionState();
    state.pendingUserInteraction = { id: "ui_1" };
    state.taskRuns = {
      byId: {
        trun_1: { id: "trun_1", status: "running", phase: "waiting_model" },
      },
    };
    expect(shouldAutoContinueForTaskWake(state)).toBe(false);
  });
});

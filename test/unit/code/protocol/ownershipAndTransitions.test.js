"use strict";

const {
  STATE_OWNERSHIP,
  DURABLE_FIELDS,
  PROJECTION_FIELDS,
  getOwnershipRow,
  assertOwnershipTableInvariants,
} = require("../../../../src/code/protocol/ownership");
const {
  TASK_RUN_TRANSITIONS,
  PLAN_MODE_FACTS,
  FUTURE_POLICY_OWNER,
  isAllowedTaskRunTransition,
  assertTransitionTables,
} = require("../../../../src/code/protocol/transitions");
const {
  FAULT_POINTS,
  FaultInjectedError,
  armFault,
  disarmFault,
  withFaultPoint,
  isFaultArmed,
} = require("../../../../src/code/protocol/faultHarness");
const { TASK_RUN_STATUSES } = require("../../../../src/code/runtime/taskRun");

describe("ownership table", () => {
  test("invariants hold and key fields are present", () => {
    expect(assertOwnershipTableInvariants()).toBe(true);
    expect(DURABLE_FIELDS).toContain("executionState");
    expect(DURABLE_FIELDS).toContain("transcript.events");
    expect(PROJECTION_FIELDS).toContain("uiLogs");
    expect(getOwnershipRow("providerMessages").rebuildable).toBe(true);
    expect(STATE_OWNERSHIP.length).toBeGreaterThanOrEqual(8);
    const {
      ATOMIC_COMMIT_BOUNDARIES,
      SIDE_EFFECT_INVOCATION_PHASES,
    } = require("../../../../src/code/protocol/ownership");
    expect(ATOMIC_COMMIT_BOUNDARIES.length).toBeGreaterThanOrEqual(5);
    expect(SIDE_EFFECT_INVOCATION_PHASES).toContain("result_committed");
  });
});

describe("transition tables", () => {
  test("task run edges cover all statuses and block terminal outbound", () => {
    expect(assertTransitionTables()).toBe(true);
    for (const status of TASK_RUN_STATUSES) {
      expect(TASK_RUN_TRANSITIONS[status]).toBeDefined();
    }
    expect(isAllowedTaskRunTransition("queued", "running")).toBe(true);
    expect(isAllowedTaskRunTransition("running", "cancelling")).toBe(true);
    expect(isAllowedTaskRunTransition("succeeded", "running")).toBe(false);
  });

  test("plan mode facts document orthogonality with TaskRun", () => {
    expect(PLAN_MODE_FACTS.exitCancelsTaskRun).toBe(false);
    expect(PLAN_MODE_FACTS.taskRunSurvivesPlanOff).toBe(true);
    expect(FUTURE_POLICY_OWNER.mapPlanModeOn.planningPolicy).toBe("graph_required");
    expect(FUTURE_POLICY_OWNER.mapPlanModeOff.planningPolicy).toBe("direct_allowed");
  });
});

describe("faultHarness", () => {
  afterEach(() => {
    disarmFault();
  });

  test("armed point throws once then clears", async () => {
    expect(FAULT_POINTS).toContain("after_prepare_tool_calls");
    expect(FAULT_POINTS).toContain("before_provider_resume");
    armFault("after_prepare_tool_calls");
    expect(isFaultArmed("after_prepare_tool_calls")).toBe(true);
    await expect(withFaultPoint("after_prepare_tool_calls", async () => "ok"))
      .rejects.toBeInstanceOf(FaultInjectedError);
    expect(isFaultArmed("after_prepare_tool_calls")).toBe(false);
    await expect(withFaultPoint("after_prepare_tool_calls", async () => "ok"))
      .resolves.toBe("ok");
  });
});

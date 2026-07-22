"use strict";

const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const { runPlanGraphCommand } = require("../../../src/code/context/planGraphService");
const {
  startTask,
  cancelTask,
  failTask,
  completeTaskFromLoop,
} = require("../../../src/code/runtime/taskControl");
const {
  drainAgentMailbox,
  enqueueAgentUser,
} = require("../../../src/code/runtime/loopMailbox");
const {
  getTaskRun,
  listActiveWritingTaskRuns,
} = require("../../../src/code/runtime/taskRun");
const {
  checkWriteAllowed,
  hasActiveWriteLease,
} = require("../../../src/code/runtime/workspaceLease");
const {
  buildTaskFocus,
  listParallelSiblings,
} = require("../../../src/code/runtime/taskFocus");

function createParentWithTasks(executionState, nodes) {
  return runPlanGraphCommand({
    operation: "create",
    graph: {
      objective: "parent flow",
      nodes,
    },
  }, { executionState, autoAdvance: false });
}

describe("Nested Plan Graph V1 — TaskLoop / Agent Loop", () => {
  test("start_task persists TaskRun and returns immediately; idempotent commandId", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        objective: "Fix cancel leak",
        execution: { kind: "task_loop" },
      },
    ]);

    const first = startTask(executionState, {
      nodeId: "impl",
      commandId: "cmd-1",
      processImmediately: true,
    });
    expect(first.status).toBe("started");
    expect(first.taskRunId).toBeTruthy();
    expect(first.childGraphId).toBeTruthy();

    const run = getTaskRun(executionState, first.taskRunId);
    expect(run).toBeTruthy();
    expect(["queued", "running"]).toContain(run.status);

    const replay = startTask(executionState, {
      nodeId: "impl",
      commandId: "cmd-1",
      processImmediately: true,
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.taskRunId).toBe(first.taskRunId);

    const again = startTask(executionState, {
      nodeId: "impl",
      commandId: "cmd-2",
    });
    expect(again.status).toBe("already_running");
    expect(again.taskRunId).toBe(first.taskRunId);
  });

  test("dependsOn unsatisfied rejects start_task", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "diagnose",
        type: "task",
        title: "Diagnose",
        execution: { kind: "task_loop" },
      },
      {
        id: "fix",
        type: "task",
        title: "Fix",
        dependsOn: ["diagnose"],
        execution: { kind: "task_loop" },
      },
    ]);

    const result = startTask(executionState, { nodeId: "fix" });
    expect(result.status).toBe("rejected");
    expect(result.errors[0].code).toBe("DEPENDENCIES_NOT_SATISFIED");
  });

  test("user nudge stays in agent mailbox; task ignores user events", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    startTask(executionState, { nodeId: "impl", commandId: "s1" });
    enqueueAgentUser(executionState, "please hurry");
    const drained = drainAgentMailbox(executionState);
    expect(drained.some((e) => e.kind === "user" && e.text.includes("hurry"))).toBe(true);
    // Task mailboxes must not contain user kinds
    const taskMail = executionState.taskMailboxes || {};
    for (const box of Object.values(taskMail)) {
      const kinds = (box.queue || []).map((e) => e.kind);
      expect(kinds.includes("user")).toBe(false);
    }
  });

  test("complete_task succeeds and wakes agent with runtime event", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    const started = startTask(executionState, { nodeId: "impl", commandId: "c1" });
    drainAgentMailbox(executionState); // clear started event

    const done = completeTaskFromLoop(executionState, {
      taskRunId: started.taskRunId,
      result: {
        summary: "fixed",
        changedFiles: ["src/a.js"],
      },
      commandId: "complete-1",
    });
    expect(done.ok).toBe(true);
    expect(done.parentNodeStatus).toBe("succeeded");

    const events = drainAgentMailbox(executionState);
    expect(events.some((e) => e.kind === "runtime" && e.event && e.event.type === "task_succeeded")).toBe(true);

    const node = executionState.planGraph.nodes.find((n) => n.id === "impl");
    expect(node.status).toBe("succeeded");
    expect(hasActiveWriteLease(executionState)).toBe(false);
  });

  test("cancel_task vs already succeeded CAS", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    const started = startTask(executionState, { nodeId: "impl" });
    completeTaskFromLoop(executionState, {
      taskRunId: started.taskRunId,
      result: { summary: "done" },
    });
    const cancelled = cancelTask(executionState, {
      nodeId: "impl",
      reason: "too late",
    });
    expect(cancelled.status).toBe("rejected");
    expect(cancelled.errors[0].code).toBe("TASK_ALREADY_TERMINAL");
  });

  test("workspace lease allows up to 6 concurrent writing tasks", () => {
    const executionState = emptyExecutionState();
    const nodes = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i + 1}`,
      type: "task",
      title: `T${i + 1}`,
      execution: { kind: "task_loop" },
    }));
    createParentWithTasks(executionState, nodes);

    for (let i = 1; i <= 6; i += 1) {
      const started = startTask(executionState, { nodeId: `t${i}` });
      expect(started.status).toBe("started");
    }
    expect(hasActiveWriteLease(executionState)).toBe(true);
    expect(listActiveWritingTaskRuns(executionState).length).toBe(6);

    const seventh = startTask(executionState, { nodeId: "t7" });
    expect(seventh.status).toBe("rejected");
    expect(seventh.errors[0].code).toBe("MAX_CONCURRENT_TASKS");
    expect(seventh.errors[0].max).toBe(6);

    const agentWrite = checkWriteAllowed(executionState, {
      tool: "write",
      originKind: "agent_loop",
    });
    expect(agentWrite.ok).toBe(false);
    expect(agentWrite.code).toBe("WORKSPACE_WRITE_LEASE_HELD");

    // Completing one frees a slot.
    const firstRunId = listActiveWritingTaskRuns(executionState)[0].id;
    completeTaskFromLoop(executionState, {
      taskRunId: firstRunId,
      result: { summary: "done" },
    });
    const retry = startTask(executionState, { nodeId: "t7" });
    expect(retry.status).toBe("started");
  });

  test("legacy single holder lease migrates to holders[]", () => {
    const {
      ensureWorkspaceLease,
      countWriteLeases,
      checkWriteAllowed: check,
    } = require("../../../src/code/runtime/workspaceLease");
    const executionState = emptyExecutionState();
    executionState.workspaceLease = {
      holder: { kind: "task_run", taskRunId: "trun_legacy" },
      mode: "write",
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
    ensureWorkspaceLease(executionState);
    expect(countWriteLeases(executionState)).toBe(1);
    expect(executionState.workspaceLease.holders[0].taskRunId).toBe("trun_legacy");
    expect(check(executionState, { tool: "edit", originKind: "agent_loop" }).ok).toBe(false);
  });

  test("parallel siblings listed for focus", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "a",
        type: "task",
        title: "A",
        objective: "do A",
        execution: { kind: "task_loop" },
      },
      {
        id: "b",
        type: "task",
        title: "B",
        objective: "do B",
        execution: { kind: "task_loop" },
      },
    ]);
    const siblings = listParallelSiblings(executionState.planGraph.nodes, "a");
    expect(siblings.map((s) => s.id)).toContain("b");

    startTask(executionState, { nodeId: "a" });
    const aRun = Object.values(executionState.taskRuns.byId).find((r) => r.parentNodeId === "a");
    completeTaskFromLoop(executionState, {
      taskRunId: aRun.id,
      result: { summary: "A done", changedFiles: ["a.ts"] },
    });
    const focus = buildTaskFocus({
      nodes: executionState.planGraph.nodes,
      currentNodeId: "b",
      taskRunsById: executionState.taskRuns.byId,
    });
    expect(focus.parallelSiblings.some((s) => s.id === "a" && s.status === "succeeded")).toBe(true);
    expect(getTaskRun(executionState, aRun.id).changedFiles).toContain("a.ts");
  });

  test("plan_graph control operation wires start_task", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    const result = runPlanGraphCommand({
      operation: "control",
      commandId: "ctrl-1",
      actions: [{ op: "start_task", nodeId: "impl" }],
    }, { executionState, autoAdvance: false });
    expect(result.status).toBe("accepted");
    expect(result.control.results[0].taskRunId).toBeTruthy();
  });

  test("fail_task stops running task", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    startTask(executionState, { nodeId: "impl" });
    const failed = failTask(executionState, {
      nodeId: "impl",
      reason: "impossible",
    });
    expect(failed.ok).toBe(true);
    const node = executionState.planGraph.nodes.find((n) => n.id === "impl");
    expect(["failed", "cancelled"]).toContain(node.status);
    expect(hasActiveWriteLease(executionState)).toBe(false);
  });

  test("tool provenance fills changedFiles on complete", () => {
    const { recordToolProvenance } = require("../../../src/code/runtime/toolProvenance");
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    const started = startTask(executionState, { nodeId: "impl" });
    recordToolProvenance(executionState, {
      taskRunId: started.taskRunId,
      tool: "write",
      args: { path: "src/foo.js" },
    });
    recordToolProvenance(executionState, {
      taskRunId: started.taskRunId,
      tool: "edit",
      args: { path: "src/bar.js" },
    });
    const done = completeTaskFromLoop(executionState, {
      taskRunId: started.taskRunId,
      result: { summary: "wrote files" },
    });
    expect(done.ok).toBe(true);
    const run = getTaskRun(executionState, started.taskRunId);
    expect(run.changedFiles).toEqual(expect.arrayContaining(["src/foo.js", "src/bar.js"]));
  });

  test("resumePersistedTaskRuns continues queued runs after restore", () => {
    const { resumePersistedTaskRuns } = require("../../../src/code/runtime/taskLoop");
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    const started = startTask(executionState, {
      nodeId: "impl",
      processImmediately: false,
    });
    expect(getTaskRun(executionState, started.taskRunId).status).toBe("queued");
    // Simulate restore: same executionState object
    const ticks = resumePersistedTaskRuns(executionState, {});
    expect(ticks.results.length).toBe(1);
    expect(ticks.results[0].ok).toBe(true);
    expect(["running", "queued"]).toContain(getTaskRun(executionState, started.taskRunId).status);
  });

  test("child graph rejects nested task_loop add_node", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    const started = startTask(executionState, { nodeId: "impl" });
    const child = executionState.graphs[started.childGraphId];
    expect(child.owner.kind).toBe("task_loop");
    const previous = executionState.planGraph;
    executionState.planGraph = child;
    const patched = runPlanGraphCommand({
      operation: "patch",
      operations: [{
        op: "add_node",
        node: {
          id: "nested",
          type: "task",
          title: "nested",
          execution: { kind: "task_loop" },
        },
      }],
    }, { executionState, autoAdvance: false });
    executionState.planGraph = previous;
    expect(patched.status).toBe("rejected");
    expect(patched.errors[0].code).toBe("NESTED_TASK_LOOP_NOT_SUPPORTED");
  });

  test("running task_loop spec is frozen against expand_node", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    startTask(executionState, { nodeId: "impl" });
    const patched = runPlanGraphCommand({
      operation: "patch",
      operations: [{
        op: "expand_node",
        nodeId: "impl",
        children: [{ id: "t1", type: "tool", tool: "read", args: { path: "a" } }],
      }],
    }, { executionState, autoAdvance: false });
    expect(patched.status).toBe("rejected");
    expect(patched.errors[0].code).toBe("RUNNING_TASK_SPEC_FROZEN");
  });

  test("agent wakeup formats runtime events without user role", () => {
    const { drainAgentMailboxForTurn } = require("../../../src/code/runtime/agentWakeup");
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
      },
    ]);
    const started = startTask(executionState, { nodeId: "impl" });
    completeTaskFromLoop(executionState, {
      taskRunId: started.taskRunId,
      result: { summary: "ok" },
    });
    const { text, events } = drainAgentMailboxForTurn(executionState);
    expect(events.some((e) => e.kind === "runtime")).toBe(true);
    expect(text).toMatch(/Runtime events/);
    expect(text).toMatch(/task_succeeded/);
    expect(text).not.toMatch(/^user:/m);
  });

  test("standalone TaskRun starts without plan graph or Plan Mode", () => {
    const { startStandaloneTask } = require("../../../src/code/runtime/taskControl");
    const { runTaskRunTool } = require("../../../src/code/tools/taskRun");
    const executionState = emptyExecutionState();
    executionState.planMode = false;

    const started = startStandaloneTask(executionState, {
      objective: "Ship topology delivery scripts",
      title: "Delivery scripts",
      commandId: "solo-1",
      processImmediately: true,
    });
    expect(started.status).toBe("started");
    expect(started.ok).toBe(true);
    expect(started.kind).toBe("standalone");
    expect(started.nodeId).toBe("");
    expect(started.graphId).toBe("");
    expect(started.taskRunId).toBeTruthy();
    expect(executionState.planMode).toBe(false);
    expect(executionState.planGraph && executionState.planGraph.graphId).toBeFalsy();

    const run = getTaskRun(executionState, started.taskRunId);
    expect(run).toBeTruthy();
    expect(run.kind).toBe("standalone");
    expect(run.parentNodeId).toBe("");
    expect(run.parentGraphId).toBe("");
    expect(run.objective).toBe("Ship topology delivery scripts");
    expect(["queued", "running"]).toContain(run.status);

    const replay = startStandaloneTask(executionState, {
      objective: "Ship topology delivery scripts",
      commandId: "solo-1",
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.taskRunId).toBe(started.taskRunId);

    const cancelled = cancelTask(executionState, {
      taskRunId: started.taskRunId,
      reason: "stop",
      commandId: "solo-cancel",
    });
    expect(cancelled.ok).toBe(true);
    expect(getTaskRun(executionState, started.taskRunId).status).toBe("cancelled");

    const viaTool = runTaskRunTool({
      operation: "start",
      objective: "Second standalone track",
      commandId: "tool-start-1",
    }, { executionState, processImmediately: true });
    expect(viaTool.ok).toBe(true);
    expect(viaTool.kind).toBe("standalone");
    expect(executionState.planMode).toBe(false);
  });

  test("patch expand_node on childGraphId advances TaskLoop without GRAPH_ID_MISMATCH", () => {
    const executionState = emptyExecutionState();
    createParentWithTasks(executionState, [
      {
        id: "impl",
        type: "task",
        title: "Implement",
        execution: { kind: "task_loop" },
        objective: "Implement feature",
      },
    ]);
    const stubTool = ({ stepId, tool }) => ({
      ok: true,
      summary: "ok",
      output: { stepId, tool },
    });
    const started = startTask(executionState, {
      nodeId: "impl",
      commandId: "start-child-1",
      processImmediately: true,
      runTool: stubTool,
    });
    expect(started.ok).toBe(true);
    expect(started.childGraphId).toBeTruthy();

    const run = getTaskRun(executionState, started.taskRunId);
    expect(["waiting_model", "planning"]).toContain(run.phase);
    const child = executionState.graphs[started.childGraphId];
    expect(child).toBeTruthy();
    expect((child.nodes || []).some((n) => n.id === "root")).toBe(true);
    const parentIdBefore = executionState.planGraph.graphId;

    // Before the fix, patching with childGraphId returned GRAPH_ID_MISMATCH.
    const mismatch = runPlanGraphCommand({
      operation: "patch",
      graphId: started.childGraphId,
      commandId: "expand-child-root-probe",
      operations: [],
    }, { executionState, autoAdvance: false });
    expect(mismatch.status).toBe("accepted");
    expect(mismatch.errors || []).toEqual([]);
    expect(executionState.planGraph.graphId).toBe(parentIdBefore);

    const calls = [];
    const patched = runPlanGraphCommand({
      operation: "patch",
      graphId: started.childGraphId,
      commandId: "expand-child-root",
      operations: [{
        op: "expand_node",
        nodeId: "root",
        children: [
          { id: "read_a", type: "tool", tool: "read", args: { path: "a.txt" } },
        ],
      }],
    }, {
      executionState,
      autoAdvance: true,
      runTool: ({ stepId, tool }) => {
        calls.push({ stepId, tool });
        return stubTool({ stepId, tool });
      },
    });

    expect(patched.status).toBe("accepted");
    expect(patched.graphId).toBe(started.childGraphId);
    expect(calls.some((c) => c.stepId === "read_a")).toBe(true);
    // Parent remains the active planGraph for the Agent Loop.
    expect(executionState.planGraph.graphId).toBe(parentIdBefore);
    expect(executionState.graphs[started.childGraphId]).toBeTruthy();
  });
});

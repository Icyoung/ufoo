"use strict";

const {
  normalizePlanGraphCommand,
  runPlanGraphCommand,
  emptyPlanGraphState,
  activePlanRequiresExpansion,
  projectPlanView,
} = require("../../../src/code/context/planGraphService");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const { runToolCall, TOOL_NAMES } = require("../../../src/code/dispatch");
const { runPlanGraphTool } = require("../../../src/code/tools/planGraph");
const { buildImmutablePrefix } = require("../../../src/code/context/promptLayers");
const { parseStructuredSideEffects } = require("../../../src/code/context/stateCommit");
const {
  applyPlanOperations,
  compilePlanGraph,
} = require("../../../src/code/context/planGraph");

describe("plan_graph control-plane tool", () => {
  test("TOOL_NAMES includes plan_graph without plan_mode tool", () => {
    expect(TOOL_NAMES).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "artifact_read",
      "plan_graph",
      "ask_user",
    ]);
  });

  test("immutable prompt treats Plan Mode as runtime posture, not an agent tool", () => {
    const text = buildImmutablePrefix();
    expect(text).toContain("plan_graph");
    expect(text).toMatch(/Plan Mode is a runtime posture for the Agent Loop/i);
    expect(text).toMatch(/operation=create automatically enables Plan Mode/i);
    expect(text).toContain("Do not call plan_graph together with read, write, edit, bash, or artifact_read");
    expect(text).toMatch(/cancel_graph/i);
    expect(text).not.toContain("create/patch/inspect/control/cancel.");
    expect(text).not.toContain("create/patch/inspect/control/cancel)");
    expect(text).not.toContain("create/patch/inspect/control/cancel,");
    expect(text).toContain("create, patch, inspect, cancel_graph, and control");
    expect(text).toMatch(/control\.start_task for execution\.kind=task_loop/i);
    expect(text).toMatch(/Treat a User reminder as the latest user instruction/i);
    expect(text).toMatch(/Turning Plan Mode off does not cancel/i);
    expect(text).toMatch(/Runtime enforces TaskRun concurrency limits/i);
    expect(text).not.toMatch(/Up to 6 writing TaskRuns/);
    expect(text).toMatch(/ask_user is available only to the Agent Loop/i);
    expect(text).not.toContain("Use plan_mode to enter/exit");
    expect(text).not.toContain("enter_plan_mode");
    expect(text).not.toContain('"type":"execution_segment"');
    expect(text).not.toContain("Plan patch ops:");
  });

  test("tool schemas use layered descriptions for the three control-plane tools", () => {
    const { buildCoreToolSpecs } = require("../../../src/code/nativeRunner");
    const specs = buildCoreToolSpecs();
    const byName = Object.fromEntries(
      specs.map((s) => [s.function.name, s.function]),
    );

    expect(byName.artifact_read.description).toMatch(/does not read workspace files/i);
    expect(byName.artifact_read.description).toMatch(/use `read` for repository paths/i);

    expect(byName.plan_graph.description).toMatch(/control\.start_task/i);
    expect(byName.plan_graph.description).not.toMatch(/Patch ops:/);
    expect(byName.plan_graph.parameters.properties.operations.description).toMatch(/add_node/);
    expect(byName.plan_graph.parameters.properties.operations.description).toMatch(/control\.actions/);
    expect(byName.plan_graph.parameters.properties.actions.description).toMatch(/complete_task/);

    expect(byName.ask_user.description).toMatch(/pause the current Agent loop/i);
    expect(byName.ask_user.description).toMatch(/Running TaskRuns are not paused/i);
    expect(byName.ask_user.description).toMatch(/only as this tool result/i);
  });

  test("legacy side effects only accept explicit execution_segment", () => {
    expect(normalizePlanGraphCommand({
      type: "execution_segment",
      objective: "probe",
      steps: [{ id: "s1", tool: "read", args: { path: "a.txt" } }],
      checkpoint: { after: ["s1"] },
    }).operation).toBe("create");

    expect(normalizePlanGraphCommand({
      operations: [{ op: "add_node", node: { id: "x", type: "task", title: "t" } }],
    })).toBeNull();

    expect(normalizePlanGraphCommand({
      type: "group",
      strategy: "parallel",
      children: [{ id: "a", type: "tool", tool: "bash", args: { command: "echo 1" } }],
    })).toBeNull();
  });

  test("parser no longer treats bare graph JSON as side effect", () => {
    const parsed = parseStructuredSideEffects(JSON.stringify({
      graph: {
        objective: "fix",
        nodes: [{ id: "inspect", type: "task", title: "locate" }],
      },
    }));
    expect(parsed).toBeNull();
  });

  test("expand_node keeps task id as aggregate join", () => {
    const executionState = emptyExecutionState();
    const calls = [];

    const created = runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "fix cancel",
        nodes: [
          { id: "inspect", type: "task", title: "locate code" },
          { id: "diagnose", type: "task", title: "find cause", dependsOn: ["inspect"] },
        ],
      },
    }, { executionState, autoAdvance: true, runTool: () => ({ ok: true }) });

    expect(created.status).toBe("accepted");
    expect(created.advance.yieldReason).toBe("task_ready");
    expect(created.waitingFor && created.waitingFor.id).toBe("inspect");
    expect(activePlanRequiresExpansion(executionState.planGraph)).toBe(true);

    const patched = runPlanGraphCommand({
      operation: "patch",
      commandId: "expand-inspect-1",
      expectedSpecRevision: created.commandRevision,
      operations: [{
        op: "expand_node",
        nodeId: "inspect",
        children: [
          { id: "search_cancel", type: "tool", tool: "bash", args: { command: "rg cancel" } },
          { id: "read_tests", type: "tool", tool: "read", args: { path: "tests/cancel.rs" } },
        ],
      }],
    }, {
      executionState,
      autoAdvance: true,
      parallel: true,
      runTool: ({ stepId, tool }) => {
        calls.push({ stepId, tool });
        return {
          ok: true,
          artifactId: `artifact_${stepId}`,
          output: { stepId, tool },
          summary: `${stepId} ok`,
        };
      },
    });

    expect(patched.status).toBe("accepted");
    expect(calls.map((c) => c.stepId).sort()).toEqual(["read_tests", "search_cancel"]);
    expect(patched.advance.yieldReason).toBe("task_ready");
    expect(patched.waitingFor && patched.waitingFor.id).toBe("diagnose");

    const inspect = executionState.planGraph.nodes.find((n) => n.id === "inspect");
    expect(inspect.execution).toEqual({ kind: "aggregate" });
    expect(inspect.status).toBe("succeeded");
    expect(inspect.dependsOn.sort()).toEqual(["read_tests", "search_cancel"]);

    const diagnose = executionState.planGraph.nodes.find((n) => n.id === "diagnose");
    expect(diagnose.dependsOn).toEqual(["inspect"]);

    const search = executionState.planGraph.nodes.find((n) => n.id === "search_cancel");
    expect(search.parentTaskId).toBe("inspect");
    expect(search.status).toBe("succeeded");

    const view = projectPlanView(executionState.planGraph);
    const inspectView = view.find((n) => n.id === "inspect");
    expect(inspectView.children.sort()).toEqual(["read_tests", "search_cancel"]);
  });

  test("commandId replay is idempotent", () => {
    const executionState = emptyExecutionState();
    const first = runPlanGraphCommand({
      operation: "create",
      commandId: "cmd-create-1",
      graph: {
        nodes: [{ id: "t1", type: "task", title: "one" }],
      },
    }, { executionState, autoAdvance: false });
    const second = runPlanGraphCommand({
      operation: "create",
      commandId: "cmd-create-1",
      graph: {
        nodes: [{ id: "t2", type: "task", title: "two" }],
      },
    }, { executionState, autoAdvance: false });
    expect(second.idempotentReplay).toBe(true);
    expect(second.commandRevision).toBe(first.commandRevision);
    expect(executionState.planGraph.nodes.map((n) => n.id)).toEqual(["t1"]);
  });

  test("expectedSpecRevision mismatch rejects patch", () => {
    const executionState = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: { nodes: [{ id: "t1", type: "task", title: "one" }] },
    }, { executionState, autoAdvance: false });
    const rejected = runPlanGraphCommand({
      operation: "patch",
      expectedSpecRevision: 999,
      operations: [{ op: "add_node", node: { id: "t2", type: "task", title: "two" } }],
    }, { executionState, autoAdvance: false });
    expect(rejected.status).toBe("rejected");
    expect(rejected.errors[0].code).toBe("SPEC_REVISION_MISMATCH");
  });

  test("set_status is rejected; control.complete_task works for waiting_llm", () => {
    const executionState = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: { nodes: [{ id: "t1", type: "task", title: "one" }] },
    }, { executionState, autoAdvance: true, runTool: () => ({ ok: true }) });

    const bad = runPlanGraphCommand({
      operation: "patch",
      operations: [{ op: "set_status", nodeId: "t1", status: "succeeded" }],
    }, { executionState, autoAdvance: false });
    expect(bad.status).toBe("rejected");

    const patchComplete = runPlanGraphCommand({
      operation: "patch",
      operations: [{
        op: "complete_task",
        nodeId: "t1",
        summary: "done",
        output: { ok: true },
      }],
    }, { executionState, autoAdvance: false });
    expect(patchComplete.status).toBe("rejected");
    expect(String(patchComplete.errors[0].message || "")).toMatch(/control/i);

    const done = runPlanGraphCommand({
      operation: "control",
      actions: [{
        op: "complete_task",
        nodeId: "t1",
        summary: "done",
        output: { ok: true },
      }],
    }, { executionState, autoAdvance: false });
    expect(done.status).toBe("accepted");
    expect(executionState.planGraph.nodes.find((n) => n.id === "t1").status).toBe("succeeded");
  });

  test("rejects unknown output references with structured errors", () => {
    const executionState = emptyExecutionState();
    const result = runPlanGraphCommand({
      operation: "create",
      graph: {
        nodes: [
          {
            id: "read",
            type: "tool",
            tool: "read",
            args: { path: "${missing.output.path}" },
          },
        ],
      },
    }, { executionState, autoAdvance: false });

    expect(result.status).toBe("rejected");
    expect(result.errors[0].code).toBe("UNKNOWN_OUTPUT_REFERENCE");
  });

  test("inspect and cancel_graph work", () => {
    const executionState = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: {
        nodes: [{ id: "t1", type: "task", title: "one" }],
      },
    }, { executionState, autoAdvance: false });

    const inspected = runPlanGraphTool({ operation: "inspect" }, { executionState, autoAdvance: false });
    expect(inspected.status).toBe("accepted");
    expect(inspected.nodes[0].id).toBe("t1");
    expect(inspected.commandRevision).toBe(1);

    const cleared = runPlanGraphTool({ operation: "cancel_graph" }, { executionState });
    expect(cleared.status).toBe("accepted");
    expect(executionState.planGraph.nodes).toEqual([]);
  });

  test("dispatch runToolCall supports plan_graph", () => {
    const executionState = emptyExecutionState();
    const result = runToolCall({
      tool: "plan_graph",
      args: {
        operation: "create",
        graph: {
          nodes: [{ id: "t1", type: "task", title: "demo" }],
        },
      },
    }, { executionState, autoAdvance: false });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("accepted");
    expect(result.graphId).toBeTruthy();
  });

  test("emptyPlanGraphState shape", () => {
    expect(emptyPlanGraphState()).toEqual({
      graphId: "",
      specRevision: 0,
      stateRevision: 0,
      revision: 0,
      objective: "",
      failurePolicy: "continue_independent",
      nodes: [],
      outputs: {},
      waitingFor: null,
      lastStoppedAt: "",
      lastYieldReason: "",
      commandLog: {},
    });
  });

  test("applyPlanOperations expand keeps downstream dependsOn inspect", () => {
    const plan = {
      id: "p1",
      objective: "",
      nodes: [
        { id: "inspect", type: "task", title: "locate", status: "waiting_llm" },
        { id: "diagnose", type: "task", title: "cause", dependsOn: ["inspect"], status: "pending" },
      ],
    };
    const next = applyPlanOperations(plan, [{
      op: "expand_node",
      nodeId: "inspect",
      children: [
        { id: "search_code", type: "tool", tool: "bash", args: { command: "rg cancel" } },
        { id: "inspect_git", type: "tool", tool: "bash", args: { command: "git diff" } },
      ],
    }]);
    expect(next.errors || []).toEqual([]);
    const compiled = compilePlanGraph(next);
    expect(compiled.ok).toBe(true);
    expect(compiled.nodes.map((n) => n.id).sort()).toEqual([
      "diagnose",
      "inspect",
      "inspect_git",
      "search_code",
    ]);
    const inspect = compiled.nodes.find((n) => n.id === "inspect");
    expect(inspect.execution).toEqual({ kind: "aggregate" });
    expect(inspect.dependsOn.sort()).toEqual(["inspect_git", "search_code"]);
    const diagnose = compiled.nodes.find((n) => n.id === "diagnose");
    expect(diagnose.dependsOn).toEqual(["inspect"]);
  });
});

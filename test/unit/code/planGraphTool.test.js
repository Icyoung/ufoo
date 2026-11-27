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
  test("rejects misspelled tool arguments before mutating a child plan, then accepts the corrected command", () => {
    const state = emptyExecutionState();
    runPlanGraphCommand({ operation: "create", graph: { nodes: [{ id: "root", type: "task", objective: "检查规则", execution: "expand" }] } }, { executionState: state });
    const before = JSON.stringify(state);
    const runTool = jest.fn(() => ({ ok: true, content: "rules" }));
    const command = { operation: "patch", operations: [{ op: "expand_node", nodeId: "root", children: [
      { id: "rules", type: "tool", tool: "read", arguments: { path: "AGENTS.md" } },
    ] }] };
    const rejected = runPlanGraphCommand(command, { executionState: state, runTool, validateToolArgs: true });
    expect(rejected).toMatchObject({ status: "rejected", errors: [expect.objectContaining({
      code: "INVALID_NODE_ARGUMENTS", field: "operations[0].children[0].arguments", message: expect.stringContaining(".args"),
    })] });
    expect(JSON.stringify(state)).toBe(before);
    expect(runTool).not.toHaveBeenCalled();
    command.operations[0].children[0].args = command.operations[0].children[0].arguments;
    delete command.operations[0].children[0].arguments;
    expect(runPlanGraphCommand(command, { executionState: state, runTool, validateToolArgs: true }).ok).toBe(true);
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0][0].args).toEqual({ path: "AGENTS.md" });
  });

  test("missing required graph tool parameters are rejected before execution", () => {
    const runTool = jest.fn();
    const result = runPlanGraphCommand({ operation: "create", graph: { nodes: [{ id: "bad", type: "tool", tool: "read", args: {} }] } },
      { executionState: emptyExecutionState(), runTool, validateToolArgs: true });
    expect(result).toMatchObject({ status: "rejected", errors: [expect.objectContaining({ field: "graph.nodes[0].args.path", code: "MISSING_TOOL_ARGUMENT" })] });
    expect(runTool).not.toHaveBeenCalled();

    const badBashRun = runPlanGraphCommand({ operation: "create", graph: { nodes: [{ id: "bad_bash", type: "tool", tool: "bash", args: {} }] } },
      { executionState: emptyExecutionState(), runTool, validateToolArgs: true });
    expect(badBashRun).toMatchObject({ status: "rejected", errors: [expect.objectContaining({ field: "graph.nodes[0].args.command", code: "MISSING_TOOL_ARGUMENT" })] });

    const badBashLogs = runPlanGraphCommand({ operation: "create", graph: { nodes: [{ id: "bad_logs", type: "tool", tool: "bash", args: { action: "logs" } }] } },
      { executionState: emptyExecutionState(), runTool, validateToolArgs: true });
    expect(badBashLogs).toMatchObject({ status: "rejected", errors: [expect.objectContaining({ field: "graph.nodes[0].args.backgroundId", code: "MISSING_TOOL_ARGUMENT" })] });

    const okBashLogs = runPlanGraphCommand({ operation: "create", graph: { nodes: [{ id: "ok_logs", type: "tool", tool: "bash", args: { action: "logs", backgroundId: "bg_123" } }] } },
      { executionState: emptyExecutionState(), runTool: jest.fn(() => ({ ok: true, kind: "background_bash", action: "logs", backgroundId: "bg_123", logOutput: "ready" })), validateToolArgs: true });
    expect(okBashLogs.ok).toBe(true);
  });

  test("failed-node inspection exposes the actual error and read-only recovery guidance", () => {
    const state = emptyExecutionState();
    const result = runPlanGraphCommand({ operation: "create", graph: { nodes: [
      { id: "read", type: "tool", tool: "read", args: { path: "missing.md" } },
      { id: "after", type: "checkpoint", dependsOn: ["read"] },
    ] } }, { executionState: state, runTool: () => ({ ok: false, error: "ENOENT: missing.md" }) });
    expect(result.advance.failedNodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: "read", error: "ENOENT: missing.md" })]));
    const inspected = runPlanGraphCommand({ operation: "inspect" }, { executionState: state });
    expect(inspected.nodes.find(node => node.id === "read").error).toBe("ENOENT: missing.md");
    expect(inspected.recovery).toMatchObject({ needed: true, hint: expect.stringContaining("Inspect is read-only") });
    expect(inspected.recovery.failures).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "read", error: "ENOENT: missing.md" })]));
  });

  test("TOOL_NAMES includes plan_graph and task_run without plan_mode tool", () => {
    expect(TOOL_NAMES).toEqual([
      "read",
      "read_image",
      "write",
      "edit",
      "bash",
      "artifact_read",
      "plan_graph",
      "task_run",
      "ask_user",
    ]);
  });

  test("immutable prompt treats Plan Mode as runtime posture, not an agent tool", () => {
    const text = buildImmutablePrefix();
    expect(text).toContain("plan_graph");
    expect(text).toContain("task_run");
    expect(text).toContain("read_image");
    expect(text).toMatch(/TaskRuns are orthogonal to Plan Mode/i);
    expect(text).toMatch(/Plan Mode is a runtime posture for the Agent Loop/i);
    expect(text).toMatch(/operation=create automatically enables Plan Mode/i);
    expect(text).toContain("Do not call plan_graph or task_run together with read, read_image, write, edit, bash, or artifact_read");
    expect(text).toMatch(/cancel_graph/i);
    expect(text).not.toContain("create/patch/inspect/control/cancel.");
    expect(text).not.toContain("create/patch/inspect/control/cancel)");
    expect(text).not.toContain("create/patch/inspect/control/cancel,");
    expect(text).toContain("create, patch, inspect, cancel_graph, and control");
    expect(text).toMatch(/control\.start_task for execution\.kind=task_loop/i);
    expect(text).toMatch(/automatically decompose/i);
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

  test("tool schemas use layered descriptions for the control-plane tools", () => {
    const { buildCoreToolSpecs } = require("../../../src/code/nativeRunner");
    const specs = buildCoreToolSpecs();
    const byName = Object.fromEntries(
      specs.map((s) => [s.function.name, s.function]),
    );

    expect(byName.artifact_read.description).toMatch(/does not read workspace files/i);
    expect(byName.artifact_read.description).toMatch(/use `read` for repository paths/i);

    expect(byName.read_image.description).toMatch(/image/i);
    expect(byName.read_image.parameters.required).toEqual(["path"]);

    expect(byName.plan_graph.description).toMatch(/control\.start_task/i);
    expect(byName.plan_graph.description).toMatch(/task_run/i);
    expect(byName.plan_graph.description).not.toMatch(/Patch ops:/);
    expect(byName.plan_graph.parameters.properties.operations.description).toMatch(/add_node/);
    expect(byName.plan_graph.parameters.properties.operations.description).toMatch(/control\.actions/);
    expect(byName.plan_graph.parameters.properties.actions.description).toMatch(/complete_task/);

    expect(byName.task_run.description).toMatch(/orthogonal to Plan Mode/i);
    expect(byName.task_run.description).toMatch(/standalone/i);
    expect(byName.task_run.parameters.properties.operation.enum).toEqual([
      "start",
      "cancel",
      "fail",
      "complete",
      "inspect",
    ]);

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

  test("completing the last task archives and clears the active plan", () => {
    const { advanceStoredGraph } = require("../../../src/code/context/planGraphService");
    const executionState = emptyExecutionState();
    const created = runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "Ship login",
        nodes: [{ id: "t1", type: "task", title: "Implement login" }],
      },
    }, { executionState, autoAdvance: false });
    expect(created.status).toBe("accepted");
    expect(executionState.planMode).toBe(true);
    const oldId = created.graphId;

    const advanced = advanceStoredGraph(executionState.planGraph, {
      runTool: () => ({ ok: true }),
    });
    executionState.planGraph = advanced.planGraph;
    expect(executionState.planGraph.nodes.find((n) => n.id === "t1").status).toBe("waiting_llm");

    const done = runPlanGraphCommand({
      operation: "control",
      actions: [{
        op: "complete_task",
        nodeId: "t1",
        summary: "Login works",
        output: { ok: true },
      }],
    }, {
      executionState,
      autoAdvance: true,
      runTool: () => ({ ok: true }),
    });

    expect(done.status).toBe("accepted");
    expect(done.planCompleted).toBe(true);
    expect(done.archivedGraphId).toBe(oldId);
    expect(String(done.summary || "")).toMatch(/Plan completed/);
    expect(String(done.summary || "")).toMatch(/Login works/);
    expect(executionState.planGraph.graphId).toBe("");
    expect(executionState.planGraph.nodes).toEqual([]);
    expect(executionState.planMode).toBe(false);
    expect(executionState.mode).toBe("single_action");
    expect(executionState.archivedPlans).toHaveLength(1);
    expect(executionState.archivedPlans[0].graphId).toBe(oldId);
    expect(executionState.archivedPlans[0].archiveReason).toBe("graph_terminal");
  });

  test("create after an existing plan starts a fresh graph", () => {
    const executionState = emptyExecutionState();
    const first = runPlanGraphCommand({
      operation: "create",
      graph: {
        id: "plan_old",
        objective: "Old work",
        nodes: [{ id: "a", type: "task", title: "Old" }],
      },
    }, { executionState, autoAdvance: false });
    expect(first.graphId).toBeTruthy();

    const second = runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "New work",
        nodes: [{ id: "b", type: "task", title: "New" }],
      },
    }, { executionState, autoAdvance: false });

    expect(second.status).toBe("accepted");
    expect(second.replacedGraphId).toBe(first.graphId);
    expect(second.graphId).toBeTruthy();
    expect(second.graphId).not.toBe(first.graphId);
    expect(second.commandRevision).toBe(1);
    expect(executionState.planGraph.objective).toBe("New work");
    expect(executionState.planGraph.nodes.map((n) => n.id)).toEqual(["b"]);
    expect(executionState.planGraph.commandLog).toEqual({});
    expect(executionState.archivedPlans.some((p) => p.graphId === first.graphId)).toBe(true);
    expect(executionState.graphs[first.graphId]).toBeUndefined();
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

  test("preserves code and shell ${...} literals in edit/write/bash args without false UNKNOWN_OUTPUT_REFERENCE", () => {
    const executionState = emptyExecutionState();
    const seenArgs = {};
    const result = runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "Apply Kotlin & shell updates",
        nodes: [
          {
            id: "edit_kt",
            type: "tool",
            tool: "edit",
            args: {
              path: "Main.kt",
              find: 'log("coin=${state.selectedTradingCoin} subs=${subs.size}")',
              replace: 'log("coin=${it.symbol} key=${request.key}")',
            },
          },
          {
            id: "write_kt",
            type: "tool",
            tool: "write",
            args: {
              path: "Helper.kt",
              content: 'val msg = "item=${item.id}"',
            },
          },
          {
            id: "run_sh",
            type: "tool",
            tool: "bash",
            args: {
              command: 'ls -lt ${TMPDIR:-/tmp} && echo "${unknown.var}"',
            },
          },
        ],
      },
    }, {
      executionState,
      autoAdvance: true,
      runTool: ({ stepId, args }) => {
        seenArgs[stepId] = args;
        return { ok: true, summary: `${stepId} ok` };
      },
    });

    expect(result.status).toBe("accepted");
    expect(result.planCompleted).toBe(true);
    expect(seenArgs.edit_kt.find).toBe('log("coin=${state.selectedTradingCoin} subs=${subs.size}")');
    expect(seenArgs.edit_kt.replace).toBe('log("coin=${it.symbol} key=${request.key}")');
    expect(seenArgs.write_kt.content).toBe('val msg = "item=${item.id}"');
    expect(seenArgs.run_sh.command).toBe('ls -lt ${TMPDIR:-/tmp} && echo "${unknown.var}"');
  });

  test("recovers failed tool nodes via retry_node, skip_node (with action alias), blocked dep edits, and aggregate re-expand", () => {
    const executionState = emptyExecutionState();
    let failOnce = true;
    const runTool = jest.fn(({ stepId, args }) => {
      if (stepId === "audit" && failOnce) {
        failOnce = false;
        return { ok: false, error: `ENOENT: ${args.path}` };
      }
      return { ok: true, summary: `${stepId} ok (${args.path || args.command || ""})` };
    });

    runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "Audit and fix",
        nodes: [
          { id: "root", type: "task", title: "Audit files", content: "Read report and prepare fix" },
        ],
      },
    }, { executionState, autoAdvance: true, runTool });

    const expanded = runPlanGraphCommand({
      operation: "patch",
      operations: [{
        op: "expand_node",
        nodeId: "root",
        children: [
          { id: "audit", type: "tool", tool: "read", args: { path: "/bad/report.txt" } },
          { id: "review", type: "task", title: "Review report", dependsOn: ["audit"] },
        ],
      }],
    }, { executionState, autoAdvance: true, runTool });
    expect(expanded.status).toBe("accepted");
    expect(executionState.planGraph.nodes.find((n) => n.id === "audit").status).toBe("failed");
    expect(executionState.planGraph.nodes.find((n) => n.id === "review").status).toBe("blocked");

    // 1) retry_node with corrected args re-executes audit and unblocks review -> waiting_llm
    const retried = runPlanGraphCommand({
      operation: "control",
      actions: [{ action: "retry_node", nodeId: "audit", args: { path: "good/report.txt" } }],
    }, { executionState, autoAdvance: true, runTool });
    expect(retried.status).toBe("accepted");
    expect(executionState.planGraph.nodes.find((n) => n.id === "audit").status).toBe("succeeded");
    expect(executionState.planGraph.nodes.find((n) => n.id === "review").status).toBe("waiting_llm");

    // 2) expand_node on an already-expanded aggregate task appends new children cleanly
    const reExpanded = runPlanGraphCommand({
      operation: "patch",
      operations: [{
        op: "expand_node",
        nodeId: "root",
        children: [
          { id: "extra_check", type: "tool", tool: "bash", args: { command: "git status" } },
        ],
      }],
    }, { executionState, autoAdvance: true, runTool });
    expect(reExpanded.status).toBe("accepted");
    expect(executionState.planGraph.nodes.find((n) => n.id === "extra_check").status).toBe("succeeded");

    // 3) skip_node works on failed nodes (via action alias) and unblocks downstream blocked nodes
    const state2 = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "Skip failed tool",
        nodes: [
          { id: "bad", type: "tool", tool: "read", args: { path: "missing.txt" } },
          { id: "next", type: "task", title: "Continue anyway", dependsOn: ["bad"] },
        ],
      },
    }, { executionState: state2, autoAdvance: true, runTool: () => ({ ok: false, error: "ENOENT" }) });
    expect(state2.planGraph.nodes.find((n) => n.id === "next").status).toBe("blocked");

    const skipped = runPlanGraphCommand({
      operation: "control",
      actions: [{ action: "skip_node", nodeId: "bad", reason: "optional file" }],
    }, { executionState: state2, autoAdvance: true, runTool: () => ({ ok: true }) });
    expect(skipped.status).toBe("accepted");
    expect(state2.planGraph.nodes.find((n) => n.id === "bad").status).toBe("skipped");
    expect(state2.planGraph.nodes.find((n) => n.id === "next").status).toBe("waiting_llm");

    // 4) remove_dependency works on blocked nodes and resets them to pending
    const state3 = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "Rewire blocked node",
        nodes: [
          { id: "bad", type: "tool", tool: "read", args: { path: "missing.txt" } },
          { id: "next", type: "task", title: "Rewired step", dependsOn: ["bad"] },
        ],
      },
    }, { executionState: state3, autoAdvance: true, runTool: () => ({ ok: false, error: "ENOENT" }) });
    const rewired = runPlanGraphCommand({
      operation: "patch",
      operations: [{ op: "remove_dependency", nodeId: "next", dep: "bad" }],
    }, { executionState: state3, autoAdvance: true, runTool: () => ({ ok: true }) });
    expect(rewired.status).toBe("accepted");
    expect(state3.planGraph.nodes.find((n) => n.id === "next").status).toBe("waiting_llm");
  });

  test("supports dynamic plan edits (add_node after/before, update_node, remove_node), title/content separation, and archived inspect", () => {
    const executionState = emptyExecutionState();
    const longContent = "在 .ufoo/worktrees/demo 读取 AGENTS.md 与 report.txt，检查工作区现状并接续 F04。追踪 SearchViewModel、RxWsClient 与 Futures2Repo；保留 F01-F03，中文汇报。";
    const created = runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "Ship performance fixes",
        nodes: [
          { id: "s1", type: "task", title: "Fix F04 quotes", content: longContent },
          { id: "s2", type: "task", content: longContent, dependsOn: ["s1"] },
        ],
      },
    }, { executionState, autoAdvance: false });
    expect(created.status).toBe("accepted");
    const s1 = executionState.planGraph.nodes.find((n) => n.id === "s1");
    const s2 = executionState.planGraph.nodes.find((n) => n.id === "s2");
    expect(s1.title).toBe("Fix F04 quotes");
    expect(s1.content).toBe(longContent);
    expect(s2.title.length).toBeLessThanOrEqual(72);
    expect(s2.content).toBe(longContent);

    // Dynamically edit s2 title/content, append s3 after s2, and insert s1b between s1 and s2
    const patched = runPlanGraphCommand({
      operation: "patch",
      operations: [
        { op: "update_node", nodeId: "s2", title: "Fix F05 depth channel", content: "Cap Channel buffer and add replay tests" },
        { op: "add_node", after: "s1", before: "s2", node: { id: "s1b", type: "task", title: "Verify F04 replay" } },
        { op: "add_node", after: "s2", node: { id: "s3", type: "task", title: "Run final build" } },
      ],
    }, { executionState, autoAdvance: false });
    expect(patched.status).toBe("accepted");
    expect(executionState.planGraph.nodes.find((n) => n.id === "s2").title).toBe("Fix F05 depth channel");
    expect(executionState.planGraph.nodes.find((n) => n.id === "s2").dependsOn).toContain("s1b");
    expect(executionState.planGraph.nodes.find((n) => n.id === "s3").dependsOn).toEqual(["s2"]);

    // Dynamically remove s1b and confirm s2 dependency is cleaned
    const removed = runPlanGraphCommand({
      operation: "patch",
      operations: [{ op: "remove_node", nodeId: "s1b" }],
    }, { executionState, autoAdvance: false });
    expect(removed.status).toBe("accepted");
    expect(removed.nodesRemoved).toEqual(["s1b"]);
    expect(executionState.planGraph.nodes.find((n) => n.id === "s1b")).toBeUndefined();
    expect(executionState.planGraph.nodes.find((n) => n.id === "s2").dependsOn).toEqual(["s1"]);

    // Archive via cancel_graph and verify inspect still returns archived graph with archived:true
    const oldId = created.graphId;
    runPlanGraphCommand({ operation: "cancel_graph" }, { executionState });
    const archivedInspect = runPlanGraphCommand({ operation: "inspect", graphId: oldId }, { executionState });
    expect(archivedInspect.status).toBe("accepted");
    expect(archivedInspect.archived).toBe(true);
    expect(archivedInspect.graphId).toBe(oldId);

    // Missing graphId returns GRAPH_NOT_FOUND with availableGraphIds hint
    const missing = runPlanGraphCommand({ operation: "patch", graphId: "plan_nonexistent", operations: [] }, { executionState });
    expect(missing.status).toBe("rejected");
    expect(missing.errors[0].code).toBe("GRAPH_NOT_FOUND");
    expect(Array.isArray(missing.errors[0].availableGraphIds)).toBe(true);
  });

  test("child TaskLoop patch does not recurse revisions or corrupt child nodes when parent graph is replaced", () => {
    const { startTask } = require("../../../src/code/runtime/taskControl");
    const executionState = emptyExecutionState();
    runPlanGraphCommand({
      operation: "create",
      graph: {
        objective: "Parent plan",
        nodes: [{ id: "startup", type: "task", title: "Fix startup", execution: { kind: "task_loop" } }],
      },
    }, { executionState, autoAdvance: false });

    const started = startTask(executionState, {
      nodeId: "startup",
      runTool: () => ({ ok: true }),
      processImmediately: true,
    });
    expect(started.ok).toBe(true);

    // Expand child root with a tool node having the SAME id ("startup") as the parent task node
    const p1 = runPlanGraphCommand({
      operation: "patch",
      graphId: started.childGraphId,
      operations: [{
        op: "expand_node",
        nodeId: "root",
        children: [{ id: "startup", type: "tool", tool: "edit", args: { path: "A.kt", find: "a", replace: "b" } }],
      }],
    }, {
      executionState,
      autoAdvance: true,
      runTool: () => ({ ok: true, summary: "edit ok" }),
    });
    expect(p1.status).toBe("accepted");
    // No recursive specRevision storm (must stay 1 after a single patch)
    expect(p1.commandRevision).toBe(1);

    // Replace the primary plan while child TaskRun is still active; subsequent child patches
    // must NOT overwrite the succeeded child tool node `startup` to `running` / lease expired.
    runPlanGraphCommand({
      operation: "create",
      graph: { objective: "Unrelated new plan", nodes: [{ id: "other", type: "task", title: "Other" }] },
    }, { executionState, autoAdvance: false });

    const p2 = runPlanGraphCommand({
      operation: "patch",
      graphId: started.childGraphId,
      operations: [{
        op: "add_node",
        node: { id: "check", type: "tool", tool: "bash", args: { command: "echo ok" } },
      }],
    }, {
      executionState,
      autoAdvance: true,
      runTool: () => ({ ok: true, summary: "bash ok" }),
    });
    expect(p2.status).toBe("accepted");
    expect(p2.advance.failedNodes).toEqual([]);
    const childGraph = executionState.graphs[started.childGraphId];
    expect(childGraph.nodes.find((n) => n.id === "startup").status).toBe("succeeded");
  });
});

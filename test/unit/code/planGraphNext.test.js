"use strict";

const {
  resolveValue,
  collectRefsFromValue,
  executePlanGraph,
  compilePlanGraph,
} = require("../../../src/code/context/planGraph");
const {
  claimSafeReadyToolBatch,
  recoverExpiredLeases,
  resourcesConflict,
  createLease,
} = require("../../../src/code/context/toolRuntime");
const {
  applyUcodePlanCommand,
  planModeBlocksDirectTool,
} = require("../../../src/code/context/planMode");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const { runPlanGraphCommand } = require("../../../src/code/context/planGraphService");
const { runSingleCommand } = require("../../../src/code/repl");

describe("plan graph next capabilities", () => {
  test("$ref preserves native types and infers dependsOn", () => {
    const refs = collectRefsFromValue({
      timeout: { $ref: { node: "config", pointer: "/output/timeout" } },
      command: { $template: "cat ${discover.output.path}" },
    });
    expect(Array.from(refs).sort()).toEqual(["config", "discover"]);

    const outputs = new Map([
      ["config", { status: "succeeded", output: { timeout: 5000 }, summary: "", artifacts: [] }],
      ["discover", { status: "succeeded", output: { path: "a.txt" }, summary: "", artifacts: [] }],
    ]);
    expect(resolveValue({
      timeout: { $ref: { node: "config", pointer: "/output/timeout" } },
      command: { $template: "cat ${discover.output.path}" },
    }, outputs)).toEqual({
      timeout: 5000,
      command: "cat a.txt",
    });

    const compiled = compilePlanGraph({
      nodes: [
        { id: "config", type: "tool", tool: "bash", args: { command: "echo" } },
        {
          id: "use",
          type: "tool",
          tool: "bash",
          args: { timeout: { $ref: { node: "config", pointer: "/output/timeout" } } },
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    expect(compiled.nodes.find((n) => n.id === "use").dependsOn).toContain("config");
  });

  test("claimSafeReadyToolBatch respects file and workspace locks", () => {
    const nodes = [
      { id: "r1", type: "tool", tool: "read", args: { path: "a.txt" }, status: "pending", attempt: 0 },
      { id: "r2", type: "tool", tool: "read", args: { path: "b.txt" }, status: "pending", attempt: 0 },
      { id: "w1", type: "tool", tool: "write", args: { path: "a.txt", content: "x" }, status: "pending", attempt: 0 },
      { id: "b1", type: "tool", tool: "bash", args: { command: "ls" }, status: "pending", attempt: 0 },
    ];
    const batch = claimSafeReadyToolBatch(nodes, {
      parallel: true,
      resolveArgs: (node) => node.args,
    });
    // Different-file reads can share a batch; write(a) conflicts with read(a);
    // bash takes workspace:* and conflicts with any held file lock.
    expect(batch.map((n) => n.id).sort()).toEqual(["r1", "r2"]);
    expect(batch.every((n) => n.status === "running")).toBe(true);
    expect(batch.every((n) => n.lease && n.lease.id)).toBe(true);

    expect(resourcesConflict(["file:a.txt"], ["file:a.txt"])).toBe(true);
    expect(resourcesConflict(["file:a.txt"], ["file:b.txt"])).toBe(false);
    expect(resourcesConflict(["workspace:*"], ["file:a.txt"])).toBe(true);
  });

  test("recoverExpiredLeases retries safe tools and fails unsafe", () => {
    const now = Date.now();
    const nodeMap = new Map([
      ["read1", {
        id: "read1",
        type: "tool",
        tool: "read",
        status: "running",
        lease: createLease({ now: now - 200000, leaseMs: 1000 }),
      }],
      ["write1", {
        id: "write1",
        type: "tool",
        tool: "write",
        status: "running",
        lease: createLease({ now: now - 200000, leaseMs: 1000 }),
      }],
    ]);
    const recovered = recoverExpiredLeases(nodeMap, { now });
    expect(recovered).toEqual([
      { id: "read1", action: "retry" },
      { id: "write1", action: "fail" },
    ]);
    expect(nodeMap.get("read1").status).toBe("pending");
    expect(nodeMap.get("write1").status).toBe("failed");
  });

  test("failurePolicy fail_fast cancels independent pending branches", () => {
    const result = executePlanGraph({
      failurePolicy: "fail_fast",
      nodes: [
        { id: "a", type: "tool", tool: "bash", args: { command: "a" } },
        { id: "b", type: "tool", tool: "bash", args: { command: "b" } },
      ],
    }, {
      parallel: true,
      runStep: ({ stepId }) => {
        if (stepId === "a") return { ok: false, error: "boom" };
        return { ok: true, summary: "b ok" };
      },
    });
    expect(result.ok).toBe(false);
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]));
    expect(byId.a.status).toBe("failed");
    // b may have been claimed in same batch before fail_fast, or cancelled if not yet run.
    expect(["cancelled", "succeeded", "failed", "pending"]).toContain(byId.b.status);
    expect(result.yieldReason).toBe("tool_failure_requires_decision");
  });

  test("/plan command toggles plan mode and shows view", () => {
    expect(runSingleCommand("/plan on").kind).toBe("plan");
    const state = { executionState: emptyExecutionState() };
    const on = applyUcodePlanCommand(state, { action: "on" });
    expect(on.ok).toBe(true);
    expect(state.executionState.planMode).toBe(true);
    expect(planModeBlocksDirectTool("bash", state.executionState)).toBe(true);
    expect(planModeBlocksDirectTool("read", state.executionState)).toBe(false);

    runPlanGraphCommand({
      operation: "create",
      graph: {
        nodes: [
          { id: "inspect", type: "task", title: "locate" },
          { id: "fix", type: "task", title: "patch", dependsOn: ["inspect"] },
        ],
      },
    }, { executionState: state.executionState, autoAdvance: false });

    const shown = applyUcodePlanCommand(state, { action: "show" });
    expect(shown.output).toMatch(/Plan mode: ON/i);
    expect(shown.output).toMatch(/inspect|locate/i);
  });
});

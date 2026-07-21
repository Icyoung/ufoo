"use strict";

const {
  compilePlanGraph,
  executePlanGraph,
  applyPlanOperations,
  resolveValue,
  flattenPlanNodes,
  normalizePlanGraph,
} = require("../../../src/code/context/planGraph");
const {
  executeExecutionSegment,
} = require("../../../src/code/context/executionSegment");

describe("planGraph unified IR", () => {
  test("group sequence compiles to dependsOn chain", () => {
    const compiled = compilePlanGraph({
      type: "group",
      strategy: "sequence",
      children: [
        { id: "a", type: "tool", tool: "read", args: { path: "a.txt" } },
        { id: "b", type: "tool", tool: "read", args: { path: "b.txt" } },
        { id: "c", type: "tool", tool: "read", args: { path: "c.txt" } },
      ],
    });
    expect(compiled.ok).toBe(true);
    const byId = Object.fromEntries(compiled.nodes.map((n) => [n.id, n]));
    expect(byId.a.dependsOn).toEqual([]);
    expect(byId.b.dependsOn).toEqual(["a"]);
    expect(byId.c.dependsOn).toEqual(["b"]);
  });

  test("group parallel leaves children independent", () => {
    const compiled = compilePlanGraph({
      type: "group",
      strategy: "parallel",
      children: [
        { id: "a", type: "tool", tool: "read", args: { path: "a.txt" } },
        { id: "b", type: "tool", tool: "read", args: { path: "b.txt" } },
      ],
    });
    expect(compiled.ok).toBe(true);
    const byId = Object.fromEntries(compiled.nodes.map((n) => [n.id, n]));
    expect(byId.a.dependsOn).toEqual([]);
    expect(byId.b.dependsOn).toEqual([]);
  });

  test("top-level nodes keep explicit dependsOn only", () => {
    const compiled = compilePlanGraph({
      nodes: [
        { id: "inspect", type: "task", objective: "locate code" },
        { id: "diagnose", type: "task", objective: "find cause", dependsOn: ["inspect"] },
        { id: "fix", type: "task", objective: "patch", dependsOn: ["diagnose"] },
      ],
    });
    expect(compiled.ok).toBe(true);
    const byId = Object.fromEntries(compiled.nodes.map((n) => [n.id, n]));
    expect(byId.inspect.dependsOn).toEqual([]);
    expect(byId.diagnose.dependsOn).toEqual(["inspect"]);
    expect(byId.fix.dependsOn).toEqual(["diagnose"]);
  });

  test("infers dependsOn from ${node.output} refs", () => {
    const compiled = compilePlanGraph({
      nodes: [
        { id: "search", type: "tool", tool: "bash", args: { command: "rg foo" } },
        {
          id: "read",
          type: "tool",
          tool: "read",
          args: { matches: "${search.output.matches}" },
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    const read = compiled.nodes.find((n) => n.id === "read");
    expect(read.dependsOn).toContain("search");
    expect(compiled.warnings.some((w) => /inferred dependsOn search/.test(w))).toBe(true);
  });

  test("detects cycles", () => {
    const compiled = compilePlanGraph({
      nodes: [
        { id: "a", type: "tool", tool: "read", args: {}, dependsOn: ["b"] },
        { id: "b", type: "tool", tool: "read", args: {}, dependsOn: ["a"] },
      ],
    });
    expect(compiled.ok).toBe(false);
    expect(compiled.errors.some((e) => /cycle/.test(e))).toBe(true);
  });

  test("resolves template refs into args", () => {
    const outputs = new Map([
      ["search", {
        status: "succeeded",
        output: { matches: ["src/a.js"] },
        artifacts: [],
        summary: "found 1",
      }],
    ]);
    expect(resolveValue({ matches: "${search.output.matches}" }, outputs)).toEqual({
      matches: ["src/a.js"],
    });
    expect(resolveValue("${search.summary}", outputs)).toBe("found 1");
  });

  test("executes parallel tools then yields on task", () => {
    const order = [];
    const result = executePlanGraph({
      type: "group",
      strategy: "sequence",
      children: [
        {
          id: "inspect",
          type: "group",
          strategy: "parallel",
          children: [
            { id: "search_code", type: "tool", tool: "bash", args: { command: "rg x" } },
            { id: "run_tests", type: "tool", tool: "bash", args: { command: "npm test" } },
          ],
        },
        {
          id: "diagnose",
          type: "task",
          objective: "find root cause",
          inputs: {
            code: "${search_code.output}",
            test: "${run_tests.output}",
          },
        },
      ],
    }, {
      parallel: true,
      runStep: ({ stepId, tool, args }) => {
        order.push(stepId);
        return {
          ok: true,
          artifactId: `artifact_${stepId}`,
          output: { tool, args, stepId },
          summary: `${stepId} ok`,
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(order.sort()).toEqual(["run_tests", "search_code"]);
    expect(result.stoppedAt).toBe("waiting_llm");
    expect(result.waitingFor.id).toBe("diagnose");
    expect(result.waitingFor.inputs.code.stepId).toBe("search_code");
  });

  test("partial_failure blocks dependents and continues unrelated branch", () => {
    const order = [];
    const result = executePlanGraph({
      nodes: [
        { id: "a", type: "tool", tool: "bash", args: { command: "a" } },
        { id: "b", type: "tool", tool: "bash", args: { command: "b" }, dependsOn: ["a"] },
        { id: "c", type: "tool", tool: "bash", args: { command: "c" } },
      ],
    }, {
      parallel: true,
      runStep: ({ stepId }) => {
        order.push(stepId);
        if (stepId === "a") return { ok: false, error: "boom" };
        return { ok: true, artifactId: `artifact_${stepId}`, summary: stepId };
      },
    });

    expect(result.ok).toBe(false);
    expect(order).toContain("a");
    expect(order).toContain("c");
    expect(order).not.toContain("b");
    expect(result.summary.status).toBe("partial_failure");
    const b = result.nodes.find((n) => n.id === "b");
    expect(b.status).toBe("blocked");
  });

  test("expand_node replaces abstract task with tool subgraph", () => {
    const plan = normalizePlanGraph({
      nodes: [
        { id: "inspect", type: "task", objective: "locate" },
        { id: "diagnose", type: "task", objective: "cause", dependsOn: ["inspect"] },
      ],
    });
    const next = applyPlanOperations(plan, [
      {
        op: "expand_node",
        nodeId: "inspect",
        children: [
          { id: "search_code", type: "tool", tool: "bash", args: { command: "rg cancel" } },
          { id: "inspect_git", type: "tool", tool: "bash", args: { command: "git diff" } },
        ],
      },
    ]);
    const compiled = compilePlanGraph(next);
    expect(compiled.ok).toBe(true);
    expect(compiled.nodes.map((n) => n.id).sort()).toEqual([
      "diagnose",
      "inspect",
      "inspect_git",
      "search_code",
    ]);
    const diagnose = compiled.nodes.find((n) => n.id === "diagnose");
    expect(diagnose.dependsOn).toEqual(["inspect"]);
    const inspect = compiled.nodes.find((n) => n.id === "inspect");
    expect(inspect.execution).toEqual({ kind: "aggregate" });
    expect(inspect.dependsOn.sort()).toEqual(["inspect_git", "search_code"]);
  });

  test("legacy execution_segment bridge keeps checkpoint and side_effect stops", () => {
    const checkpoint = executeExecutionSegment({
      segment: {
        type: "execution_segment",
        steps: [
          { id: "s1", tool: "read", args: { path: "a.txt" } },
          { id: "s2", tool: "read", args: { path: "b.txt" } },
        ],
        checkpoint: { after: ["s1"] },
      },
      runStep: ({ stepId }) => ({ ok: true, artifactId: `artifact_${stepId}` }),
    });
    expect(checkpoint.stoppedAt).toBe("checkpoint");
    expect(checkpoint.results.map((r) => r.stepId)).toEqual(["s1"]);

    const side = executeExecutionSegment({
      segment: {
        type: "execution_segment",
        steps: [
          { id: "s1", tool: "write", args: { path: "a.txt", content: "x" } },
          { id: "s2", tool: "read", args: { path: "b.txt" } },
        ],
      },
      runStep: ({ stepId }) => ({ ok: true, artifactId: `artifact_${stepId}` }),
    });
    expect(side.stoppedAt).toBe("side_effect");
    expect(side.results.map((r) => r.stepId)).toEqual(["s1"]);
  });

  test("flattenPlanNodes is exported for compiler checks", () => {
    const flat = flattenPlanNodes([
      {
        id: "root",
        type: "group",
        strategy: "sequence",
        children: [
          { id: "a", type: "tool", tool: "read", args: {} },
          { id: "b", type: "tool", tool: "read", args: {} },
        ],
      },
    ]);
    const nodes = Array.isArray(flat) ? flat : flat.nodes;
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(nodes[1].dependsOn).toContain("a");
  });
});

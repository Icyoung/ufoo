"use strict";

jest.mock("../../../src/code/dispatch", () => ({
  runToolCall: jest.fn(() => ({ ok: true, content: "" })),
}));

jest.mock("../../../src/config", () => {
  const fs = require("fs");
  const path = require("path");
  const actual = jest.requireActual("../../../src/config");
  const emptyUcode = {
    ucodeProvider: "",
    ucodeModel: "",
    ucodeBaseUrl: "",
    ucodeApiKey: "",
    ucodeAgentDir: "",
  };
  return {
    ...actual,
    loadGlobalUcodeConfig: () => emptyUcode,
    loadConfig: (projectRoot) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, ".ufoo", "config.json"), "utf8"));
        return { ...raw, ...emptyUcode };
      } catch {
        return { ...emptyUcode };
      }
    },
  };
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  enqueueUserPrompt,
  drainUserPrompts,
  clearUserPrompts,
  hasPendingUserPrompts,
  listPendingUserPrompts,
  shouldFrameAsUserReminder,
  formatUserReminderMessage,
  buildContinuationUserPrompt,
  shouldAutoContinuePlan,
  buildPlanAutoContinueReminder,
} = require("../../../src/code/context/userNudge");
const { emptyExecutionState } = require("../../../src/code/context/executionSegment");
const { runNativeAgentTask } = require("../../../src/code/nativeRunner");
const { runToolCall } = require("../../../src/code/dispatch");

function makeSseResponse(chunks = []) {
  const lines = [];
  for (const chunk of chunks) {
    lines.push(`data: ${JSON.stringify(chunk)}`);
    lines.push("");
  }
  lines.push("data: [DONE]");
  lines.push("");
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("user nudge queue", () => {
  test("enqueue / drain is atomic and preserves order", () => {
    const state = emptyExecutionState();
    expect(enqueueUserPrompt(state, " first ").enqueued).toBe(true);
    expect(enqueueUserPrompt(state, "second").enqueued).toBe(true);
    expect(enqueueUserPrompt(state, "  ").enqueued).toBe(false);
    expect(hasPendingUserPrompts(state)).toBe(true);
    expect(listPendingUserPrompts(state)).toEqual(["first", "second"]);
    expect(drainUserPrompts(state)).toEqual(["first", "second"]);
    expect(drainUserPrompts(state)).toEqual([]);
    expect(hasPendingUserPrompts(state)).toBe(false);
    expect(listPendingUserPrompts(state)).toEqual([]);
  });

  test("clear drops pending prompts", () => {
    const state = emptyExecutionState();
    enqueueUserPrompt(state, "a");
    clearUserPrompts(state);
    expect(drainUserPrompts(state)).toEqual([]);
  });

  test("formatUserReminderMessage labels and waiting hint", () => {
    const single = formatUserReminderMessage(["focus on tests"]);
    expect(single).toMatch(/User reminder \(additional prompt\):/);
    expect(single).toContain("focus on tests");

    const multi = formatUserReminderMessage(["one", "two"], {
      waitingFor: { id: "inspect", type: "task", title: "Locate code" },
    });
    expect(multi).toContain("1. one");
    expect(multi).toContain("2. two");
    expect(multi).toMatch(/waiting task: inspect/);
  });

  test("shouldFrameAsUserReminder for planMode or waitingFor", () => {
    expect(shouldFrameAsUserReminder(emptyExecutionState())).toBe(false);
    expect(shouldFrameAsUserReminder({ planMode: true })).toBe(true);
    expect(shouldFrameAsUserReminder({
      planMode: false,
      planGraph: { waitingFor: { id: "t1", type: "task" } },
    })).toBe(true);
  });

  test("buildContinuationUserPrompt wraps idle plan waiting message", () => {
    const text = buildContinuationUserPrompt("skip the flaky test", {
      planGraph: { waitingFor: { id: "fix", type: "task", title: "Apply fix" } },
    });
    expect(text).toMatch(/User reminder/);
    expect(text).toContain("skip the flaky test");
    expect(text).toMatch(/waiting task: fix/);
  });

  test("shouldAutoContinuePlan for waiting task only", () => {
    expect(shouldAutoContinuePlan(null)).toBe(false);
    expect(shouldAutoContinuePlan(emptyExecutionState())).toBe(false);
    expect(shouldAutoContinuePlan({
      planGraph: { waitingFor: { id: "t1", type: "task" }, lastYieldReason: "task_ready" },
    })).toBe(true);
    expect(shouldAutoContinuePlan({
      pendingUserInteraction: { id: "ui_1" },
      planGraph: { waitingFor: { id: "t1", type: "task" }, lastYieldReason: "task_ready" },
    })).toBe(false);
    expect(shouldAutoContinuePlan({
      planGraph: { waitingFor: { id: "cp1", type: "checkpoint" }, lastYieldReason: "llm_checkpoint_ready" },
    })).toBe(false);
    expect(shouldAutoContinuePlan({
      planGraph: { waitingFor: { id: "t1", type: "task" }, lastYieldReason: "approval_required" },
    })).toBe(false);
    expect(shouldAutoContinuePlan({
      planGraph: { waitingFor: { id: "t1", type: "task" }, lastYieldReason: "scheduler_deadlock" },
    })).toBe(false);
    expect(shouldAutoContinuePlan({
      planGraph: { waitingFor: { id: "t1", type: "task" }, lastYieldReason: "graph_terminal" },
    })).toBe(false);
  });

  test("buildPlanAutoContinueReminder points at waiting task", () => {
    const text = buildPlanAutoContinueReminder({
      planGraph: { waitingFor: { id: "inspect", type: "task", title: "Inspect fonts" } },
    });
    expect(text).toMatch(/Runtime wake \(not a user message\)/);
    expect(text).toMatch(/Continue serving/);
    expect(text).toMatch(/waiting task: inspect/);
    expect(text).toContain("Inspect fonts");
    expect(text).not.toMatch(/User reminder \(additional prompt\)/);
    expect(buildPlanAutoContinueReminder(emptyExecutionState())).toBe("");
  });
});

describe("nativeRunner injects pending reminders before LLM turns", () => {
  const originalFetch = global.fetch;
  let workspaceRoot = "";

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-nudge-runner-"));
    fs.mkdirSync(path.join(workspaceRoot, ".ufoo"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".ufoo", "config.json"), JSON.stringify({
      ucodeProvider: "",
      ucodeModel: "",
      ucodeBaseUrl: "",
      ucodeApiKey: "",
    }, null, 2));
  });

  afterEach(() => {
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test("drains queue into next model request after tool results", async () => {
    const executionState = emptyExecutionState();
    let turn = 0;
    global.fetch.mockImplementation(async (_url, init) => {
      turn += 1;
      const body = JSON.parse(String(init && init.body || "{}"));
      if (turn === 1) {
        return makeSseResponse([
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"a.txt"}',
                  },
                }],
              },
            }],
          },
        ]);
      }
      const reminder = (body.messages || []).find((m) => (
        m.role === "user"
        && String(m.content || "").includes("User reminder (additional prompt):")
        && String(m.content || "").includes("prefer unit tests")
      ));
      expect(reminder).toBeTruthy();
      return makeSseResponse([
        { choices: [{ delta: { content: "done with reminder" } }] },
      ]);
    });

    runToolCall.mockImplementation(() => {
      enqueueUserPrompt(executionState, "prefer unit tests");
      return { ok: true, content: "file contents" };
    });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "read a file",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("done with reminder");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(hasPendingUserPrompts(executionState)).toBe(false);
  });

  test("clears pending prompts on cancel", async () => {
    const executionState = emptyExecutionState();
    enqueueUserPrompt(executionState, "should be dropped");
    const controller = new AbortController();
    controller.abort();

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "start",
      provider: "openai",
      model: "gpt-test",
      executionState,
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(hasPendingUserPrompts(executionState)).toBe(false);
  });

  test("auto-continues text-only turn while plan waiting on task", async () => {
    const executionState = emptyExecutionState();
    executionState.planGraph = {
      graphId: "plan_auto",
      waitingFor: { id: "inspect", type: "task", title: "Inspect fonts" },
      lastYieldReason: "task_ready",
      nodes: [{ id: "inspect", type: "task", title: "Inspect fonts", status: "waiting_llm" }],
    };
    let turn = 0;
    global.fetch.mockImplementation(async (_url, init) => {
      turn += 1;
      const body = JSON.parse(String(init && init.body || "{}"));
      if (turn === 1) {
        return makeSseResponse([
          { choices: [{ delta: { content: "Here is the plan overview." } }] },
        ]);
      }
      const reminder = (body.messages || []).find((m) => (
        m.role === "user"
        && (
          String(m.content || "").includes("Continue serving")
          || String(m.content || "").includes("Continue the active plan")
        )
        && String(m.content || "").includes("waiting task: inspect")
      ));
      expect(reminder).toBeTruthy();
      expect(String(reminder.content || "")).not.toMatch(/User reminder \(additional prompt\)/);
      executionState.planGraph.waitingFor = null;
      executionState.planGraph.lastYieldReason = "graph_terminal";
      return makeSseResponse([
        { choices: [{ delta: { content: "advancing inspect" } }] },
      ]);
    });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "make a plan",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("advancing inspect");
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("does not auto-continue when approval is required", async () => {
    const executionState = emptyExecutionState();
    executionState.planGraph = {
      graphId: "plan_appr",
      waitingFor: { id: "t1", type: "task", title: "Needs approval" },
      lastYieldReason: "approval_required",
      nodes: [{ id: "t1", type: "task", status: "waiting_llm" }],
    };
    global.fetch.mockImplementation(async () => makeSseResponse([
      { choices: [{ delta: { content: "waiting for you" } }] },
    ]));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("waiting for you");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("stops auto-continue after consecutive empty turns on same waiting id", async () => {
    const executionState = emptyExecutionState();
    executionState.planGraph = {
      graphId: "plan_stuck",
      waitingFor: { id: "stuck", type: "task", title: "Stuck node" },
      lastYieldReason: "task_ready",
      nodes: [{ id: "stuck", type: "task", status: "waiting_llm" }],
    };
    global.fetch.mockImplementation(async () => makeSseResponse([
      { choices: [{ delta: { content: "still thinking" } }] },
    ]));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "continue",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    // Original empty + 2 auto-continues, then stuck stop.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(executionState.planGraph.waitingFor.id).toBe("stuck");
  });

  test("delivers mid-loop task_started mailbox before next model turn", async () => {
    const { enqueueAgentRuntime } = require("../../../src/code/runtime/loopMailbox");
    const { createRuntimeEvent } = require("../../../src/code/runtime/runtimeEvents");
    const executionState = emptyExecutionState();
    let turn = 0;
    global.fetch.mockImplementation(async (_url, init) => {
      turn += 1;
      const body = JSON.parse(String(init && init.body || "{}"));
      if (turn === 1) {
        enqueueAgentRuntime(executionState, createRuntimeEvent("task_started", {
          taskId: "batch-1",
          taskRunId: "trun_wake_1",
        }));
        executionState.taskRuns = {
          byId: {
            trun_wake_1: {
              id: "trun_wake_1",
              status: "running",
              phase: "waiting_model",
              parentNodeId: "batch-1",
              objective: "Implement batch 1",
            },
          },
        };
        return makeSseResponse([
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: "call_read",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"a.txt"}',
                  },
                }],
              },
            }],
          },
        ]);
      }
      const runtimeMsg = (body.messages || []).find((m) => (
        m.role === "user"
        && String(m.content || "").includes("Runtime events")
        && String(m.content || "").includes("task_started")
        && String(m.content || "").includes("trun_wake_1")
      ));
      expect(runtimeMsg).toBeTruthy();
      executionState.taskRuns.byId.trun_wake_1.status = "succeeded";
      executionState.taskRuns.byId.trun_wake_1.phase = "finalizing";
      return makeSseResponse([
        { choices: [{ delta: { content: "served task run" } }] },
      ]);
    });

    runToolCall.mockImplementation(() => ({ ok: true, content: "file" }));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "start work",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("served task run");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(executionState.agentMailbox.queue).toHaveLength(0);
  });

  test("auto-continues when TaskRun is waiting_model after text-only turn", async () => {
    const executionState = emptyExecutionState();
    executionState.taskRuns = {
      byId: {
        trun_wait: {
          id: "trun_wait",
          status: "running",
          phase: "waiting_model",
          parentNodeId: "impl",
          objective: "Do the work",
          lastFocusText: "Focus: Do the work",
        },
      },
    };
    let turn = 0;
    global.fetch.mockImplementation(async (_url, init) => {
      turn += 1;
      const body = JSON.parse(String(init && init.body || "{}"));
      const msgs = body.messages || [];
      // TaskFocus isolation: provider sees a fresh one-message turn, not the
      // accumulating Agent Loop transcript.
      expect(msgs).toHaveLength(1);
      expect(String(msgs[0].content || "")).toMatch(/Isolated TaskFocus turn/);
      expect(String(msgs[0].content || "")).toMatch(/trun_wait|Runtime wake|Do the work/);
      if (turn === 1) {
        return makeSseResponse([
          { choices: [{ delta: { content: "I started a task." } }] },
        ]);
      }
      executionState.taskRuns.byId.trun_wait.status = "succeeded";
      executionState.taskRuns.byId.trun_wait.phase = "finalizing";
      return makeSseResponse([
        { choices: [{ delta: { content: "continuing task" } }] },
      ]);
    });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "openai",
      model: "gpt-test",
      messages: [
        { role: "user", content: "earlier context that must not enter TaskFocus" },
        { role: "assistant", content: "ok" },
      ],
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("continuing task");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // Durable transcript keeps prior Agent Loop history.
    expect(result.messages.some((m) => String(m.content || "").includes("earlier context"))).toBe(true);
  });

  test("preserves tool calls and results across multi-step TaskFocus episodes and completes TaskLoop cleanly", async () => {
    const executionState = emptyExecutionState();
    runToolCall.mockImplementation(({ tool, args }) => ({
      ok: true,
      summary: `${tool} ${args && args.path || ""}`.trim(),
      output: { ok: true },
    }));

    let step = 0;
    let taskRunId = "";
    let childGraphId = "";

    global.fetch.mockImplementation(async (_url, init) => {
      step += 1;
      const body = JSON.parse(String(init && init.body || "{}"));
      const msgs = body.messages || [];

      if (step === 1) {
        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_create",
                type: "function",
                function: {
                  name: "plan_graph",
                  arguments: JSON.stringify({
                    operation: "create",
                    graph: {
                      objective: "Build 3D pelican page",
                      nodes: [{
                        id: "impl",
                        type: "task",
                        title: "Implement 3D pelican page",
                        objective: "Create index.html",
                        execution: { kind: "task_loop" },
                      }],
                    },
                  }),
                },
              }],
            },
          }],
        }]);
      }

      if (step === 2) {
        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_start",
                type: "function",
                function: {
                  name: "plan_graph",
                  arguments: JSON.stringify({
                    operation: "control",
                    actions: [{ op: "start_task", nodeId: "impl" }],
                  }),
                },
              }],
            },
          }],
        }]);
      }

      if (step === 3) {
        // First step of TaskRun TaskFocus episode: 1 isolated message, prior transcript excluded.
        expect(msgs).toHaveLength(1);
        expect(String(msgs[0].content || "")).toMatch(/Isolated TaskFocus turn/);
        const activeRuns = Object.values(executionState.taskRuns.byId);
        expect(activeRuns).toHaveLength(1);
        taskRunId = activeRuns[0].id;
        childGraphId = activeRuns[0].childGraphId;
        // Simulate an initially invalid patch (missing required args field) to prove error history is retained!
        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_bad_patch",
                type: "function",
                function: {
                  name: "plan_graph",
                  arguments: JSON.stringify({
                    operation: "patch",
                    graphId: childGraphId,
                    operations: [{
                      op: "expand_node",
                      nodeId: "root",
                      children: [{ id: "w1", type: "tool", tool: "write", arguments: { path: "index.html", content: "<h1>Pelican</h1>" } }],
                    }],
                  }),
                },
              }],
            },
          }],
        }]);
      }

      if (step === 4) {
        // Must retain the rejected tool call & result from step 3 instead of wiping back to 1 message!
        expect(msgs.length).toBeGreaterThanOrEqual(3);
        expect(String(msgs[0].content || "")).toMatch(/Isolated TaskFocus turn/);
        const lastTool = msgs.filter((m) => m.role === "tool").pop();
        expect(lastTool).toBeTruthy();
        expect(String(lastTool.content || "")).toMatch(/rejected|args/i);

        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_good_patch",
                type: "function",
                function: {
                  name: "plan_graph",
                  arguments: JSON.stringify({
                    operation: "patch",
                    graphId: childGraphId,
                    operations: [{
                      op: "expand_node",
                      nodeId: "root",
                      children: [{ id: "w1", type: "tool", tool: "write", args: { path: "index.html", content: "<h1>Pelican</h1>" } }],
                    }],
                  }),
                },
              }],
            },
          }],
        }]);
      }

      if (step === 5) {
        const lastTool = msgs.filter((m) => m.role === "tool").pop();
        expect(lastTool).toBeTruthy();
        const parsedTool = JSON.parse(String(lastTool.content || "{}"));
        expect(parsedTool.awaitingCompleteTask).toBe(true);
        expect(parsedTool.taskRunId).toBe(taskRunId);

        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_complete",
                type: "function",
                function: {
                  name: "plan_graph",
                  arguments: JSON.stringify({
                    operation: "control",
                    actions: [{
                      op: "complete_task",
                      taskRunId,
                      result: { summary: "Built interactive 3D pelican page" },
                    }],
                  }),
                },
              }],
            },
          }],
        }]);
      }

      return makeSseResponse([
        { choices: [{ delta: { content: "3D pelican page completed!" } }] },
      ]);
    });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "实现一个鹈鹕骑自行车的 3D 网页",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("3D pelican page completed!");
    expect(executionState.taskRuns.byId[taskRunId].status).toBe("succeeded");
    expect(executionState.planGraph.graphId).toBeFalsy();
  });

  test("allows direct read exploration while active plan waits on a task, but blocks direct write", async () => {
    const executionState = emptyExecutionState();
    runToolCall.mockImplementation(({ tool }) => ({
      ok: true,
      content: tool === "read" ? "doc contents" : "ok",
    }));

    let step = 0;
    global.fetch.mockImplementation(async (_url, init) => {
      step += 1;
      const body = JSON.parse(String(init && init.body || "{}"));
      const msgs = body.messages || [];

      if (step === 1) {
        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_plan_create",
                type: "function",
                function: {
                  name: "plan_graph",
                  arguments: JSON.stringify({
                    operation: "create",
                    graph: {
                      objective: "Inspect then finish",
                      nodes: [{ id: "t1", type: "task", title: "Review docs", execution: { kind: "inline_llm" } }],
                    },
                  }),
                },
              }],
            },
          }],
        }]);
      }

      if (step === 2) {
        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_read_ok",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
                },
                {
                  index: 1,
                  id: "call_write_blocked",
                  type: "function",
                  function: { name: "write", arguments: JSON.stringify({ path: "x.txt", content: "no" }) },
                },
              ],
            },
          }],
        }]);
      }

      if (step === 3) {
        const toolResults = msgs.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
        expect(toolResults[0].ok).toBe(true);
        expect(toolResults[1].ok).toBe(false);
        expect(toolResults[1].errors[0].code).toBe("ACTIVE_PLAN_REQUIRES_EXPANSION");

        return makeSseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_done",
                type: "function",
                function: {
                  name: "plan_graph",
                  arguments: JSON.stringify({
                    operation: "control",
                    actions: [{ op: "complete_task", nodeId: "t1", summary: "Reviewed" }],
                  }),
                },
              }],
            },
          }],
        }]);
      }

      return makeSseResponse([{ choices: [{ delta: { content: "All done" } }] }]);
    });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "review and complete",
      provider: "openai",
      model: "gpt-test",
      executionState,
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("All done");
  });
});

describe("busy submit enqueue helper path", () => {
  test("enqueue mirrors TUI busy-submit behavior", () => {
    const state = { executionState: emptyExecutionState() };
    const queued = enqueueUserPrompt(state.executionState, "mid-run hint");
    expect(queued.enqueued).toBe(true);
    expect(state.executionState.pendingUserPrompts).toHaveLength(1);
    expect(state.executionState.pendingUserPrompts[0].text).toBe("mid-run hint");
  });

  test("UcodeController drainQueuedPrompts extracts pending prompt tasks for Alt+Enter immediate injection", async () => {
    const { createUcodeController } = require("../../../src/code/UcodeController");
    const controller = createUcodeController({ projectRoot: process.cwd() });
    controller.start();

    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const p1 = controller.runExclusive(async () => {
      await firstGate;
      return { ok: true, id: 1 };
    }, { kind: "prompt", label: "first", promptText: "first prompt" });

    const p2 = controller.runExclusive(async () => ({ ok: true, id: 2 }), {
      kind: "prompt",
      label: "second",
      promptText: "second prompt",
    });
    const p3 = controller.runExclusive(async () => ({ ok: true, id: 3 }), {
      kind: "prompt",
      label: "third",
      promptText: "third prompt",
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(controller.getQueueSnapshot().queuedCount).toBe(2);

    const drained = controller.drainQueuedPrompts();
    expect(drained.map((item) => item.text)).toEqual(["second prompt", "third prompt"]);
    expect(controller.getQueueSnapshot().queuedCount).toBe(0);

    await expect(p2).resolves.toEqual({ ok: true, injected: true });
    await expect(p3).resolves.toEqual({ ok: true, injected: true });

    releaseFirst();
    await expect(p1).resolves.toEqual({ ok: true, id: 1 });
  });
});

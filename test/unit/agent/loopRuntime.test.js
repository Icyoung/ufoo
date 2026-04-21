"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { runPromptWithControllerLoop } = require("../../../src/agent/loopRuntime");
const { getLoopObservabilityPaths } = require("../../../src/agent/loopObservability");

describe("agent loopRuntime", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-loop-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("executes controller tool calls and emits observability/audit files", async () => {
    const runUfooAgent = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "dispatching",
          done: false,
          dispatch: [],
          ops: [],
          tool_call: {
            id: "tool-1",
            name: "dispatch_message",
            arguments: {
              target: "codex:1",
              message: "handle it",
            },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "done",
          done: true,
          dispatch: [],
          ops: [],
        },
      });
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([]);
    const markPending = jest.fn();

    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "route task",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages,
      handleOps,
      markPending,
      loopRuntime: {
        enabled: true,
        maxRounds: 3,
        maxToolCalls: 2,
      },
    });

    expect(result.ok).toBe(true);
    expect(dispatchMessages).toHaveBeenCalledWith(projectRoot, [{
      target: "codex:1",
      message: "handle it",
      injection_mode: "immediate",
      source: "ufoo-agent",
    }]);
    expect(markPending).toHaveBeenCalledWith("codex:1");
    expect(result.payload.loop).toEqual(expect.objectContaining({
      terminal_reason: "final_answer",
      rounds: 2,
      tool_calls: 1,
      fallback_used: "none",
      total_tokens: expect.any(Number),
      total_latency_ms: expect.any(Number),
    }));

    const { eventsFile, auditFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const audit = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));

    expect(events.some((row) => row.event === "model_call_started")).toBe(true);
    expect(events.some((row) => row.event === "model_call"
      && Object.prototype.hasOwnProperty.call(row, "input_tokens")
      && Object.prototype.hasOwnProperty.call(row, "output_tokens")
      && Object.prototype.hasOwnProperty.call(row, "cache_read_tokens")
      && Object.prototype.hasOwnProperty.call(row, "cache_creation_tokens")
      && Object.prototype.hasOwnProperty.call(row, "latency_ms")
      && Object.prototype.hasOwnProperty.call(row, "first_token_ms")
      && Object.prototype.hasOwnProperty.call(row, "tool_call_count")
      && Object.prototype.hasOwnProperty.call(row, "stop_reason")
      && Object.prototype.hasOwnProperty.call(row, "error"))).toBe(true);
    expect(events.some((row) => row.event === "tool_call"
      && Object.prototype.hasOwnProperty.call(row, "tool_name")
      && Object.prototype.hasOwnProperty.call(row, "tool_call_id")
      && Object.prototype.hasOwnProperty.call(row, "duration_ms")
      && Object.prototype.hasOwnProperty.call(row, "result_size")
      && Object.prototype.hasOwnProperty.call(row, "retry_count")
      && Object.prototype.hasOwnProperty.call(row, "final_status"))).toBe(true);
    expect(events.some((row) => row.event === "tool_call_finished" && row.ok === true)).toBe(true);
    expect(events.some((row) => row.event === "loop_terminal"
      && row.terminal_reason === "final_answer"
      && row.fallback_used === "none"
      && Object.prototype.hasOwnProperty.call(row, "total_tokens")
      && Object.prototype.hasOwnProperty.call(row, "total_latency_ms"))).toBe(true);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual(expect.objectContaining({
      kind: "tool_call",
      tool_name: "dispatch_message",
      ok: true,
    }));
  });

  test("feeds structured tool errors into the next loop round", async () => {
    const runUfooAgent = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "trying ack",
          done: false,
          dispatch: [],
          ops: [],
          tool_call: {
            id: "tool-err",
            name: "ack_bus",
            arguments: {
              subscriber: "codex:not-ufoo-agent",
            },
          },
        },
      })
      .mockImplementationOnce(async ({ prompt }) => {
        expect(prompt).toContain("\"ok\": false");
        expect(prompt).toContain("\"code\": \"forbidden_ack\"");
        return {
          ok: true,
          payload: {
            reply: "fallback reply",
            done: true,
            dispatch: [],
            ops: [],
          },
        };
      });

    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "ack queue",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages: jest.fn(),
      handleOps: jest.fn().mockResolvedValue([]),
      loopRuntime: {
        enabled: true,
        maxRounds: 3,
        maxToolCalls: 2,
        maxToolErrors: 2,
      },
    });

    expect(result.ok).toBe(true);
    expect(runUfooAgent).toHaveBeenCalledTimes(2);
    expect(result.payload.reply).toBe("fallback reply");
    expect(result.payload.loop.terminal_reason).toBe("final_answer");
    expect(result.payload.loop.fallback_used).toBe("none");
  });

  test("stops with budget_exhausted when continuation prompt exceeds configured budget", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "x".repeat(200),
        done: false,
        dispatch: [],
        ops: [],
        tool_call: {
          id: "tool-1",
          name: "dispatch_message",
          arguments: {
            target: "broadcast",
            message: "hi",
          },
        },
      },
    });

    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "budget test",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages: jest.fn().mockResolvedValue(undefined),
      handleOps: jest.fn().mockResolvedValue([]),
      loopRuntime: {
        enabled: true,
        maxRounds: 3,
        maxToolCalls: 2,
        maxPromptChars: 80,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.payload.loop).toEqual(expect.objectContaining({
      terminal_reason: "budget_exceeded",
      tool_calls: 1,
      fallback_used: "none",
    }));
  });

  test("applies observability defaults to loop events", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "done",
        done: true,
        dispatch: [],
        ops: [],
      },
    });

    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "shadow loop",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages: jest.fn(),
      handleOps: jest.fn().mockResolvedValue([]),
      loopRuntime: {
        enabled: true,
        maxRounds: 2,
      },
      observabilityDefaults: {
        shadow_only: true,
        controller_mode: "shadow",
      },
    });

    expect(result.ok).toBe(true);
    const { eventsFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.every((row) => row.shadow_only === true && row.controller_mode === "shadow")).toBe(true);
  });

  test("terminates with user_cancel when isCancelled returns true", async () => {
    let cancelFlag = false;
    const runUfooAgent = jest.fn().mockImplementation(async () => {
      cancelFlag = true;
      return {
        ok: true,
        payload: {
          reply: "",
          done: false,
          dispatch: [],
          ops: [],
          tool_call: { id: "t1", name: "dispatch_message", arguments: { target: "broadcast", message: "x" } },
        },
      };
    });

    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "cancel me",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages: jest.fn().mockResolvedValue(undefined),
      handleOps: jest.fn().mockResolvedValue([]),
      loopRuntime: { enabled: true, maxRounds: 3, maxToolCalls: 2 },
      isCancelled: () => cancelFlag,
    });

    expect(result.ok).toBe(true);
    expect(result.payload.loop.terminal_reason).toBe("user_cancel");
    expect(result.payload.loop.fallback_used).toBe("none");
  });

  test("terminates with provider_error when runUfooAgent fails", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({ ok: false, error: "provider down" });
    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "boom",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages: jest.fn(),
      handleOps: jest.fn().mockResolvedValue([]),
      loopRuntime: { enabled: true, maxRounds: 2 },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("provider down");
    const { eventsFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.some((row) => row.event === "loop_terminal"
      && row.terminal_reason === "provider_error"
      && row.fallback_used === "none")).toBe(true);
  });

  test("terminates with tool_failure after repeated tool errors", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "",
        done: false,
        dispatch: [],
        ops: [],
        tool_call: { id: "t-err", name: "ack_bus", arguments: { subscriber: "other:1" } },
      },
    });

    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "fail loop",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages: jest.fn(),
      handleOps: jest.fn().mockResolvedValue([]),
      loopRuntime: { enabled: true, maxRounds: 5, maxToolCalls: 5, maxToolErrors: 2 },
    });

    expect(result.ok).toBe(true);
    expect(result.payload.loop.terminal_reason).toBe("tool_failure");
    expect(result.payload.loop.fallback_used).toBe("none");
  });

  test("propagates provider metrics into model_call event and loop totals", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      meta: {
        input_tokens: 120,
        output_tokens: 45,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        latency_ms: 777,
        first_token_ms: 190,
        stop_reason: "end_turn",
      },
      payload: { reply: "final", done: true, dispatch: [], ops: [] },
    });

    const result = await runPromptWithControllerLoop({
      projectRoot,
      prompt: "metrics",
      provider: "claude-api",
      model: "claude-sonnet",
      runUfooAgent,
      dispatchMessages: jest.fn(),
      handleOps: jest.fn().mockResolvedValue([]),
      loopRuntime: { enabled: true, maxRounds: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.payload.loop.total_tokens).toBe(165);
    expect(result.payload.loop.total_latency_ms).toBe(777);
    const { eventsFile } = getLoopObservabilityPaths(projectRoot);
    const events = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const modelCall = events.find((row) => row.event === "model_call");
    expect(modelCall).toEqual(expect.objectContaining({
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 10,
      cache_creation_tokens: 5,
      latency_ms: 777,
      first_token_ms: 190,
      stop_reason: "end_turn",
      tool_call_count: 0,
    }));
  });
});

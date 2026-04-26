const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/agent/cliRunner", () => ({
  runCliAgent: jest.fn(),
}));

jest.mock("../../../src/agent/normalizeOutput", () => ({
  normalizeCliOutput: jest.fn(),
}));

jest.mock("../../../src/agent/codexThreadProvider", () => ({
  createCodexThreadProvider: jest.fn(),
  defaultCodexTransportStreamFactory: jest.fn(),
}));

jest.mock("../../../src/agent/claudeThreadProvider", () => ({
  createClaudeThreadProvider: jest.fn(),
  defaultClaudeTransportStreamFactory: jest.fn(),
}));

jest.mock("../../../src/agent/credentials/claude", () => ({
  resolveClaudeUpstreamCredentials: jest.fn(),
}));

const { runCliAgent } = require("../../../src/agent/cliRunner");
const { normalizeCliOutput } = require("../../../src/agent/normalizeOutput");
const { createCodexThreadProvider } = require("../../../src/agent/codexThreadProvider");
const { createClaudeThreadProvider } = require("../../../src/agent/claudeThreadProvider");
const { resolveClaudeUpstreamCredentials } = require("../../../src/agent/credentials/claude");
const {
  handleEvent,
  createBusSender,
  createThreadRuntime,
  getCodexThreadMode,
  getWorkerThreadToolMode,
  buildWorkerThreadToolRuntime,
  normalizeWorkerThreadToolMode,
  getClaudeThreadMode,
  buildClaudeAuthProvider,
  shouldFallbackToLegacyThreadProvider,
} = require("../../../src/agent/internalRunner");

describe("agent internalRunner stream forwarding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("forwards stream delta envelopes and done marker", async () => {
    runCliAgent.mockImplementationOnce(async (params) => {
      params.onStreamDelta("hello");
      params.onStreamDelta(" world");
      return { ok: true, output: [{ item: { type: "agent_message", text: "hello world" } }], sessionId: "sess-1" };
    });
    normalizeCliOutput.mockReturnValue("hello world");

    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:1", data: { message: "say hi" } };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "gpt-5.2-codex",
      "codex:abc",
      "codex-1",
      evt,
      state,
      busSender
    );

    expect(busSender.enqueue).toHaveBeenCalledWith("chat:1", JSON.stringify({ stream: true, delta: "hello" }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:1", JSON.stringify({ stream: true, delta: " world" }));
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:1",
      JSON.stringify({ stream: true, done: true, reason: "complete" })
    );
    expect(busSender.enqueue).not.toHaveBeenCalledWith("chat:1", "hello world");
    expect(busSender.flush).toHaveBeenCalled();
  });

  test("falls back to plain reply when no stream delta exists", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: true, output: [{ item: { type: "agent_message", text: "done" } }] });
    normalizeCliOutput.mockReturnValueOnce("done");

    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:2", data: { message: "task" } };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "gpt-5.2-codex",
      "codex:def",
      "codex-2",
      evt,
      state,
      busSender
    );

    expect(busSender.enqueue).toHaveBeenCalledTimes(1);
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:2", "done");
    expect(busSender.flush).toHaveBeenCalled();
  });

  test("appends error to stream and sends done:error on failure", async () => {
    runCliAgent.mockImplementationOnce(async (params) => {
      params.onStreamDelta("partial");
      return { ok: false, error: "boom" };
    });
    normalizeCliOutput.mockReturnValue("");

    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:3", data: { message: "task" } };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "gpt-5.2-codex",
      "codex:ghi",
      "codex-3",
      evt,
      state,
      busSender
    );

    expect(busSender.enqueue).toHaveBeenCalledWith("chat:3", JSON.stringify({ stream: true, delta: "partial" }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:3", JSON.stringify({ stream: true, delta: "\n" }));
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:3",
      JSON.stringify({ stream: true, delta: "[internal:codex] error: boom" })
    );
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:3",
      JSON.stringify({ stream: true, done: true, reason: "error" })
    );
  });

  test("skips event with no data or message", async () => {
    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:x", "n", null, state, busSender);
    expect(busSender.enqueue).not.toHaveBeenCalled();

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:x", "n", { data: {} }, state, busSender);
    expect(busSender.enqueue).not.toHaveBeenCalled();
  });

  test("sends plain error reply when no stream and error", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: false, error: "fail" });
    normalizeCliOutput.mockReturnValueOnce("");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:4", data: { message: "do" } };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:y", "n", evt, state, busSender);

    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:4",
      "[internal:codex] error: fail"
    );
  });

  test("skips enqueue when reply is empty and no stream", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: true, output: "" });
    normalizeCliOutput.mockReturnValueOnce("");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:5", data: { message: "do" } };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:z", "n", evt, state, busSender);

    expect(busSender.enqueue).not.toHaveBeenCalled();
  });

  test("retries with new session on claude session errors", async () => {
    runCliAgent
      .mockResolvedValueOnce({ ok: false, error: "session already in use" })
      .mockResolvedValueOnce({ ok: true, output: "ok", sessionId: "new-sess" });
    normalizeCliOutput.mockReturnValue("ok");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: "old-sess", needsSave: false };
    const evt = { publisher: "chat:6", data: { message: "do" } };

    await handleEvent("/tmp", "claude-code", "claude-cli", "", "claude:a", "n", evt, state, busSender);

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    expect(state.cliSessionId).toBe("new-sess");
    expect(state.needsSave).toBe(true);
  });

  test("updates session ID on successful claude response", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: true, output: "done", sessionId: "sess-42" });
    normalizeCliOutput.mockReturnValue("done");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:7", data: { message: "task" } };

    await handleEvent("/tmp", "claude-code", "claude-cli", "", "claude:b", "n", evt, state, busSender);

    expect(state.cliSessionId).toBe("sess-42");
    expect(state.needsSave).toBe(true);
  });

  test("passes extra args through to runCliAgent", async () => {
    runCliAgent.mockResolvedValueOnce({ ok: true, output: "done" });
    normalizeCliOutput.mockReturnValue("done");

    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:8", data: { message: "task" } };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "",
      "codex:c8",
      "codex-8",
      evt,
      state,
      busSender,
      ["--model", "gpt-5.4-mini", "--approval-mode", "full-auto"]
    );

    expect(runCliAgent).toHaveBeenCalledWith(expect.objectContaining({
      extraArgs: ["--model", "gpt-5.4-mini", "--approval-mode", "full-auto"],
    }));
  });

  test("uses codex thread runtime when enabled", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:9", data: { message: "task" } };
    const threadRuntime = {
      enabled: true,
      thread: {
        runStreamed: jest.fn(async function* () {
          yield { type: "text_delta", delta: "hello " };
          yield { type: "text_delta", delta: "sdk" };
        }),
      },
      rebuildThread: jest.fn(async () => {}),
    };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "",
      "codex:sdk",
      "codex-sdk",
      evt,
      state,
      busSender,
      [],
      threadRuntime
    );

    expect(runCliAgent).not.toHaveBeenCalled();
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:9", JSON.stringify({ stream: true, delta: "hello " }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:9", JSON.stringify({ stream: true, delta: "sdk" }));
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:9",
      JSON.stringify({ stream: true, done: true, reason: "complete" })
    );
  });

  test("rebuilds codex thread after threaded failure", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:10", data: { message: "task" } };
    const threadRuntime = {
      enabled: true,
      thread: {
        runStreamed: jest.fn(async function* () {
          yield { type: "turn_failed", error: "sdk boom" };
        }),
      },
      rebuildThread: jest.fn(async () => {}),
    };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "",
      "codex:sdk2",
      "codex-sdk-2",
      evt,
      state,
      busSender,
      [],
      threadRuntime
    );

    expect(threadRuntime.rebuildThread).toHaveBeenCalled();
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:10",
      JSON.stringify({ stream: true, delta: "[internal:codex] error: sdk boom" })
    );
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:10",
      JSON.stringify({ stream: true, done: true, reason: "error" })
    );
  });

  test("reports threaded auth errors without legacy CLI fallback", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const state = { cliSessionId: null, needsSave: false };
    const evt = { publisher: "chat:11", data: { message: "task" } };
    const threadRuntime = {
      enabled: true,
      thread: {
        runStreamed: jest.fn(async function* () {
          const error = new Error("oauth unavailable");
          error.code = "CLAUDE_AUTH_UNAVAILABLE";
          throw error;
        }),
      },
      rebuildThread: jest.fn(async () => {}),
    };

    await handleEvent(
      process.cwd(),
      "claude-code",
      "claude-cli",
      "",
      "claude:fallback",
      "claude-fallback",
      evt,
      state,
      busSender,
      ["--dangerously-skip-permissions"],
      threadRuntime
    );

    expect(threadRuntime.rebuildThread).toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:11",
      JSON.stringify({ stream: true, delta: "[internal:claude-code] error: oauth unavailable" })
    );
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:11",
      JSON.stringify({ stream: true, done: true, reason: "error" })
    );
  });
});

describe("createBusSender", () => {
  test("enqueue and flush work without errors", async () => {
    // createBusSender needs a real project root with bus init
    // Just test that it creates the interface
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-irunner-"));
    try {
      const sender = createBusSender(tmpDir, "codex:test");
      expect(typeof sender.enqueue).toBe("function");
      expect(typeof sender.flush).toBe("function");
      // Enqueue with empty target does nothing
      sender.enqueue("", "");
      await sender.flush();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("internalRunner codex thread mode", () => {
  const originalEnv = process.env.UFOO_CODEX_INTERNAL_THREAD_MODE;
  const originalToolEnv = process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS;
  const originalClaudeEnv = process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE;

  afterEach(() => {
    if (typeof originalEnv === "undefined") {
      delete process.env.UFOO_CODEX_INTERNAL_THREAD_MODE;
    } else {
      process.env.UFOO_CODEX_INTERNAL_THREAD_MODE = originalEnv;
    }
    if (typeof originalToolEnv === "undefined") {
      delete process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS;
    } else {
      process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS = originalToolEnv;
    }
    if (typeof originalClaudeEnv === "undefined") {
      delete process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE;
    } else {
      process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE = originalClaudeEnv;
    }
    jest.clearAllMocks();
  });

  test("defaults to direct API mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-config-"));
    expect(getCodexThreadMode(projectRoot)).toBe("api");
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("env override keeps sdk as a compatibility alias for api mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-config-env-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_MODE = "sdk";
    expect(getCodexThreadMode(projectRoot)).toBe("api");
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("worker tool mode stays disabled by default and normalizes explicit enablement", () => {
    expect(getWorkerThreadToolMode()).toBe("disabled");
    expect(normalizeWorkerThreadToolMode("worker-tier01")).toBe("worker-tier01");
    expect(normalizeWorkerThreadToolMode("enabled")).toBe("worker-tier01");
    expect(normalizeWorkerThreadToolMode("legacy")).toBe("disabled");
  });

  test("createThreadRuntime stays disabled for legacy mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-legacy-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_MODE = "legacy";
    const runtime = createThreadRuntime({
      projectRoot,
      provider: "codex-cli",
      model: "gpt-5-codex",
      extraArgs: [],
      subscriber: "codex:legacy",
    });

    expect(runtime.enabled).toBe(false);
    expect(createCodexThreadProvider).not.toHaveBeenCalled();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("createThreadRuntime builds codex direct thread provider in api mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-sdk-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_MODE = "api";

    createCodexThreadProvider.mockReturnValue({
      startThread: jest.fn(() => ({
        runStreamed: async function* () {},
        close: jest.fn(async () => {}),
      })),
    });

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "codex-cli",
      model: "gpt-5-codex",
      extraArgs: ["--model", "gpt-5-codex"],
      subscriber: "codex:sdk",
    });

    expect(runtime.enabled).toBe(true);
    expect(createCodexThreadProvider).toHaveBeenCalledWith({
      model: "gpt-5-codex",
      cwd: projectRoot,
      extraArgs: ["--model", "gpt-5-codex"],
      tools: [],
      streamFactory: expect.any(Function),
    });

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("createThreadRuntime falls back to disabled when Codex seam creation throws", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-sdk-fallback-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_MODE = "api";
    createCodexThreadProvider.mockImplementation(() => {
      throw new Error("sdk missing");
    });

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "codex-cli",
      model: "gpt-5-codex",
      extraArgs: [],
      subscriber: "codex:sdk-fallback",
    });

    expect(runtime.enabled).toBe(false);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("buildWorkerThreadToolRuntime exposes only worker tier tools", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-tools-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS = "worker-tier01";

    const runtime = buildWorkerThreadToolRuntime({
      projectRoot,
      subscriber: "codex:worker",
    });

    expect(runtime.enabled).toBe(true);
    expect(runtime.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "read_bus_summary",
      "read_prompt_history",
      "read_open_decisions",
      "list_agents",
      "read_project_registry",
      "route_agent",
      "dispatch_message",
      "ack_bus",
    ]));
    expect(runtime.tools.some((tool) => tool.name === "launch_agent")).toBe(false);

    const unsupported = await runtime.executeToolCall({
      name: "launch_agent",
      arguments: { agent: "codex" },
    });
    expect(unsupported).toEqual({
      ok: false,
      error: {
        code: "unsupported_tool",
        message: "worker tool is unavailable: launch_agent",
      },
    });

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("worker tool runtime fires observer hook with redacted pre-call and post-call payloads (§10.7 slice 1)", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-redact-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS = "worker-tier01";

    const events = [];
    const runtime = buildWorkerThreadToolRuntime({
      projectRoot,
      subscriber: "codex:worker-redact",
      observer: {
        onToolCall: (event) => events.push(event),
      },
    });

    await runtime.executeToolCall({
      name: "launch_agent",
      arguments: {
        agent: "codex",
        headers: { Authorization: "Bearer leak-me" },
        accessToken: "also-leak",
      },
      tool_call_id: "call-redact-1",
    });

    expect(events.length).toBeGreaterThanOrEqual(2);
    const preCall = events.find((e) => e.phase === "pre_call");
    expect(preCall.payload.name).toBe("launch_agent");
    expect(preCall.payload.caller_tier).toBe("worker");
    expect(preCall.payload.tool_call_id).toBe("call-redact-1");
    expect(preCall.payload.args.headers.Authorization).toBe("[REDACTED]");
    expect(preCall.payload.args.accessToken).toBe("[REDACTED]");
    expect(preCall.payload.args.agent).toBe("codex");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("worker thread tool runtime executes shared handlers with caller-owned context", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-handler-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS = "worker-tier01";
    const EventBus = require("../../../src/bus");
    const eventBus = new EventBus(projectRoot);
    await eventBus.init();
    const sender = await eventBus.join("sender", "codex", "sender");
    const receiver = await eventBus.join("receiver", "claude-code", "receiver");

    const runtime = buildWorkerThreadToolRuntime({
      projectRoot,
      subscriber: sender,
    });

    const result = await runtime.executeToolCall({
      name: "dispatch_message",
      arguments: {
        target: receiver,
        message: "worker hello",
        source: sender,
      },
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      target: receiver,
      source: sender,
      delivered: 1,
    }));

    const badAck = await runtime.executeToolCall({
      name: "ack_bus",
      arguments: { subscriber: receiver },
    });
    expect(badAck).toEqual({
      ok: false,
      error: {
        code: "forbidden_ack",
        message: "ack_bus can only acknowledge the caller subscriber queue",
      },
    });

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("createThreadRuntime injects worker tier tools only when the tool flag is enabled", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-sdk-tools-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_MODE = "api";
    process.env.UFOO_CODEX_INTERNAL_THREAD_TOOLS = "worker-tier01";

    createCodexThreadProvider.mockReturnValue({
      startThread: jest.fn(() => ({
        runStreamed: async function* () {},
        close: jest.fn(async () => {}),
      })),
    });

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "codex-cli",
      model: "gpt-5-codex",
      extraArgs: [],
      subscriber: "codex:worker-tools",
    });

    expect(runtime.enabled).toBe(true);
    expect(runtime.toolRuntime).toEqual(expect.objectContaining({
      enabled: true,
      mode: "worker-tier01",
    }));
    expect(createCodexThreadProvider).toHaveBeenCalledWith(expect.objectContaining({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "route_agent" }),
        expect.objectContaining({ name: "dispatch_message" }),
        expect.objectContaining({ name: "ack_bus" }),
      ]),
    }));
    expect(createCodexThreadProvider.mock.calls[0][0].tools.some((tool) => tool.name === "launch_agent")).toBe(false);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("claude thread mode defaults to legacy", () => {
    delete process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE;
    expect(getClaudeThreadMode()).toBe("legacy");
  });

  test("env override enables Claude API thread mode", () => {
    process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE = "api";
    expect(getClaudeThreadMode()).toBe("api");
  });

  test("buildClaudeAuthProvider uses oauth reader config seam", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-claude-auth-"));
    resolveClaudeUpstreamCredentials.mockResolvedValue({
      provider: "claude",
      credentialKind: "oauth",
      accessToken: "oauth-token",
      tokenType: "Bearer",
    });

    const authProvider = buildClaudeAuthProvider(projectRoot);
    await expect(authProvider()).resolves.toEqual({
      headers: {
        authorization: "Bearer oauth-token",
      },
    });
    expect(resolveClaudeUpstreamCredentials).toHaveBeenCalledWith(expect.objectContaining({
      profile: "",
      tokenPath: "",
      refreshWindowMs: 300000,
    }));

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("createThreadRuntime stays disabled for Claude legacy mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-claude-legacy-"));
    delete process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE;

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "claude-cli",
      model: "claude-sonnet",
      extraArgs: [],
    });

    expect(runtime.enabled).toBe(false);
    expect(createClaudeThreadProvider).not.toHaveBeenCalled();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("createThreadRuntime builds Claude thread provider in api mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-claude-api-"));
    process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE = "api";

    createClaudeThreadProvider.mockReturnValue({
      startThread: jest.fn(() => ({
        runStreamed: async function* () {},
        close: jest.fn(async () => {}),
      })),
    });

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "claude-cli",
      model: "claude-sonnet",
      extraArgs: [],
    });

    expect(runtime.enabled).toBe(true);
    expect(createClaudeThreadProvider).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-sonnet",
      authProvider: expect.any(Function),
    }));

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("createThreadRuntime falls back to disabled when Claude seam creation throws", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-claude-fallback-"));
    process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE = "api";
    createClaudeThreadProvider.mockImplementation(() => {
      throw new Error("sdk missing");
    });

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "claude-cli",
      model: "claude-sonnet",
      extraArgs: [],
    });

    expect(runtime.enabled).toBe(false);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("threaded direct providers do not fall back to legacy CLI", () => {
    expect(shouldFallbackToLegacyThreadProvider({ code: "CLAUDE_AUTH_UNAVAILABLE" }, "claude-cli")).toBe(false);
    expect(shouldFallbackToLegacyThreadProvider({ code: "claude_oauth_schema_unsupported" }, "claude-cli")).toBe(false);
    expect(shouldFallbackToLegacyThreadProvider({ code: "ANTHROPIC_SDK_UNAVAILABLE" }, "claude-cli")).toBe(false);
    expect(shouldFallbackToLegacyThreadProvider({ code: "ECONNRESET" }, "claude-cli")).toBe(false);
    expect(shouldFallbackToLegacyThreadProvider({ code: "CLAUDE_AUTH_UNAVAILABLE" }, "codex-cli")).toBe(false);
    expect(shouldFallbackToLegacyThreadProvider({ code: "CODEX_AUTH_UNAVAILABLE" }, "codex-cli")).toBe(false);
    expect(shouldFallbackToLegacyThreadProvider({ code: "CODEX_AUTH_REFRESH_FAILED" }, "codex-cli")).toBe(false);
    expect(shouldFallbackToLegacyThreadProvider({ code: "CODEX_UPSTREAM_FAILED" }, "codex-cli")).toBe(false);
  });
});

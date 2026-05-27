const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/agents/providers/codexThreadProvider", () => ({
  createCodexThreadProvider: jest.fn(),
}));

jest.mock("../../../src/agents/providers/claudeThreadProvider", () => ({
  createClaudeThreadProvider: jest.fn(),
}));

jest.mock("../../../src/agents/providers/credentials/claude", () => ({
  resolveClaudeUpstreamCredentials: jest.fn(),
}));

const { createCodexThreadProvider } = require("../../../src/agents/providers/codexThreadProvider");
const { createClaudeThreadProvider } = require("../../../src/agents/providers/claudeThreadProvider");
const { resolveClaudeUpstreamCredentials } = require("../../../src/agents/providers/credentials/claude");
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
  parseAgentViewRawInput,
  createInteractiveInputSession,
  resolveInternalBootstrap,
  persistProviderSessionId,
} = require("../../../src/agents/internal/internalRunner");
const { SHARED_UFOO_PROTOCOL } = require("../../../src/agents/prompts/groupBootstrap");

describe("agent internalRunner stream forwarding", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeProjectWithAgent(agentId = "codex:peer") {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-internal-runner-"));
    const agentsFile = path.join(projectRoot, ".ufoo", "agent", "all-agents.json");
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: {
        [agentId]: {
          agent_type: "codex",
          nickname: "peer",
          status: "active",
        },
      },
    }));
    return projectRoot;
  }

  test("skips event with no data or message", async () => {
    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:x", "n", null, busSender);
    expect(busSender.enqueue).not.toHaveBeenCalled();

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:x", "n", { data: {} }, busSender);
    expect(busSender.enqueue).not.toHaveBeenCalled();
  });

  test("reports missing thread runtime instead of using cli fallback", async () => {
    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const evt = { publisher: "chat:4", data: { message: "do" } };

    await handleEvent("/tmp", "codex", "codex-cli", "", "codex:y", "n", evt, busSender);

    expect(busSender.enqueue.mock.calls[0][0]).toBe("chat:4");
    expect(JSON.parse(busSender.enqueue.mock.calls[0][1])).toEqual({
      stream: true,
      delta: expect.stringContaining("cliRunner fallback has been removed"),
    });
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:4",
      JSON.stringify({ stream: true, done: true, reason: "error" })
    );
  });

  test("prefixes bootstrap text into thread runtime prompts", async () => {
    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const evt = { publisher: "chat:bootstrap", data: { message: "task body" } };
    const threadRuntime = {
      enabled: true,
      thread: {
        runStreamed: jest.fn(async function* () {
          yield { type: "text_delta", delta: "done" };
        }),
      },
    };

    await handleEvent(
      process.cwd(),
      "codex",
      "codex-cli",
      "",
      "codex:boot",
      "codex-boot",
      evt,
      busSender,
      ["--json"],
      threadRuntime,
      "ufoo protocol bootstrap"
    );

    expect(threadRuntime.thread.runStreamed).toHaveBeenCalledWith(
      expect.stringContaining("ufoo protocol bootstrap\n\n"),
      {}
    );
    expect(threadRuntime.thread.runStreamed.mock.calls[0][0]).toContain("task body");
  });

  test("wraps chat-direct thread prompts with manual envelope", async () => {
    const projectRoot = makeProjectWithAgent("codex:target");
    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const evt = {
      publisher: "ufoo-agent",
      target: "codex:target",
      data: { message: "task body", source: "chat-direct" },
    };
    const threadRuntime = {
      enabled: true,
      thread: {
        runStreamed: jest.fn(async function* () {
          yield { type: "text_delta", delta: "done" };
        }),
      },
    };

    try {
      await handleEvent(
        projectRoot,
        "codex",
        "codex-cli",
        "",
        "codex:target",
        "peer",
        evt,
        busSender,
        [],
        threadRuntime
      );

      expect(threadRuntime.thread.runStreamed.mock.calls[0][0]).toContain(
        "[manual]<to:codex:target(peer)>\ntask body"
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps raw agent-view submissions unwrapped for thread prompts", async () => {
    const projectRoot = makeProjectWithAgent("codex:target");
    const busSender = { enqueue: jest.fn(), flush: jest.fn(async () => {}) };
    const evt = {
      __agentViewRaw: true,
      publisher: "ufoo-agent",
      target: "codex:target",
      data: { message: "typed body", source: "chat-internal-agent-view" },
    };
    const threadRuntime = {
      enabled: true,
      thread: {
        runStreamed: jest.fn(async function* () {
          yield { type: "text_delta", delta: "done" };
        }),
      },
    };

    try {
      await handleEvent(
        projectRoot,
        "codex",
        "codex-cli",
        "",
        "codex:target",
        "peer",
        evt,
        busSender,
        [],
        threadRuntime
      );

      expect(threadRuntime.thread.runStreamed.mock.calls[0][0]).toContain("typed body");
      expect(threadRuntime.thread.runStreamed.mock.calls[0][0]).not.toContain("[manual]");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("uses codex thread runtime when enabled", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
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
      busSender,
      [],
      threadRuntime
    );

    expect(busSender.enqueue).toHaveBeenCalledWith("chat:9", JSON.stringify({ stream: true, delta: "hello " }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:9", JSON.stringify({ stream: true, delta: "sdk" }));
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "chat:9",
      JSON.stringify({ stream: true, done: true, reason: "complete" })
    );
  });

  test("thread runtime streams tool call hints to chat publishers", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const evt = { publisher: "chat:9", data: { message: "task" } };
    const threadRuntime = {
      enabled: true,
      thread: {
        runStreamed: jest.fn(async function* () {
          yield { type: "text_delta", delta: "before" };
          yield { type: "tool_call", name: "bash", args: { command: "npm test" } };
          yield { type: "text_delta", delta: "after" };
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
      busSender,
      [],
      threadRuntime
    );

    expect(busSender.enqueue).toHaveBeenCalledWith("chat:9", JSON.stringify({ stream: true, delta: "before" }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:9", JSON.stringify({ stream: true, delta: "\nTool: bash · npm test\n" }));
    expect(busSender.enqueue).toHaveBeenCalledWith("chat:9", JSON.stringify({ stream: true, delta: "after" }));
  });

  test("thread runtime sends a plain reply to managed agent publishers", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const projectRoot = makeProjectWithAgent("codex:peer");
    const evt = { publisher: "codex:peer", data: { message: "task" } };
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
      projectRoot,
      "codex",
      "codex-cli",
      "",
      "codex:sdk",
      "codex-sdk",
      evt,
      busSender,
      [],
      threadRuntime
    );

    expect(busSender.enqueue).toHaveBeenCalledTimes(1);
    expect(busSender.enqueue).toHaveBeenCalledWith("codex:peer", "hello sdk");
  });

  test("thread runtime streams replies for chat UI publishers even when managed", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
    const projectRoot = makeProjectWithAgent("ufoo-agent");
    const evt = {
      publisher: "ufoo-agent",
      data: {
        message: "task",
        source: "chat-internal-agent-view",
      },
    };
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
      projectRoot,
      "codex",
      "codex-cli",
      "",
      "codex:sdk",
      "codex-sdk",
      evt,
      busSender,
      [],
      threadRuntime
    );

    expect(busSender.enqueue).toHaveBeenCalledWith("ufoo-agent", JSON.stringify({ stream: true, delta: "hello " }));
    expect(busSender.enqueue).toHaveBeenCalledWith("ufoo-agent", JSON.stringify({ stream: true, delta: "sdk" }));
    expect(busSender.enqueue).toHaveBeenCalledWith(
      "ufoo-agent",
      JSON.stringify({ stream: true, done: true, reason: "complete" })
    );
  });

  test.each(["chat-agent-view", "ufoo-agent", "ufoo-agent-gate-router"])(
    "thread runtime streams replies for %s source through managed ufoo-agent",
    async (source) => {
      const busSender = {
        enqueue: jest.fn(),
        flush: jest.fn(async () => {}),
      };
      const projectRoot = makeProjectWithAgent("ufoo-agent");
      const evt = {
        publisher: "ufoo-agent",
        data: {
          message: "task",
          source,
        },
      };
      const threadRuntime = {
        enabled: true,
        thread: {
          runStreamed: jest.fn(async function* () {
            yield { type: "text_delta", delta: "ok" };
          }),
        },
        rebuildThread: jest.fn(async () => {}),
      };

      try {
        await handleEvent(
          projectRoot,
          "codex",
          "codex-cli",
          "",
          "codex:sdk",
          "codex-sdk",
          evt,
          busSender,
          [],
          threadRuntime
        );

        expect(busSender.enqueue).toHaveBeenCalledWith(
          "ufoo-agent",
          JSON.stringify({ stream: true, delta: "ok" })
        );
        expect(busSender.enqueue).toHaveBeenCalledWith(
          "ufoo-agent",
          JSON.stringify({ stream: true, done: true, reason: "complete" })
        );
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    }
  );

  test("rebuilds codex thread after threaded failure", async () => {
    const busSender = {
      enqueue: jest.fn(),
      flush: jest.fn(async () => {}),
    };
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
      busSender,
      ["--dangerously-skip-permissions"],
      threadRuntime
    );

    expect(threadRuntime.rebuildThread).toHaveBeenCalled();
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

describe("internalRunner bootstrap resolution", () => {
  test("builds a default ufoo protocol prompt when no role prompt exists", () => {
    const resolved = resolveInternalBootstrap({
      projectRoot: process.cwd(),
      agentType: "codex",
      extraArgs: ["--model", "gpt-5"],
      env: {},
    });

    expect(resolved.promptText).toContain("Session bootstrap for Codex.");
    expect(resolved.promptText).toContain("ufoo ctx decisions -l");
    expect(resolved.extraArgs).toEqual(["--model", "gpt-5"]);
  });

  test("preserves codex config option values while adding default prompt", () => {
    const samples = [
      ["-c", "key=value"],
      ["--cwd", "/tmp"],
      ["--ask-for-approval", "on-request"],
    ];

    for (const extraArgs of samples) {
      const resolved = resolveInternalBootstrap({
        projectRoot: process.cwd(),
        agentType: "codex",
        extraArgs,
        env: {},
      });

      expect(resolved.promptText).toContain("ufoo ctx decisions -l");
      expect(resolved.extraArgs).toEqual(extraArgs);
    }
  });

  test("consumes codex role prompt from positional extra args", () => {
    const resolved = resolveInternalBootstrap({
      projectRoot: process.cwd(),
      agentType: "codex",
      extraArgs: ["--json", "role prompt with ufoo protocol:\nufoo ctx decisions -l"],
      env: {},
    });

    expect(resolved.promptText).toContain("role prompt");
    expect(resolved.extraArgs).toEqual(["--json"]);
  });

  test("does not duplicate default bootstrap when role prompt already contains shared protocol", () => {
    const resolved = resolveInternalBootstrap({
      projectRoot: process.cwd(),
      agentType: "codex",
      extraArgs: ["--json", SHARED_UFOO_PROTOCOL],
      env: {},
    });

    expect(resolved.promptText.match(/Session harness: ufoo/g)).toHaveLength(1);
    expect(resolved.promptText.match(/ufoo ctx decisions -l/g)).toHaveLength(1);
    expect(resolved.extraArgs).toEqual(["--json"]);
  });

  test("consumes claude role prompt from append-system-prompt file", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-internal-bootstrap-"));
    const promptFile = path.join(projectRoot, "role.md");
    fs.writeFileSync(promptFile, "claude role prompt with ufoo protocol:\nufoo ctx decisions -l", "utf8");

    try {
      const resolved = resolveInternalBootstrap({
        projectRoot,
        agentType: "claude-code",
        extraArgs: ["--append-system-prompt", promptFile, "--model", "sonnet"],
        env: {},
      });

      expect(resolved.promptText).toContain("claude role prompt");
      expect(resolved.extraArgs).toEqual(["--model", "sonnet"]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
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

  test("createThreadRuntime resumes codex provider session when provided", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-sdk-resume-"));
    process.env.UFOO_CODEX_INTERNAL_THREAD_MODE = "api";
    const resumeThread = jest.fn(() => ({
      id: "thread-prev",
      runStreamed: async function* () {},
      close: jest.fn(async () => {}),
    }));
    const startThread = jest.fn();
    createCodexThreadProvider.mockReturnValue({ startThread, resumeThread });

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "codex-cli",
      model: "gpt-5-codex",
      extraArgs: [],
      subscriber: "codex:sdk-resume",
      providerSessionId: "thread-prev",
    });

    expect(runtime.enabled).toBe(true);
    expect(resumeThread).toHaveBeenCalledWith("thread-prev");
    expect(startThread).not.toHaveBeenCalled();
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
    const EventBus = require("../../../src/coordination/bus");
    const eventBus = new EventBus(projectRoot);
    await eventBus.init();
    const sender = await eventBus.join("sender", "codex", "sender", { scopedNickname: "handler-sender" });
    const receiver = await eventBus.join("receiver", "claude-code", "receiver", { scopedNickname: "handler-receiver" });

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

  test("parseAgentViewRawInput accepts internal view raw envelopes only", () => {
    expect(parseAgentViewRawInput(JSON.stringify({ raw: true, data: "h" }))).toBe("h");
    expect(parseAgentViewRawInput(JSON.stringify({ raw: false, data: "h" }))).toBeNull();
    expect(parseAgentViewRawInput("plain")).toBeNull();
  });

  test("createInteractiveInputSession echoes line editing and returns submitted prompts", () => {
    const writes = [];
    const session = createInteractiveInputSession({
      write: (text) => writes.push(text),
    });

    expect(session.handleRaw("hi")).toEqual([]);
    expect(session.getBuffer()).toBe("hi");
    expect(session.handleRaw("\u007f!")).toEqual([]);
    expect(session.getBuffer()).toBe("h!");
    expect(session.handleRaw("\r")).toEqual(["h!"]);
    session.writeResponsePrompt();

    expect(writes.join("")).toBe("hi\b \b!\r\n\r\n> ");
  });

  test("persistProviderSessionId writes session id into active agent metadata", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-provider-session-"));
    const agentsFile = path.join(projectRoot, ".ufoo", "agent", "all-agents.json");
    fs.mkdirSync(path.dirname(agentsFile), { recursive: true });
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: {
        "codex:abc": { agent_type: "codex", status: "active" },
      },
    }));

    expect(persistProviderSessionId(projectRoot, "codex:abc", "thread-new")).toBe(true);
    const after = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(after.agents["codex:abc"].provider_session_id).toBe("thread-new");
    expect(after.agents["codex:abc"].provider_session_updated_at).toBeTruthy();

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("claude thread mode defaults to api", () => {
    delete process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE;
    expect(getClaudeThreadMode()).toBe("api");
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

  test("createThreadRuntime stays disabled for explicit Claude legacy mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ir-claude-legacy-"));
    process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE = "legacy";

    const runtime = createThreadRuntime({
      projectRoot,
      provider: "claude-cli",
      model: "claude-sonnet",
      extraArgs: [],
    });

    expect(runtime.enabled).toBe(false);
    delete process.env.UFOO_CLAUDE_INTERNAL_THREAD_MODE;
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
      cwd: projectRoot,
      extraArgs: [],
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
});

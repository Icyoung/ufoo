const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/config", () => {
  const actual = jest.requireActual("../../../src/config");
  const emptyUcode = { ucodeProvider: "", ucodeModel: "", ucodeBaseUrl: "", ucodeApiKey: "", ucodeAgentDir: "" };
  return {
    ...actual,
    loadGlobalUcodeConfig: () => emptyUcode,
    loadConfig: (projectRoot) => {
      try {
        const _fs = require("fs");
        const _path = require("path");
        const raw = JSON.parse(_fs.readFileSync(_path.join(projectRoot, ".ufoo", "config.json"), "utf8"));
        return { ...raw, ...emptyUcode };
      } catch { return { ...emptyUcode }; }
    },
  };
});

jest.mock("../../../src/code/nativeRunner", () => ({
  runNativeAgentTask: jest.fn(async () => ({
    ok: true,
    output: "implemented",
    sessionId: "sess-1",
  })),
}));

const { runNativeAgentTask } = require("../../../src/code/nativeRunner");
const {
  runSingleCommand,
  runNaturalLanguageTask,
  formatNlResult,
  normalizeToolLogEvent,
  isProjectAnalysisTask,
  resolvePlannerProvider,
  extractJsonSummary,
  enrichNativeError,
  resolveUcodeProviderModel,
  persistSessionState,
  resumeSessionState,
  parseBusCheckOutput,
  extractBusMessageTask,
  runUbusCommand,
  stripAnsi,
  busCheckOutputIndicatesPending,
  resolvePendingQueueFile,
  countPendingQueueLines,
  getPendingBusCount,
  drainJsonlFile,
  extractTaskFromBusEvent,
  shouldAutoConsumeBus,
  parseAgentArgs,
  resolveUfooProjectRoot,
} = require("../../../src/code/agent");

describe("ucode core agent nl path", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("runSingleCommand routes free-form text to nl task path", () => {
    const result = runSingleCommand("please refactor src/app.js", process.cwd());
    expect(result.kind).toBe("nl");
    expect(result.task).toContain("refactor");
  });

  test("runSingleCommand includes tool metadata for core tool runs", () => {
    const result = runSingleCommand("tool read {\"path\":\"src/code/tui.js\"}", process.cwd());
    expect(result.kind).toBe("tool");
    expect(result.tool).toBe("read");
    expect(result.args).toEqual({ path: "src/code/tui.js" });
    expect(result.result).toEqual(expect.objectContaining({
      ok: true,
    }));
  });

  test("runSingleCommand parses resume command with session id", () => {
    const result = runSingleCommand("resume sess-abc123", process.cwd());
    expect(result.kind).toBe("resume");
    expect(result.sessionId).toBe("sess-abc123");
  });

  test("runSingleCommand returns usage error for resume without id", () => {
    const result = runSingleCommand("resume", process.cwd());
    expect(result.kind).toBe("error");
    expect(result.output).toContain("usage: resume");
  });

  test("runSingleCommand parses ubus command variants", () => {
    expect(runSingleCommand("ubus", process.cwd())).toEqual({ kind: "ubus" });
    expect(runSingleCommand("/ubus", process.cwd())).toEqual({ kind: "ubus" });
  });

  test("runNaturalLanguageTask uses native runner path and updates session", async () => {
    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "project rules",
      sessionId: "",
      timeoutMs: 30000,
    };
    const result = await runNaturalLanguageTask("update tests", state);

    expect(runNativeAgentTask).toHaveBeenCalledTimes(1);
    expect(runNativeAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "update tests",
      provider: "openai",
      model: "gpt-5.2-codex",
      workspaceRoot: process.cwd(),
    }));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("implemented");
    expect(state.sessionId).toBe("sess-1");
  });

  test("runNaturalLanguageTask forwards stream deltas to caller", async () => {
    runNativeAgentTask.mockImplementationOnce(async (params) => {
      if (params && typeof params.onStreamDelta === "function") {
        params.onStreamDelta("chunk-1");
        params.onStreamDelta("chunk-2");
      }
      return {
        ok: true,
        output: "chunk-1chunk-2",
        sessionId: "sess-stream",
        streamed: true,
      };
    });
    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "",
      timeoutMs: 30000,
    };
    const seen = [];
    const result = await runNaturalLanguageTask("stream this", state, {
      onDelta: (delta) => seen.push(delta),
    });

    expect(seen).toEqual(["chunk-1", "chunk-2"]);
    expect(result.ok).toBe(true);
    expect(result.streamed).toBe(true);
    expect(result.streamLastChar).toBe("2");
    expect(state.sessionId).toBe("sess-stream");
  });

  test("runNaturalLanguageTask persists native message history across turns", async () => {
    runNativeAgentTask.mockImplementation(async (params) => {
      const prior = Array.isArray(params.messages) ? params.messages.slice() : [];
      return {
        ok: true,
        output: `ack:${params.prompt}`,
        sessionId: "sess-history",
        messages: [
          ...prior,
          { role: "user", content: params.prompt },
          { role: "assistant", content: `ack:${params.prompt}` },
        ],
      };
    });

    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "",
      timeoutMs: 30000,
    };

    const first = await runNaturalLanguageTask("first question", state);
    const second = await runNaturalLanguageTask("second question", state);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(runNativeAgentTask).toHaveBeenCalledTimes(2);
    expect(runNativeAgentTask.mock.calls[0][0]).toEqual(expect.objectContaining({
      messages: [],
      prompt: "first question",
    }));
    expect(runNativeAgentTask.mock.calls[1][0]).toEqual(expect.objectContaining({
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "ack:first question" },
      ],
      prompt: "second question",
    }));
    expect(state.nlMessages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "ack:first question" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "ack:second question" },
    ]);
  });

  test("runNaturalLanguageTask captures core tool logs from cli tool events", async () => {
    runNativeAgentTask.mockImplementationOnce(async (params) => {
      if (params && typeof params.onToolEvent === "function") {
        params.onToolEvent({
          tool: "read",
          phase: "end",
          args: { path: "src/code/tui.js" },
        });
        params.onToolEvent({
          tool: "read",
          phase: "start",
          args: { path: "src/code/tui.js" },
        });
      }
      return {
        ok: true,
        output: "done",
        sessionId: "sess-tool-log",
      };
    });
    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "",
      timeoutMs: 30000,
    };
    const liveLogs = [];
    const result = await runNaturalLanguageTask("inspect file", state, {
      onToolLog: (entry) => liveLogs.push(entry),
    });

    expect(result.ok).toBe(true);
    expect(result.logs).toEqual([
      {
        type: "tool",
        tool: "read",
        phase: "start",
        args: { path: "src/code/tui.js" },
        error: "",
      },
    ]);
    expect(liveLogs).toEqual(result.logs);
  });

  test("runNaturalLanguageTask adds deterministic preflight reads for project analysis tasks", async () => {
    runNativeAgentTask.mockResolvedValueOnce({
      ok: true,
      output: "analysis complete",
      sessionId: "sess-analysis",
    });
    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "",
      timeoutMs: 30000,
    };

    const liveLogs = [];
    const result = await runNaturalLanguageTask("分析项目现状", state, {
      onToolLog: (entry) => liveLogs.push(entry),
    });

    expect(result.ok).toBe(true);
    expect(result.logs.some((entry) => entry.tool === "read" && entry.phase === "start")).toBe(true);
    expect(liveLogs.some((entry) => entry.tool === "read" && entry.phase === "start")).toBe(true);
    expect(runNativeAgentTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Analysis requirements"),
      systemPrompt: expect.stringContaining("Preflight snapshot"),
    }));
  });

  test("normalizeToolLogEvent filters non-core operations", () => {
    expect(normalizeToolLogEvent({
      tool: "unknown-op",
      phase: "start",
    })).toBeNull();
    expect(normalizeToolLogEvent({
      tool: "read",
      phase: "start",
      args: { path: "src/code/tui.js" },
    })).toEqual({
      type: "tool",
      tool: "read",
      phase: "start",
      args: { path: "src/code/tui.js" },
      error: "",
    });
    expect(normalizeToolLogEvent({
      tool: "bash",
      phase: "end",
      args: { command: "ls" },
    })).toBeNull();
  });

  test("runNaturalLanguageTask uses informative fallback summary instead of plain ok", async () => {
    runNativeAgentTask.mockResolvedValueOnce({
      ok: true,
      output: "",
      sessionId: "sess-fallback",
    });
    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "",
      timeoutMs: 30000,
    };

    const result = await runNaturalLanguageTask("分析项目现状", state);
    expect(result.ok).toBe(true);
    expect(result.summary).not.toBe("ok");
    expect(result.summary).toContain("Done");
    expect(result.summary).toContain("tool");
  });

  test("isProjectAnalysisTask matches analysis intents", () => {
    expect(isProjectAnalysisTask("analyze project status")).toBe(true);
    expect(isProjectAnalysisTask("架构审查现状")).toBe(true);
    expect(isProjectAnalysisTask("write a unit test")).toBe(false);
  });

  test("runNaturalLanguageTask keeps explicit runner errors", async () => {
    runNativeAgentTask
      .mockResolvedValueOnce({
        ok: false,
        error: "provider auth failed",
        sessionId: "deadbeef",
      });

    const state = {
      workspaceRoot: process.cwd(),
      provider: "anthropic",
      model: "claude-opus-4-6",
      context: "",
      sessionId: "stale-session",
      timeoutMs: 30000,
    };

    const result = await runNaturalLanguageTask("retry please", state);

    expect(runNativeAgentTask).toHaveBeenCalledTimes(1);
    expect(runNativeAgentTask.mock.calls[0][0]).toEqual(expect.objectContaining({
      provider: "anthropic",
      sessionId: "stale-session",
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("provider auth failed");
  });

  test("persistSessionState and resumeSessionState roundtrip messages", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-resume-"));
    const state = {
      workspaceRoot: projectRoot,
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "rules",
      sessionId: "sess-roundtrip",
      nlMessages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
      ],
    };
    try {
      const persisted = persistSessionState(state);
      expect(persisted.ok).toBe(true);

      const restored = {
        workspaceRoot: projectRoot,
        provider: "",
        model: "",
        context: "",
        sessionId: "",
        nlMessages: [],
      };
      const resumed = resumeSessionState(restored, "sess-roundtrip", projectRoot);
      expect(resumed.ok).toBe(true);
      expect(restored.sessionId).toBe("sess-roundtrip");
      expect(restored.provider).toBe("openai");
      expect(restored.model).toBe("gpt-5.2-codex");
      expect(restored.nlMessages).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "ack" },
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("resumeSessionState returns error when session does not exist", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-resume-missing-"));
    const state = { workspaceRoot: projectRoot };
    try {
      const resumed = resumeSessionState(state, "sess-missing", projectRoot);
      expect(resumed.ok).toBe(false);
      expect(resumed.error).toContain("session not found");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("parseBusCheckOutput extracts publisher and task from bus check output", () => {
    const rows = parseBusCheckOutput([
      "@you from claude-code:abc123",
      "Type: message/targeted",
      "Content: {\"message\":\"Please analyze project status\"}",
    ].join("\n"));
    expect(rows).toEqual([
      {
        publisher: "claude-code:abc123",
        content: "{\"message\":\"Please analyze project status\"}",
        task: "Please analyze project status",
      },
    ]);
    expect(extractBusMessageTask("{\"message\":\"hello\"}")).toBe("hello");
  });

  test("parseBusCheckOutput tolerates ansi-colored output", () => {
    const ansi = "\u001b[33m";
    const reset = "\u001b[0m";
    const rows = parseBusCheckOutput([
      `  ${ansi}@you${reset} from ${ansi}claude-code:abc123${reset}`,
      "  Type: message/targeted",
      `  Content: ${ansi}{\"message\":\"hello\"}${reset}`,
      "",
    ].join("\n"));
    expect(rows).toEqual([
      {
        publisher: "claude-code:abc123",
        content: "{\"message\":\"hello\"}",
        task: "hello",
      },
    ]);
  });

  test("stripAnsi removes common sequences", () => {
    expect(stripAnsi("\u001b[33mhello\u001b[0m")).toBe("hello");
  });

  test("resolveUfooProjectRoot prefers env UFOO_UCODE_PROJECT_ROOT when .ufoo exists", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-root-"));
    try {
      fs.mkdirSync(path.join(projectRoot, ".ufoo", "bus"), { recursive: true });
      const resolved = resolveUfooProjectRoot("/tmp/does-not-exist", { UFOO_UCODE_PROJECT_ROOT: projectRoot });
      expect(resolved).toBe(projectRoot);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("busCheckOutputIndicatesPending detects pending output", () => {
    expect(busCheckOutputIndicatesPending("No pending messages")).toBe(false);
    expect(busCheckOutputIndicatesPending("You have 2 pending event(s):")).toBe(true);
    expect(busCheckOutputIndicatesPending("After handling, run: ufoo bus ack x")).toBe(true);
  });

  test("runUbusCommand auto-executes pending messages from pending.jsonl and replies", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-ubus-"));
    try {
      const subscriberId = "ufoo-code:bus123";
      const pendingFile = resolvePendingQueueFile(projectRoot, subscriberId);
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      fs.writeFileSync(pendingFile, `${JSON.stringify({
        seq: 1,
        event: "message",
        publisher: "claude-code:abc123",
        target: subscriberId,
        data: { message: "run tests" },
      })}\n`, "utf8");

      const state = {
        workspaceRoot: projectRoot,
        provider: "openai",
        model: "gpt-5.2-codex",
        context: "",
        sessionId: "sess-bus",
        timeoutMs: 30000,
      };

      const shellCalls = [];
      const shell = (command) => {
        shellCalls.push(command);
        if (command.startsWith("ufoo bus send")) return { ok: true, output: "ok\n", error: "" };
        return { ok: true, output: "", error: "" };
      };
      const runNl = jest.fn(async () => ({ ok: true, summary: "done", artifacts: [], logs: [], error: "" }));

      const result = await runUbusCommand(state, {
        workspaceRoot: projectRoot,
        subscriberId,
        execShell: shell,
        runNaturalLanguageTaskImpl: runNl,
        formatNlResultImpl: (res) => String(res.summary || ""),
      });

      expect(result.ok).toBe(true);
      expect(result.handled).toBe(1);
      expect(runNl).toHaveBeenCalledWith("run tests", state, expect.objectContaining({ onProgress: expect.any(Function) }));
      expect(shellCalls.some((cmd) => cmd.startsWith("ufoo bus send"))).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("runUbusCommand prefers explicit subscriber id option", async () => {
    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "sess-bus-explicit",
      timeoutMs: 30000,
    };
    const shellCalls = [];
    const shell = (command) => {
      shellCalls.push(command);
      if (command.startsWith("ufoo bus check")) {
        return { ok: true, output: "", error: "" };
      }
      if (command.startsWith("ufoo bus ack")) {
        return { ok: true, output: "acked\n", error: "" };
      }
      return { ok: true, output: "", error: "" };
    };

    const result = await runUbusCommand(state, {
      workspaceRoot: process.cwd(),
      subscriberId: "ufoo-code:direct123",
      execShell: shell,
      runNaturalLanguageTaskImpl: async () => ({ ok: true, summary: "done" }),
      formatNlResultImpl: () => "done",
    });

    expect(result.ok).toBe(true);
    expect(result.subscriberId).toBe("ufoo-code:direct123");
    expect(shellCalls.some((cmd) => cmd.includes("ufoo bus whoami"))).toBe(false);
    // No pending.jsonl exists in this test; we fall back to shell check only if needed.
  });

  test("pending queue helpers resolve and count pending lines", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-pending-"));
    try {
      const pendingFile = resolvePendingQueueFile(projectRoot, "ufoo-code:abc123");
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      fs.writeFileSync(pendingFile, `${JSON.stringify({ seq: 1 })}\n${JSON.stringify({ seq: 2 })}\n`);
      expect(countPendingQueueLines(pendingFile)).toBe(2);
      expect(getPendingBusCount(projectRoot, "ufoo-code:abc123")).toBe(2);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("shouldAutoConsumeBus only enables native subscribers", () => {
    expect(shouldAutoConsumeBus("ufoo-code:abc")).toBe(true);
    expect(shouldAutoConsumeBus("ucode:abc")).toBe(true);
    expect(shouldAutoConsumeBus("codex:abc")).toBe(false);
  });

  test("drainJsonlFile drains pending jsonl atomically", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-drain-"));
    try {
      const pendingFile = resolvePendingQueueFile(projectRoot, "ufoo-code:abc123");
      fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
      fs.writeFileSync(pendingFile, `${JSON.stringify({ seq: 1, event: "message", publisher: "ufoo-agent", data: { message: "hi" } })}\n`);
      const res = drainJsonlFile(pendingFile);
      expect(Array.isArray(res.drained)).toBe(true);
      expect(res.drained.length).toBe(1);
      expect(fs.existsSync(pendingFile)).toBe(false); // drained via rename
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("extractTaskFromBusEvent extracts publisher/task from message event", () => {
    expect(extractTaskFromBusEvent({
      event: "message",
      publisher: "ufoo-agent",
      data: { message: "do thing" },
    })).toEqual({ publisher: "ufoo-agent", task: "do thing" });
    expect(extractTaskFromBusEvent({ event: "wake" })).toBeNull();
  });

  test("runNaturalLanguageTask retries once with extended timeout after CLI timeout", async () => {
    runNativeAgentTask
      .mockResolvedValueOnce({
        ok: false,
        error: "CLI timeout (300000ms)",
        sessionId: "sess-timeout",
      })
      .mockResolvedValueOnce({
        ok: true,
        output: "done after retry",
        sessionId: "sess-timeout-2",
      });

    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "",
      timeoutMs: 300000,
    };

    const result = await runNaturalLanguageTask("long task", state);

    expect(runNativeAgentTask).toHaveBeenCalledTimes(2);
    expect(runNativeAgentTask.mock.calls[0][0]).toEqual(expect.objectContaining({
      timeoutMs: 300000,
    }));
    expect(runNativeAgentTask.mock.calls[1][0]).toEqual(expect.objectContaining({
      timeoutMs: 600000,
    }));
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("done after retry");
    expect(state.sessionId).toBe("sess-timeout-2");
  });

  test("runNaturalLanguageTask marks cancelled when CLI is cancelled", async () => {
    runNativeAgentTask.mockResolvedValueOnce({
      ok: false,
      error: "CLI cancelled",
      sessionId: "sess-cancelled",
    });

    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "gpt-5.2-codex",
      context: "",
      sessionId: "",
      timeoutMs: 300000,
    };

    const result = await runNaturalLanguageTask("cancel task", state);
    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(true);
  });

  test("runNaturalLanguageTask enriches missing-model error with settings hint", async () => {
    runNativeAgentTask.mockResolvedValueOnce({
      ok: false,
      error: "ucode model is not configured",
      sessionId: "sess-no-model",
    });

    const state = {
      workspaceRoot: process.cwd(),
      provider: "openai",
      model: "",
      context: "",
      sessionId: "",
      timeoutMs: 300000,
    };

    const result = await runNaturalLanguageTask("hello", state);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("/settings ucode set");
  });

  test("provider mapping resolves anthropic/claude to claude planner", () => {
    expect(resolvePlannerProvider("anthropic")).toBe("anthropic");
    expect(resolvePlannerProvider("claude-code")).toBe("anthropic");
    expect(resolvePlannerProvider("openai")).toBe("openai");
    expect(resolvePlannerProvider("codex-cli")).toBe("openai");
  });

  test("extractJsonSummary prefers summary/reply fields in trailing json", () => {
    const text = [
      "preamble",
      "{\"ok\":true,\"summary\":\"done\"}",
    ].join("\n");
    expect(extractJsonSummary(text)).toBe("done");
  });

  test("extractJsonSummary falls back to reply in direct json object", () => {
    expect(extractJsonSummary("{\"reply\":\"done\"}")).toBe("done");
  });

  test("enrichNativeError keeps generic errors unchanged", () => {
    expect(enrichNativeError("provider auth failed")).toBe("provider auth failed");
  });

  test("enrichNativeError adds network hint for fetch failures", () => {
    const text = enrichNativeError("fetch failed");
    expect(text).toContain("Network connection to provider failed");
    expect(text).toContain("/settings ucode show");
  });

  test("formatNlResult returns friendly plain error in non-json mode", () => {
    const out = formatNlResult({ ok: false, error: "fetch failed" }, false);
    expect(out).toBe("Error: fetch failed");
  });

  test("parseAgentArgs supports tui flags", () => {
    const parsed = parseAgentArgs(["--tui", "--no-tui"]);
    expect(parsed.forceTui).toBe(true);
    expect(parsed.disableTui).toBe(true);
  });

  test("resolveUcodeProviderModel defaults to ufoo config provider mapping", () => {
    const savedProvider = process.env.UFOO_UCODE_PROVIDER;
    const savedModel = process.env.UFOO_UCODE_MODEL;
    delete process.env.UFOO_UCODE_PROVIDER;
    delete process.env.UFOO_UCODE_MODEL;
    try {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-model-"));
      const configDir = path.join(projectRoot, ".ufoo");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        launchMode: "terminal",
        ucodeProvider: "",
        ucodeModel: "",
        agentProvider: "codex-cli",
        agentModel: "gpt-5.2-codex",
      }, null, 2));

      const result = resolveUcodeProviderModel({
        workspaceRoot: projectRoot,
        provider: "",
        model: "",
      });
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-5.2-codex");
    } finally {
      if (savedProvider !== undefined) process.env.UFOO_UCODE_PROVIDER = savedProvider;
      else delete process.env.UFOO_UCODE_PROVIDER;
      if (savedModel !== undefined) process.env.UFOO_UCODE_MODEL = savedModel;
      else delete process.env.UFOO_UCODE_MODEL;
    }
  });
});

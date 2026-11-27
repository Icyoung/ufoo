"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const { JsonRpcStdioConnection } = require("../../../src/agents/acp/jsonRpcStdio");
const {
  buildAgyAcpArgs,
  parseAgyModelsOutput,
  createAgyThreadProvider,
  resolveAgyBinary,
} = require("../../../src/agents/providers/agyThreadProvider");
const {
  resolveInternalBootstrap,
  createThreadRuntime,
} = require("../../../src/agents/internal/internalRunner");
const { normalizeInternalAgentType } = require("../../../src/runtime/contracts/agentMode");

function createPairedStreams() {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  return {
    clientInput: serverToClient,
    clientOutput: clientToServer,
    serverInput: clientToServer,
    serverOutput: serverToClient,
  };
}

describe("Antigravity (agy) internal thread provider", () => {
  test("agentMode normalizes agy aliases and buildAgyAcpArgs includes --process-per-session", () => {
    expect(normalizeInternalAgentType("agy")).toBe("agy");
    expect(normalizeInternalAgentType("antigravity")).toBe("agy");
    expect(normalizeInternalAgentType("agy-cli")).toBe("agy");
    expect(normalizeInternalAgentType("acp:agy")).toBe("agy");
    expect(normalizeInternalAgentType("acp-agy")).toBe("agy");

    expect(buildAgyAcpArgs()).toEqual(["acp", "--process-per-session"]);
    expect(buildAgyAcpArgs({ permissionMode: "full_access" })).toEqual([
      "acp",
      "--process-per-session",
      "--dangerously-skip-permissions",
    ]);
    expect(buildAgyAcpArgs({ extraArgs: ["--sandbox", "--model", "gemini-4-neon-high"] })).toEqual([
      "acp",
      "--process-per-session",
      "--sandbox",
    ]);
  });

  test("parseAgyModelsOutput parses `agy models` tab-delimited rows cleanly", () => {
    const sample = [
      "Fetching available models...",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
      "gemini-4-carbon-high\tGemini 4 Carbon (High)",
      "claude-opus-5-5-high\tClaude Opus 5.5 (High)",
      "gemini-4-neon-high\tGemini 4 Neon (High)",
    ].join("\n");
    expect(parseAgyModelsOutput(sample)).toEqual([
      "gemini-4-neon-high",
      "gemini-4-carbon-high",
      "claude-opus-5-5-high",
    ]);
  });

  test("resolveAgyBinary respects UFOO_AGY_BIN and ~/.local/bin/agy fallback", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agy-bin-"));
    try {
      const fakeBin = path.join(tmp, ".local", "bin", "agy");
      fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
      fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(resolveAgyBinary({ homeDir: tmp, env: {}, isExecutable: () => false })).toBe(fakeBin);

      const customBin = path.join(tmp, "custom-agy");
      fs.writeFileSync(customBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(resolveAgyBinary({ homeDir: tmp, env: { UFOO_AGY_BIN: customBin }, isExecutable: () => false })).toBe(customBin);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolveInternalBootstrap consumes -i role/workflow prompt for agy", () => {
    const result = resolveInternalBootstrap({
      projectRoot: process.cwd(),
      agentType: "agy",
      extraArgs: ["--model", "gemini-4-neon-high", "--effort", "high", "-i", "You are the build-lane Reviewer."],
    });
    expect(result.extraArgs).toEqual(["--model", "gemini-4-neon-high", "--effort", "high"]);
    expect(result.promptText).toContain("You are the build-lane Reviewer.");
    expect(result.promptText).toContain("Session bootstrap for Agy.");
  });

  test("agyThreadProvider injects _meta.antigravity.systemPrompt.append, MCP servers, images, usage, resume, and clamped configOptions", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agy-acp-"));
    const pngPath = path.join(tmp, "dot.png");
    // 1x1 transparent PNG
    fs.writeFileSync(pngPath, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64"
    ));

    const streams = createPairedStreams();
    const serverConn = new JsonRpcStdioConnection({
      input: streams.serverInput,
      output: streams.serverOutput,
    });

    const recorded = {
      newParams: null,
      resumeParams: null,
      setConfigCalls: [],
      setModeCalls: [],
      prompts: [],
    };

    const initialConfigOptions = [
      {
        id: "model",
        category: "model",
        currentValue: "gemini-4-carbon-high",
        options: [
          { value: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
          { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
        ],
      },
      {
        id: "thought_level",
        category: "thought_level",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ];

    serverConn.onRequest("initialize", async () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {}, load: {} },
        mcpCapabilities: { http: true },
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
      },
    }));

    serverConn.onRequest("session/new", async (params) => {
      recorded.newParams = params;
      return {
        sessionId: "agy-sess-1",
        configOptions: initialConfigOptions,
        modes: {
          currentModeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "accept-edits", name: "Accept Edits" },
            { id: "auto", name: "Auto" },
          ],
        },
      };
    });

    serverConn.onRequest("session/resume", async (params) => {
      recorded.resumeParams = params;
      return {
        sessionId: params.sessionId,
        configOptions: initialConfigOptions,
      };
    });

    serverConn.onRequest("session/set_mode", async (params) => {
      recorded.setModeCalls.push(params);
      return {};
    });

    serverConn.onRequest("session/set_config_option", async (params) => {
      recorded.setConfigCalls.push(params);
      const next = initialConfigOptions.map((opt) => (
        opt.id === params.configId ? { ...opt, currentValue: params.value } : opt
      ));
      return { configOptions: next };
    });

    serverConn.onRequest("session/prompt", async (params) => {
      recorded.prompts.push(params.prompt);
      serverConn.sendNotification("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Checking file..." },
        },
      });
      serverConn.sendNotification("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-agy-1",
          name: "run_command",
          title: "echo hello",
          rawInput: { CommandLine: "echo hello", Cwd: tmp },
        },
      });
      serverConn.sendNotification("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-agy-1",
          status: "completed",
          rawOutput: { output: "hello\n", exit_code: 0 },
        },
      });
      serverConn.sendNotification("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 12000,
          size: 1048576,
        },
      });
      serverConn.sendNotification("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Done!" },
        },
      });
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 12000,
          outputTokens: 42,
          cachedReadTokens: 8000,
          thoughtTokens: 300,
          totalTokens: 12342,
        },
      };
    });

    const mcpServers = [{
      name: "ufoo",
      type: "http",
      url: "http://127.0.0.1:47631/mcp",
      headers: [{ name: "X-Ufoo-Launch-Mode", value: "internal" }],
    }];

    let spawnMeta = null;
    const provider = createAgyThreadProvider({
      command: "/fake/agy",
      cwd: tmp,
      mcpServers,
      model: "gemini-4-carbon-high",
      thinkingLevel: "xhigh",
      permissionMode: "auto_edit",
      systemPrompt: "Role: Reviewer in build-lane",
      connectionFactory: (meta) => {
        spawnMeta = meta;
        return new JsonRpcStdioConnection({
          input: streams.clientInput,
          output: streams.clientOutput,
        });
      },
    });

    try {
      const thread = provider.startThread();
      expect(thread.managesSystemPrompt).toBe(true);

      const events = [];
      for await (const evt of thread.runStreamed("Inspect screenshot", {
        attachments: [{ path: pngPath, name: "dot.png", kind: "image", media_type: "image/png" }],
      })) {
        events.push(evt);
      }

      expect(spawnMeta.args).toEqual(["acp", "--process-per-session"]);
      expect(recorded.newParams.mcpServers).toEqual(mcpServers);
      expect(recorded.newParams._meta).toEqual({
        antigravity: { systemPrompt: { append: "Role: Reviewer in build-lane" } },
      });
      expect(recorded.setModeCalls[0]).toEqual({ sessionId: "agy-sess-1", modeId: "accept-edits" });
      expect(recorded.prompts[0][0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect(recorded.prompts[0][1]).toEqual({ type: "text", text: "Inspect screenshot" });

      const toolCallEvt = events.find((e) => e.type === "tool_call");
      expect(toolCallEvt.name).toBe("run_command");
      expect(toolCallEvt.args.command).toBe("echo hello");

      const toolResultEvt = events.find((e) => e.type === "tool_result");
      expect(toolResultEvt.output).toBe("hello\n");
      expect(toolResultEvt.exitCode).toBe(0);
      expect(toolResultEvt.is_error).toBe(false);

      const usageEvt = events.find((e) => e.type === "usage");
      expect(usageEvt.usage).toEqual({ input_tokens: 12000, total_tokens: 12000, context_window: 1048576 });

      const completedEvt = events.find((e) => e.type === "turn_completed");
      expect(completedEvt.usage).toMatchObject({
        input_tokens: 12000,
        output_tokens: 42,
        cache_read_tokens: 8000,
        thinking_tokens: 300,
      });
      expect(completedEvt.finalText).toBe("Done!");

      // Live configure clamps unsupported "off" -> "low" and "max" -> "high" (since only low/medium/high available)
      await thread.configure({ thinkingLevel: "off" });
      await thread.configure({ thinkingLevel: "max" });
      const thoughtCalls = recorded.setConfigCalls.filter((c) => c.configId === "thought_level");
      expect(thoughtCalls.map((c) => c.value)).toEqual(["low", "high"]);

      await thread.close();

      // Resume uses session/resume (not session/load) when supported
      const streams2 = createPairedStreams();
      const serverConn2 = new JsonRpcStdioConnection({
        input: streams2.serverInput,
        output: streams2.serverOutput,
      });
      serverConn2.onRequest("initialize", async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { resume: {} } },
      }));
      serverConn2.onRequest("session/resume", async (params) => {
        recorded.resumeParams = params;
        return { sessionId: params.sessionId };
      });
      serverConn2.onRequest("session/prompt", async () => ({ stopReason: "end_turn" }));

      const provider2 = createAgyThreadProvider({
        command: "/fake/agy",
        cwd: tmp,
        mcpServers,
        connectionFactory: () => new JsonRpcStdioConnection({
          input: streams2.clientInput,
          output: streams2.clientOutput,
        }),
      });
      const resumed = provider2.resumeThread("agy-sess-1");
      // eslint-disable-next-line no-unused-vars
      for await (const _ of resumed.runStreamed("continue")) {
        // drain
      }
      expect(recorded.resumeParams).toEqual({
        sessionId: "agy-sess-1",
        cwd: tmp,
        mcpServers,
      });
      await resumed.close();
      serverConn2.close();
    } finally {
      serverConn.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("createThreadRuntime initializes agy-cli runtime when UFOO_AGY_BIN points to executable", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agy-rt-"));
    const prevBin = process.env.UFOO_AGY_BIN;
    try {
      const fakeBin = path.join(tmp, "agy");
      fs.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      process.env.UFOO_AGY_BIN = fakeBin;

      const rt = createThreadRuntime({
        projectRoot: tmp,
        provider: "agy-cli",
        model: "gemini-4-carbon-high",
        extraArgs: ["--effort", "high"],
        subscriber: "agy:11223344",
        systemPrompt: "Role: Architect",
      });
      expect(rt.enabled).toBe(true);
      expect(rt.thread.managesSystemPrompt).toBe(true);
      expect(rt.getRuntimeState()).toMatchObject({
        model: "gemini-4-carbon-high",
        thinking_level: "high",
      });
      await rt.close();
    } finally {
      if (prevBin === undefined) delete process.env.UFOO_AGY_BIN;
      else process.env.UFOO_AGY_BIN = prevBin;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

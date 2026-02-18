const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/code/dispatch", () => ({
  runToolCall: jest.fn(() => ({ ok: true, content: "" })),
}));

jest.mock("../../../src/config", () => {
  const fs = require("fs");
  const path = require("path");
  const actual = jest.requireActual("../../../src/config");
  const emptyUcode = { ucodeProvider: "", ucodeModel: "", ucodeBaseUrl: "", ucodeApiKey: "", ucodeAgentDir: "" };
  return {
    ...actual,
    loadGlobalUcodeConfig: () => emptyUcode,
    loadConfig: (projectRoot) => {
      // Read project config only, skip global
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(projectRoot, ".ufoo", "config.json"), "utf8"));
        return { ...raw, ...emptyUcode };
      } catch { return { ...emptyUcode }; }
    },
  };
});

const { runToolCall } = require("../../../src/code/dispatch");
const {
  runNativeAgentTask,
  parseReadIntent,
  parseBashIntent,
  extractPreflightEvidence,
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveAnthropicMessagesUrl,
  resolveTransport,
} = require("../../../src/code/nativeRunner");

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
    headers: {
      "content-type": "text/event-stream",
    },
  });
}

describe("ucode native runner", () => {
  const originalFetch = global.fetch;
  const originalOpenAiBase = process.env.OPENAI_BASE_URL;
  const originalAnthropicBase = process.env.ANTHROPIC_BASE_URL;
  const originalUcodeProvider = process.env.UFOO_UCODE_PROVIDER;
  const originalUcodeModel = process.env.UFOO_UCODE_MODEL;
  let workspaceRoot = "";

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.UFOO_UCODE_PROVIDER;
    delete process.env.UFOO_UCODE_MODEL;
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-native-runner-"));
    fs.mkdirSync(path.join(workspaceRoot, ".ufoo"), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, ".ufoo", "config.json"), JSON.stringify({
      ucodeProvider: "",
      ucodeModel: "",
      ucodeBaseUrl: "",
      ucodeApiKey: "",
      agentProvider: "codex-cli",
      agentModel: "",
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
    if (typeof originalOpenAiBase === "string") process.env.OPENAI_BASE_URL = originalOpenAiBase;
    else delete process.env.OPENAI_BASE_URL;
    if (typeof originalAnthropicBase === "string") process.env.ANTHROPIC_BASE_URL = originalAnthropicBase;
    else delete process.env.ANTHROPIC_BASE_URL;
    if (typeof originalUcodeProvider === "string") process.env.UFOO_UCODE_PROVIDER = originalUcodeProvider;
    else delete process.env.UFOO_UCODE_PROVIDER;
    if (typeof originalUcodeModel === "string") process.env.UFOO_UCODE_MODEL = originalUcodeModel;
    else delete process.env.UFOO_UCODE_MODEL;
  });

  test("streams model output through openai-compatible provider", async () => {
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ]));

    const deltas = [];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "openai",
      model: "gpt-test",
      onStreamDelta: (delta) => deltas.push(delta),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("Hello world");
    expect(result.streamed).toBe(true);
    expect(deltas).toEqual(["Hello", " world"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("preserves multi-turn message history between openai-native turns", async () => {
    global.fetch
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: "first answer" } }] },
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: "second answer" } }] },
      ]));

    const first = await runNativeAgentTask({
      workspaceRoot,
      prompt: "first question",
      provider: "openai",
      model: "gpt-test",
      systemPrompt: "project rules",
    });

    const second = await runNativeAgentTask({
      workspaceRoot,
      prompt: "second question",
      provider: "openai",
      model: "gpt-test",
      systemPrompt: "project rules",
      messages: first.messages,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(first.messages).toEqual(expect.arrayContaining([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]));

    const secondRequestPayload = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(secondRequestPayload.messages).toEqual(expect.arrayContaining([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
    ]));
    expect(second.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: "second answer" },
    ]));
  });

  test("executes core tool call from model and emits start event immediately", async () => {
    global.fetch
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "read",
                      arguments: '{"path":"AGENTS.md"}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: "analysis done" } }] },
      ]));

    runToolCall.mockReturnValueOnce({
      ok: true,
      path: "/repo/AGENTS.md",
      totalLines: 12,
      content: "hello",
    });

    const events = [];
    const result = await runNativeAgentTask({
      workspaceRoot: "/repo",
      prompt: "analyze project",
      provider: "openai",
      model: "gpt-test",
      onToolEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("analysis done");
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(runToolCall).toHaveBeenCalledWith(
      { tool: "read", args: { path: "AGENTS.md" } },
      { workspaceRoot: "/repo", cwd: "/repo" }
    );
    expect(events).toEqual([
      {
        tool: "read",
        phase: "start",
        args: { path: "AGENTS.md" },
        error: "",
      },
    ]);
  });

  test("streams model output through anthropic messages transport", async () => {
    const sse = [
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");

    global.fetch.mockResolvedValueOnce(new Response(sse, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }));

    const deltas = [];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "anthropic",
      model: "claude-opus-4-6",
      onStreamDelta: (delta) => deltas.push(delta),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("Hi there");
    expect(deltas).toEqual(["Hi", " there"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
  });

  test("returns explicit error when model is missing", async () => {
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "openai",
      model: "",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("model is not configured");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("returns cancelled when signal aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "analyze project",
      model: "gpt-test",
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("CLI cancelled");
  });

  test("runtime config maps codex/claude aliases and default url", () => {
    const openaiConfig = resolveRuntimeConfig({
      workspaceRoot,
      provider: "codex-cli",
      model: "gpt-5",
    });
    expect(openaiConfig.provider).toBe("openai");
    expect(openaiConfig.baseUrl).toBe("https://api.openai.com/v1");

    const anthropicConfig = resolveRuntimeConfig({
      workspaceRoot,
      provider: "claude-code",
      model: "claude-opus-4-6",
    });
    expect(anthropicConfig.provider).toBe("anthropic");
    expect(anthropicConfig.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(anthropicConfig.transport).toBe("anthropic-messages");
  });

  test("completion url resolver appends chat endpoint", () => {
    expect(resolveCompletionUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1/chat/completions");
    expect(resolveCompletionUrl("https://proxy.example/v1/chat/completions")).toBe("https://proxy.example/v1/chat/completions");
    expect(resolveCompletionUrl("https://gateway.example/api")).toBe("https://gateway.example/api/v1/chat/completions");
  });

  test("anthropic url and transport resolver support generic url config", () => {
    expect(resolveAnthropicMessagesUrl("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/messages");
    expect(resolveAnthropicMessagesUrl("https://proxy.example/v1/messages")).toBe("https://proxy.example/v1/messages");
    expect(resolveAnthropicMessagesUrl("https://gateway.example/api")).toBe("https://gateway.example/api/v1/messages");

    expect(resolveTransport({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).toBe("openai-chat");
    expect(resolveTransport({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" })).toBe("anthropic-messages");
    expect(resolveTransport({ provider: "", baseUrl: "https://gateway.example/messages" })).toBe("anthropic-messages");
  });

  test("intent parsers and preflight evidence parser still available", () => {
    expect(parseReadIntent("read src/code/agent.js")).toBe("src/code/agent.js");
    expect(parseBashIntent("please list files")).toBe("ls -la");
    expect(extractPreflightEvidence("Preflight snapshot (captured by ucode):\n---\nFile: A.md\n# A").length).toBe(1);
  });
});

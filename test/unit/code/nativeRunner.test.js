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
const { defaultAgentModelForProvider } = require("../../../src/config");
const {
  runNativeAgentTask,
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
  const originalMaxToolCalls = process.env.UFOO_UCODE_MAX_TOOL_CALLS;
  const originalMaxToolErrors = process.env.UFOO_UCODE_MAX_TOOL_ERRORS;
  const originalMaxTokens = process.env.UFOO_UCODE_MAX_TOKENS;
  let workspaceRoot = "";

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
    delete process.env.OPENAI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.UFOO_UCODE_PROVIDER;
    delete process.env.UFOO_UCODE_MODEL;
    delete process.env.UFOO_UCODE_MAX_TOOL_CALLS;
    delete process.env.UFOO_UCODE_MAX_TOOL_ERRORS;
    delete process.env.UFOO_UCODE_MAX_TOKENS;
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
    if (typeof originalMaxToolCalls === "string") process.env.UFOO_UCODE_MAX_TOOL_CALLS = originalMaxToolCalls;
    else delete process.env.UFOO_UCODE_MAX_TOOL_CALLS;
    if (typeof originalMaxToolErrors === "string") process.env.UFOO_UCODE_MAX_TOOL_ERRORS = originalMaxToolErrors;
    else delete process.env.UFOO_UCODE_MAX_TOOL_ERRORS;
    if (typeof originalMaxTokens === "string") process.env.UFOO_UCODE_MAX_TOKENS = originalMaxTokens;
    else delete process.env.UFOO_UCODE_MAX_TOKENS;
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

  test("stops native tool loop immediately after bash tool error", async () => {
    process.env.UFOO_UCODE_MAX_TOOL_ERRORS = "1";
    global.fetch.mockImplementation(() => Promise.resolve(makeSseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_bad_bash",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: '{"command":"exit 1"}',
                  },
                },
              ],
            },
          },
        ],
      },
    ])));
    runToolCall.mockReturnValue({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "",
      error: "command exited with 1",
    });

    const events = [];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "run failing command",
      provider: "openai",
      model: "gpt-test",
      onToolEvent: (event) => events.push(event),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("tool error budget exceeded (1)");
    expect(result.error).toContain("bash: command exited with 1");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(runToolCall).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        tool: "bash",
        phase: "start",
        args: { command: "exit 1" },
        error: "",
      },
      {
        tool: "bash",
        phase: "error",
        args: { command: "exit 1" },
        error: "command exited with 1",
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

  test("emits phase events for openai with reasoning_content and tool_request", async () => {
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { reasoning_content: "let me think" } }] },
      { choices: [{ delta: { content: "Hello" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_a",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"AGENTS.md"}' },
                },
              ],
            },
          },
        ],
      },
    ]));
    runToolCall.mockReturnValue({ ok: true, content: "ok" });
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "done" } }] },
    ]));

    const phaseEvents = [];
    const thinkingDeltas = [];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "openai",
      model: "gpt-test",
      onPhase: (event) => phaseEvents.push(event),
      onThinkingDelta: (text) => thinkingDeltas.push(text),
    });

    expect(result.ok).toBe(true);
    expect(thinkingDeltas).toEqual(["let me think"]);
    const types = phaseEvents.map((e) => e.type);
    expect(types).toContain("request_start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_request");
    const toolReq = phaseEvents.find((e) => e.type === "tool_request");
    expect(toolReq.name).toBe("read");
  });

  test("emits phase events for anthropic with thinking_delta", async () => {
    const sse = [
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan first"}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"read","input":{}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"AGENTS.md\\"}"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    global.fetch.mockResolvedValueOnce(new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    runToolCall.mockReturnValue({ ok: true, content: "ok" });
    global.fetch.mockResolvedValueOnce(new Response([
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const phaseEvents = [];
    const thinkingDeltas = [];
    const textDeltas = [];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "anthropic",
      model: "claude-opus-4-6",
      onPhase: (event) => phaseEvents.push(event),
      onThinkingDelta: (text) => thinkingDeltas.push(text),
      onStreamDelta: (text) => textDeltas.push(text),
    });

    expect(result.ok).toBe(true);
    expect(thinkingDeltas).toEqual(["plan first"]);
    expect(textDeltas).toContain("Hi");
    const types = phaseEvents.map((e) => e.type);
    expect(types).toContain("request_start");
    expect(types).toContain("thinking_delta");
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_request");
    const toolReq = phaseEvents.find((e) => e.type === "tool_request");
    expect(toolReq.name).toBe("read");
  });

  test("uses default agent model when model is missing", async () => {
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "Hello" } }] },
    ]));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "openai",
      model: "",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("Hello");
    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(requestBody.model).toBe(defaultAgentModelForProvider("openai"));
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

  test("resolveTransport handles various provider/url combos", () => {
    expect(resolveTransport({ provider: "codex-cli" })).toBe("openai-chat");
    expect(resolveTransport({ provider: "claude-cli" })).toBe("anthropic-messages");
    expect(resolveTransport({ provider: "", baseUrl: "" })).toBe("openai-chat");
    expect(resolveTransport({ provider: "", baseUrl: "https://api.anthropic.com/v1" })).toBe("anthropic-messages");
  });

  test("resolveRuntimeConfig uses env vars", () => {
    process.env.UFOO_UCODE_PROVIDER = "anthropic";
    process.env.UFOO_UCODE_MODEL = "claude-sonnet";
    const config = resolveRuntimeConfig(workspaceRoot);
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet");
  });

  test("resolveTransport maps kimi aliases to openai-chat", () => {
    expect(resolveTransport({ provider: "kimi" })).toBe("openai-chat");
    expect(resolveTransport({ provider: "kimi-code" })).toBe("openai-chat");
    expect(resolveTransport({ provider: "moonshot" })).toBe("openai-chat");
  });

  test("runtime config maps kimi aliases with default url and model", () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-home-"));
    process.env.KIMI_CODE_HOME = kimiHome;
    try {
      for (const alias of ["kimi", "kimi-code", "moonshot"]) {
        const config = resolveRuntimeConfig({ workspaceRoot, provider: alias });
        expect(config.provider).toBe("kimi");
        expect(config.baseUrl).toBe("https://api.kimi.com/coding/v1");
        expect(config.model).toBe("k3");
        expect(config.transport).toBe("openai-chat");
        expect(config.apiKey).toBe("");
      }
    } finally {
      delete process.env.KIMI_CODE_HOME;
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  test("runtime config reads kimi credential file for apiKey", () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-home-"));
    const credentialDir = path.join(kimiHome, "credentials");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(path.join(credentialDir, "kimi-code.json"), JSON.stringify({
      access_token: "kimi-access-1",
      refresh_token: "kimi-refresh-1",
      expires_at: Math.floor((Date.now() + 3600 * 1000) / 1000),
    }));
    process.env.KIMI_CODE_HOME = kimiHome;
    try {
      const config = resolveRuntimeConfig({ workspaceRoot, provider: "kimi" });
      expect(config.apiKey).toBe("kimi-access-1");
      expect(config.apiKeySource).toBe("kimi-credential");
      expect(config.kimiCredentialState).toBe("fresh");

      process.env.UFOO_UCODE_API_KEY = "explicit-key";
      const overridden = resolveRuntimeConfig({ workspaceRoot, provider: "kimi" });
      expect(overridden.apiKey).toBe("explicit-key");
      expect(overridden.apiKeySource).toBe("explicit");
    } finally {
      delete process.env.KIMI_CODE_HOME;
      delete process.env.UFOO_UCODE_API_KEY;
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  test("kimi run refreshes near-expiry credential before the chat request", async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-home-"));
    const credentialDir = path.join(kimiHome, "credentials");
    fs.mkdirSync(credentialDir, { recursive: true });
    const credentialPath = path.join(credentialDir, "kimi-code.json");
    fs.writeFileSync(credentialPath, JSON.stringify({
      access_token: "kimi-access-old",
      refresh_token: "kimi-refresh-old",
      expires_at: Math.floor((Date.now() + 60 * 1000) / 1000),
    }));
    process.env.KIMI_CODE_HOME = kimiHome;

    global.fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "kimi-access-new",
        refresh_token: "kimi-refresh-new",
        token_type: "Bearer",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: "ok" } }] },
      ]));

    try {
      const result = await runNativeAgentTask({
        workspaceRoot,
        prompt: "Reply with exactly: ok",
        provider: "kimi",
      });

      expect(result.ok).toBe(true);
      expect(result.output).toBe("ok");
      expect(global.fetch).toHaveBeenCalledTimes(2);

      const [refreshUrl, refreshInit] = global.fetch.mock.calls[0];
      expect(refreshUrl).toBe("https://auth.kimi.com/api/oauth/token");
      expect(refreshInit.method).toBe("POST");
      expect(String(refreshInit.body)).toContain("grant_type=refresh_token");
      expect(String(refreshInit.body)).toContain("refresh_token=kimi-refresh-old");

      const [chatUrl, chatInit] = global.fetch.mock.calls[1];
      expect(chatUrl).toBe("https://api.kimi.com/coding/v1/chat/completions");
      expect(chatInit.headers.authorization).toBe("Bearer kimi-access-new");
      expect(JSON.parse(chatInit.body).model).toBe("k3");

      const saved = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
      expect(saved.access_token).toBe("kimi-access-new");
    } finally {
      delete process.env.KIMI_CODE_HOME;
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  test("kimi run uses fresh credential without a refresh round-trip", async () => {
    const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-home-"));
    const credentialDir = path.join(kimiHome, "credentials");
    fs.mkdirSync(credentialDir, { recursive: true });
    fs.writeFileSync(path.join(credentialDir, "kimi-code.json"), JSON.stringify({
      access_token: "kimi-access-fresh",
      refresh_token: "kimi-refresh-fresh",
      expires_at: Math.floor((Date.now() + 3600 * 1000) / 1000),
    }));
    process.env.KIMI_CODE_HOME = kimiHome;

    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "ok" } }] },
    ]));

    try {
      const result = await runNativeAgentTask({
        workspaceRoot,
        prompt: "Reply with exactly: ok",
        provider: "kimi",
      });

      expect(result.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const [chatUrl, chatInit] = global.fetch.mock.calls[0];
      expect(chatUrl).toBe("https://api.kimi.com/coding/v1/chat/completions");
      expect(chatInit.headers.authorization).toBe("Bearer kimi-access-fresh");
      // Kimi k3 rejects any temperature other than 1.
      expect(JSON.parse(chatInit.body).temperature).toBe(1);
    } finally {
      delete process.env.KIMI_CODE_HOME;
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  test("sends transport-specific default max_tokens", async () => {
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "ok" } }] },
    ]));
    const openAiResult = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hi",
      provider: "openai",
      model: "gpt-test",
    });
    expect(openAiResult.ok).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_tokens).toBe(131072);

    const anthropicSse = [
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    global.fetch.mockResolvedValueOnce(new Response(anthropicSse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const anthropicResult = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hi",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(anthropicResult.ok).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).max_tokens).toBe(64000);
  });

  test("UFOO_UCODE_MAX_TOKENS overrides max_tokens for both transports", async () => {
    process.env.UFOO_UCODE_MAX_TOKENS = "32000";
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "ok" } }] },
    ]));
    const openAiResult = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hi",
      provider: "openai",
      model: "gpt-test",
    });
    expect(openAiResult.ok).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_tokens).toBe(32000);

    global.fetch.mockResolvedValueOnce(new Response(
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));
    const anthropicResult = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hi",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(anthropicResult.ok).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).max_tokens).toBe(32000);
  });

  test("invalid UFOO_UCODE_MAX_TOKENS falls back to transport defaults", async () => {
    process.env.UFOO_UCODE_MAX_TOKENS = "not-a-number";
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "ok" } }] },
    ]));
    const openAiResult = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hi",
      provider: "openai",
      model: "gpt-test",
    });
    expect(openAiResult.ok).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).max_tokens).toBe(131072);

    process.env.UFOO_UCODE_MAX_TOKENS = "-5";
    global.fetch.mockResolvedValueOnce(new Response(
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));
    const anthropicResult = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hi",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(anthropicResult.ok).toBe(true);
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).max_tokens).toBe(64000);
  });

  test("does not collapse parallel tool calls when stream omits index", async () => {
    global.fetch
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "call_2", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
                ],
              },
            },
          ],
        },
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: "done" } }] },
      ]));
    runToolCall.mockReturnValue({ ok: true, content: "ok" });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "openai",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    expect(runToolCall).toHaveBeenCalledTimes(2);
    expect(runToolCall).toHaveBeenNthCalledWith(1,
      { tool: "read", args: { path: "a.txt" } },
      { workspaceRoot, cwd: workspaceRoot }
    );
    expect(runToolCall).toHaveBeenNthCalledWith(2,
      { tool: "bash", args: { command: "ls" } },
      { workspaceRoot, cwd: workspaceRoot }
    );
  });

  test("appends argument fragments without id to the latest synthetic tool call", async () => {
    global.fetch
      .mockResolvedValueOnce(makeSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { function: { arguments: '.txt"}' } },
                ],
              },
            },
          ],
        },
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: "done" } }] },
      ]));
    runToolCall.mockReturnValue({ ok: true, content: "ok" });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "openai",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    expect(runToolCall).toHaveBeenCalledTimes(1);
    expect(runToolCall).toHaveBeenCalledWith(
      { tool: "read", args: { path: "a.txt" } },
      { workspaceRoot, cwd: workspaceRoot }
    );
  });

  test("does not drop blocks after [DONE] within the same SSE batch", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      "",
      "data: [DONE]",
      "",
      'data: {"choices":[{"delta":{"content":" world"}}]}',
      "",
      "",
    ].join("\n");
    const encoder = new TextEncoder();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader() {
          let sent = false;
          return {
            read() {
              if (sent) return Promise.resolve({ done: true, value: undefined });
              sent = true;
              return Promise.resolve({ done: false, value: encoder.encode(sse) });
            },
          };
        },
      },
    });

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
    expect(deltas).toEqual(["Hello", " world"]);
  });

  test("does not collapse anthropic content blocks when stream omits index", async () => {
    const sse = [
      "event: content_block_start",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"read","input":{}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"t2","name":"bash","input":{}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    global.fetch.mockResolvedValueOnce(new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    runToolCall.mockReturnValue({ ok: true, content: "ok" });
    global.fetch.mockResolvedValueOnce(new Response([
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    expect(result.ok).toBe(true);
    expect(runToolCall).toHaveBeenCalledTimes(2);
    expect(runToolCall).toHaveBeenNthCalledWith(1,
      { tool: "read", args: { path: "a.txt" } },
      { workspaceRoot, cwd: workspaceRoot }
    );
    expect(runToolCall).toHaveBeenNthCalledWith(2,
      { tool: "bash", args: { command: "ls" } },
      { workspaceRoot, cwd: workspaceRoot }
    );
  });

  test("stops tool loop after exactly max tool calls", async () => {
    process.env.UFOO_UCODE_MAX_TOOL_CALLS = "2";
    global.fetch.mockImplementation(() => Promise.resolve(makeSseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_loop",
                  type: "function",
                  function: { name: "read", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
          },
        ],
      },
    ])));
    runToolCall.mockReturnValue({ ok: true, content: "ok" });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "loop",
      provider: "openai",
      model: "gpt-test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("tool call budget exceeded (2)");
    expect(runToolCall).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test("write tool spec declares the mode parameter supported by the implementation", async () => {
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "ok" } }] },
    ]));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hi",
      provider: "openai",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    const writeSpec = requestBody.tools.find((tool) => tool.function.name === "write");
    expect(writeSpec).toBeDefined();
    // src/code/tools/write.js treats mode "append" (or append: true) as
    // append and anything else as overwrite, so the schema must expose it.
    expect(writeSpec.function.parameters.properties.mode).toEqual({
      type: "string",
      enum: ["overwrite", "append"],
      description: expect.stringContaining("append"),
    });
    expect(writeSpec.function.parameters.required).toEqual(["path", "content"]);
  });

  test("returns partial output when the stream fails mid-response", async () => {
    const encoder = new TextEncoder();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader() {
          let calls = 0;
          return {
            read() {
              calls += 1;
              if (calls === 1) {
                return Promise.resolve({
                  done: false,
                  value: encoder.encode('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n'),
                });
              }
              return Promise.reject(new Error("stream reset"));
            },
          };
        },
      },
    });

    const deltas = [];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "openai",
      model: "gpt-test",
      onStreamDelta: (delta) => deltas.push(delta),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("stream reset");
    expect(result.output).toBe("partial answer");
    expect(deltas).toEqual(["partial answer"]);
  });

  test("stops reading the anthropic stream after [DONE]", async () => {
    const encoder = new TextEncoder();
    const firstBatch = [
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "data: [DONE]",
      "",
      "",
    ].join("\n");
    const secondBatch = [
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"LATE"}}',
      "",
      "",
    ].join("\n");

    let readCalls = 0;
    global.fetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader() {
          return {
            read() {
              readCalls += 1;
              if (readCalls === 1) {
                return Promise.resolve({ done: false, value: encoder.encode(firstBatch) });
              }
              if (readCalls === 2) {
                return Promise.resolve({ done: false, value: encoder.encode(secondBatch) });
              }
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      },
    });

    const deltas = [];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "anthropic",
      model: "claude-opus-4-6",
      onStreamDelta: (delta) => deltas.push(delta),
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("Hi");
    expect(deltas).toEqual(["Hi"]);
    expect(readCalls).toBe(1);
  });

  test("parses anthropic stream usage from message_start and message_delta", async () => {
    const sse = [
      "event: message_start",
      'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6","usage":{"input_tokens":1200,"cache_creation_input_tokens":300,"cache_read_input_tokens":800,"output_tokens":1}}}',
      "",
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "event: content_block_stop",
      'data: {"type":"content_block_stop","index":0}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":42}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    global.fetch.mockResolvedValueOnce(new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "anthropic",
      model: "claude-opus-4-6",
      systemPrompt: "project rules",
    });

    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({
      turns: 1,
      input: 1200,
      output: 42,
      cacheRead: 800,
      cacheCreation: 300,
    });

    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(requestBody.system).toEqual([
      {
        type: "text",
        text: "project rules",
        cache_control: { type: "ephemeral" },
      },
    ]);
    // The only history message becomes a text block carrying the second
    // cache breakpoint.
    expect(requestBody.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hello",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    const headers = global.fetch.mock.calls[0][1].headers;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("stamps the cache breakpoint only on the last anthropic history message without mutating history", async () => {
    global.fetch.mockResolvedValueOnce(new Response([
      "event: content_block_start",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      "",
      "event: message_stop",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    const history = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
    ];
    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "second question",
      provider: "anthropic",
      model: "claude-opus-4-6",
      messages: history,
    });

    expect(result.ok).toBe(true);
    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(requestBody.messages).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "second question",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    // History array stays free of cache_control so later turns never carry
    // stale breakpoints past the 4-breakpoint limit.
    expect(JSON.stringify(history)).not.toContain("cache_control");
  });

  test("requests include_usage and parses the terminal openai usage chunk", async () => {
    global.fetch.mockResolvedValueOnce(makeSseResponse([
      { choices: [{ delta: { content: "Hello" } }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      },
    ]));

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "openai",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({
      turns: 1,
      input: 100,
      output: 20,
      cacheRead: 40,
      cacheCreation: 0,
    });
    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(requestBody.stream_options).toEqual({ include_usage: true });
  });

  test("reads usage from a non-streaming openai response", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "plain answer", tool_calls: [] } }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      }),
    });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "hello",
      provider: "openai",
      model: "gpt-test",
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe("plain answer");
    expect(result.usage).toEqual({
      turns: 1,
      input: 12,
      output: 5,
      cacheRead: 4,
      cacheCreation: 0,
    });
  });

  test("accumulates usage across tool-loop turns and appends one usage.jsonl row", async () => {
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
                    function: { name: "read", arguments: '{"path":"a.txt"}' },
                  },
                ],
              },
            },
          ],
        },
        { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } },
      ]))
      .mockResolvedValueOnce(makeSseResponse([
        { choices: [{ delta: { content: "done" } }] },
        {
          choices: [],
          usage: {
            prompt_tokens: 80,
            completion_tokens: 15,
            prompt_tokens_details: { cached_tokens: 30 },
          },
        },
      ]));
    runToolCall.mockReturnValue({ ok: true, content: "ok" });

    const result = await runNativeAgentTask({
      workspaceRoot,
      prompt: "go",
      provider: "openai",
      model: "gpt-test",
      sessionId: "sess-usage-1",
    });

    expect(result.ok).toBe(true);
    expect(result.usage).toEqual({
      turns: 2,
      input: 130,
      output: 25,
      cacheRead: 30,
      cacheCreation: 0,
    });

    const usageFile = path.join(workspaceRoot, ".ufoo", "agent", "ucode", "usage.jsonl");
    const rows = fs.readFileSync(usageFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "sess-usage-1",
      model: "gpt-test",
      provider: "openai",
      turns: 2,
      input: 130,
      output: 25,
      cacheRead: 30,
      cacheCreation: 0,
    });
    expect(typeof rows[0].ts).toBe("string");
  });
});

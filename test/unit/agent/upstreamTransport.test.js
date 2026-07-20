jest.mock("../../../src/code/nativeRunner", () => ({
  resolveRuntimeConfig: jest.fn(() => ({
    provider: "openai",
    model: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "runtime-key",
    transport: "openai-chat",
  })),
  resolveCompletionUrl: jest.fn((baseUrl = "") => `${String(baseUrl || "").replace(/\/+$/, "")}/chat/completions`),
  resolveAnthropicMessagesUrl: jest.fn((baseUrl = "") => `${String(baseUrl || "").replace(/\/+$/, "")}/messages`),
}));

jest.mock("../../../src/agents/providers/credentials/codex", () => ({
  resolveCodexUpstreamCredentials: jest.fn(),
}));

jest.mock("../../../src/agents/providers/credentials/claude", () => ({
  resolveClaudeUpstreamCredentials: jest.fn(),
}));

const { resolveRuntimeConfig } = require("../../../src/code/nativeRunner");
const { resolveCodexUpstreamCredentials } = require("../../../src/agents/providers/credentials/codex");
const { resolveClaudeUpstreamCredentials } = require("../../../src/agents/providers/credentials/claude");
const {
  buildAnthropicMessagesRequest,
  buildCodexResponsesRequest,
  normalizeProvider,
  parseCodexSsePayload,
  resolveUpstreamRuntime,
  sendUpstreamPrompt,
} = require("../../../src/agents/providers/upstreamTransport");

describe("agent upstreamTransport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("normalizes provider aliases for direct-upstream routing", () => {
    expect(normalizeProvider("codex-cli")).toBe("codex");
    expect(normalizeProvider("openai")).toBe("codex");
    expect(normalizeProvider("claude-cli")).toBe("claude");
    expect(normalizeProvider("anthropic")).toBe("claude");
    expect(normalizeProvider("ucode")).toBe("ucode");
    expect(normalizeProvider("ufoo")).toBe("ucode");
  });

  test("builds codex responses request with developer and user input items", () => {
    expect(buildCodexResponsesRequest({
      model: "gpt-5.3-codex-spark",
      systemPrompt: "system rules",
      prompt: "hello",
      messages: [{ role: "assistant", content: "prior reply" }],
    })).toEqual({
      model: "gpt-5.3-codex-spark",
      instructions: "system rules",
      stream: true,
      store: false,
      parallel_tool_calls: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium", summary: "auto" },
      input: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "prior reply" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    });
  });

  test("builds anthropic request with cache_control on the system prompt", () => {
    expect(buildAnthropicMessagesRequest({
      model: "claude-sonnet",
      systemPrompt: "system rules",
      prompt: "hello",
    })).toEqual({
      model: "claude-sonnet",
      max_tokens: 4096,
      temperature: 0,
      system: [{
        type: "text",
        text: "system rules",
        cache_control: { type: "ephemeral" },
      }],
      messages: [{ role: "user", content: "hello" }],
    });
  });

  test("marks the last user message with cache_control when history is long", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet",
      systemPrompt: "system rules",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    });
    expect(request.messages[0]).toEqual({ role: "user", content: "first" });
    expect(request.messages[1]).toEqual({ role: "assistant", content: "reply" });
    expect(request.messages[2]).toEqual({
      role: "user",
      content: [{
        type: "text",
        text: "second",
        cache_control: { type: "ephemeral" },
      }],
    });
  });

  test("leaves short anthropic history untouched by message breakpoints", () => {
    const request = buildAnthropicMessagesRequest({
      model: "claude-sonnet",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
      ],
    });
    expect(request.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
    ]);
    expect(request.system).toBeUndefined();
  });

  test("parses codex SSE payload into output text and usage", () => {
    const parsed = parseCodexSsePayload([
      'data: {"type":"response.output_text.delta","delta":"hel"}',
      'data: {"type":"response.output_text.delta","delta":"lo"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":2},"output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]}}',
    ].join("\n"));
    expect(parsed.text).toBe("hello");
    expect(parsed.usage).toEqual({ input_tokens: 4, output_tokens: 2 });
  });

  test("resolves codex runtime from oauth credential bridge to codex responses transport", async () => {
    resolveCodexUpstreamCredentials.mockResolvedValue({
      provider: "codex",
      credentialKind: "oauth",
      accessToken: "codex-access",
      tokenType: "Bearer",
      source: "auth-file",
      accountId: "acct_123",
    });

    await expect(resolveUpstreamRuntime({
      projectRoot: "/tmp/project",
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      env: {},
      loadConfigImpl: () => ({ codexAuthPath: "/tmp/codex-auth.json" }),
    })).resolves.toMatchObject({
      provider: "codex",
      transport: "codex-responses",
      model: "gpt-5.3-codex-spark",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      credentialSource: "auth-file",
      auth: {
        headers: {
          authorization: "Bearer codex-access",
        },
      },
    });
    expect(resolveCodexUpstreamCredentials).toHaveBeenCalledWith(expect.objectContaining({
      authPath: "/tmp/codex-auth.json",
      refreshWindowMs: 300000,
    }));
  });

  test("sendUpstreamPrompt returns structured credential errors", async () => {
    const err = new Error("Codex auth unavailable");
    err.code = "CODEX_AUTH_UNAVAILABLE";
    resolveCodexUpstreamCredentials.mockRejectedValue(err);

    await expect(sendUpstreamPrompt({
      projectRoot: "/tmp/project",
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      prompt: "hello",
      env: {},
      loadConfigImpl: () => ({ codexAuthPath: "/tmp/missing.json" }),
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorCode: "CODEX_AUTH_UNAVAILABLE",
      provider: "codex",
      model: "gpt-5.3-codex-spark",
    }));
  });

  test("resolves codex runtime from api-key credential bridge to openai transport", async () => {
    resolveCodexUpstreamCredentials.mockResolvedValue({
      provider: "codex",
      credentialKind: "api-key",
      apiKey: "sk-test",
      tokenType: "Bearer",
      source: "env:OPENAI_API_KEY",
    });

    await expect(resolveUpstreamRuntime({
      projectRoot: "/tmp/project",
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      env: { OPENAI_BASE_URL: "https://openai.example/v1" },
      loadConfigImpl: () => ({ codexAuthPath: "" }),
    })).resolves.toMatchObject({
      provider: "codex",
      transport: "openai-chat",
      baseUrl: "https://openai.example/v1",
      auth: { apiKey: "sk-test" },
    });
  });

  test("resolves claude runtime from credential bridge", async () => {
    resolveClaudeUpstreamCredentials.mockResolvedValue({
      provider: "claude",
      credentialKind: "api-key",
      apiKey: "claude-key",
      tokenType: "Bearer",
      source: "api-key",
    });

    await expect(resolveUpstreamRuntime({
      projectRoot: "/tmp/project",
      provider: "claude",
      model: "claude-3-7-sonnet",
      env: { ANTHROPIC_BASE_URL: "https://anthropic.example/v1" },
      loadConfigImpl: () => ({
        claudeOauthProfile: "work",
        claudeOauthTokenPath: "/tmp/claude-oauth.json",
        claudeOauthRefreshWindowSec: 120,
      }),
    })).resolves.toMatchObject({
      provider: "claude",
      transport: "anthropic-messages",
      model: "claude-3-7-sonnet",
      baseUrl: "https://anthropic.example/v1",
      credentialSource: "api-key",
      auth: {
        apiKey: "claude-key",
      },
    });
  });

  test("uses provider-specific default model when explicit provider has no model", async () => {
    resolveClaudeUpstreamCredentials.mockResolvedValue({
      provider: "claude",
      credentialKind: "api-key",
      apiKey: "claude-key",
      tokenType: "Bearer",
      source: "api-key",
    });

    await expect(resolveUpstreamRuntime({
      projectRoot: "/tmp/project",
      provider: "claude",
      model: "",
      env: {},
      loadConfigImpl: () => ({
        agentProvider: "codex-cli",
        agentModel: "gpt-5.5",
        routerProvider: "codex",
        routerModel: "gpt-5.3-codex-spark",
      }),
    })).resolves.toMatchObject({
      provider: "claude",
      model: "sonnet-4.7",
    });
  });

  test("falls back to legacy runtime config for ucode path", async () => {
    await expect(resolveUpstreamRuntime({
      projectRoot: "/tmp/project",
      provider: "ucode",
      model: "gpt-4o-mini",
      env: {},
      loadConfigImpl: () => ({}),
    })).resolves.toMatchObject({
      provider: "openai",
      transport: "openai-chat",
      model: "gpt-4o-mini",
      baseUrl: "https://api.openai.com/v1",
      auth: {
        apiKey: "runtime-key",
      },
    });
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  test("sends codex upstream prompt through codex responses transport", async () => {
    resolveCodexUpstreamCredentials.mockResolvedValue({
      provider: "codex",
      credentialKind: "oauth",
      accessToken: "codex-access",
      tokenType: "Bearer",
      source: "auth-file",
      accountId: "acct_123",
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'data: {"type":"response.output_text.delta","delta":"{\\"reply\\":\\"ok"}',
        'data: {"type":"response.output_text.delta","delta":"\\"}"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":3}}}',
      ].join("\n"),
    });

    const result = await sendUpstreamPrompt({
      projectRoot: "/tmp/project",
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      prompt: "hello",
      systemPrompt: "system",
      fetchImpl,
      env: {},
      loadConfigImpl: () => ({ codexAuthPath: "/tmp/codex-auth.json" }),
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      transport: "codex-responses",
      credentialSource: "auth-file",
      output: "{\"reply\":\"ok\"}",
      usage: { input_tokens: 8, output_tokens: 3 },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer codex-access",
          Originator: "codex-tui",
          "Chatgpt-Account-Id": "acct_123",
          Accept: "text/event-stream",
        }),
      }),
    );
  });

  test("sends claude upstream prompt through anthropic transport", async () => {
    resolveClaudeUpstreamCredentials.mockResolvedValue({
      provider: "claude",
      credentialKind: "oauth",
      accessToken: "claude-access",
      tokenType: "Bearer",
      source: "oauth",
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "{\"target\":\"reviewer\"}" }],
      }),
    });

    const result = await sendUpstreamPrompt({
      projectRoot: "/tmp/project",
      provider: "claude",
      model: "claude-sonnet",
      prompt: "route this",
      systemPrompt: "system",
      fetchImpl,
      env: {},
      loadConfigImpl: () => ({
        claudeOauthProfile: "",
        claudeOauthTokenPath: "",
        claudeOauthRefreshWindowSec: 300,
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "claude",
      model: "claude-sonnet",
      transport: "anthropic-messages",
      credentialSource: "oauth",
      output: "{\"target\":\"reviewer\"}",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer claude-access",
          "anthropic-version": "2023-06-01",
        }),
      }),
    );
  });
});

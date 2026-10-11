jest.mock("../../../src/agents/providers/runtimeConfig", () => ({
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
jest.mock("../../../src/agents/providers/credentials/kimi", () => ({ resolveKimiUpstreamCredentials: jest.fn() }));

const { resolveRuntimeConfig } = require("../../../src/agents/providers/runtimeConfig");
const { resolveCodexUpstreamCredentials } = require("../../../src/agents/providers/credentials/codex");
const { resolveClaudeUpstreamCredentials } = require("../../../src/agents/providers/credentials/claude");
const { resolveKimiUpstreamCredentials } = require("../../../src/agents/providers/credentials/kimi");
const {
  normalizeProvider,
  resolveUpstreamRuntime,
} = require("../../../src/agents/providers/upstreamRuntime");

describe("agent upstreamRuntime", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("normalizes provider aliases for direct-upstream routing", () => {
    expect(normalizeProvider("codex-cli")).toBe("codex");
    expect(normalizeProvider("openai")).toBe("codex");
    expect(normalizeProvider("claude-cli")).toBe("claude");
    expect(normalizeProvider("anthropic")).toBe("claude");
    expect(normalizeProvider("ucode")).toBe("ucode");
    expect(normalizeProvider("ufoo")).toBe("ufoo");
    expect(normalizeProvider("grok-build")).toBe("grok");
    expect(normalizeProvider("xai")).toBe("grok");
  });


  test("Claude requests use the endpoint owned by the resolved settings credential", async () => {
    resolveClaudeUpstreamCredentials.mockResolvedValueOnce({ provider: "claude", credentialKind: "oauth", accessToken: "gateway-token", metadata: { baseUrl: "https://gateway.invalid/api" } });
    const runtime = await resolveUpstreamRuntime({ projectRoot: "/tmp/project", provider: "claude", model: "test", env: {}, loadConfigImpl: () => ({}) });
    expect(runtime.baseUrl).toBe("https://gateway.invalid/api");
    expect(runtime.auth.headers.authorization).toBe("Bearer gateway-token");
  });
  test("Kimi host refreshes provider-owned credentials before model execution", async () => {
    resolveRuntimeConfig.mockReturnValueOnce({ provider: "kimi", model: "kimi-for-coding", transport: "openai-chat", baseUrl: "https://kimi.invalid/v1", apiKey: "expired-key", apiKeySource: "kimi-credential" });
    resolveKimiUpstreamCredentials.mockResolvedValueOnce({ accessToken: "refreshed-key" });
    const runtime = await resolveUpstreamRuntime({ projectRoot: "/tmp/project", provider: "kimi", env: {}, loadConfigImpl: () => ({}) });
    expect(runtime.auth.apiKey).toBe("refreshed-key");
    expect(resolveRuntimeConfig).toHaveBeenLastCalledWith(expect.objectContaining({ provider: "kimi", useCodingConfig: false }));
    expect(resolveKimiUpstreamCredentials).toHaveBeenCalledTimes(1);
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
      requestProfile: "codex-subscription",
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



  test("resolves codex runtime from api-key credential bridge to Responses transport", async () => {
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
      transport: "codex-responses",
      requestProfile: "openai-responses",
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

  test("uses the agent provider default model when explicit provider has no model", async () => {
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
      model: "claude-opus-5-5",
    });
  });

  test("the main agent model is used even when a different router model is present", async () => {
    resolveCodexUpstreamCredentials.mockResolvedValue({
      provider: "codex",
      credentialKind: "api-key",
      apiKey: "isolated-key",
      tokenType: "Bearer",
      source: "api-key",
    });

    await expect(resolveUpstreamRuntime({
      projectRoot: "/tmp/project",
      provider: "codex",
      env: {},
      loadConfigImpl: () => ({
        agentProvider: "codex-cli",
        agentModel: "main-model",
        routerProvider: "codex",
        routerModel: "obsolete-router-model",
      }),
    })).resolves.toMatchObject({ provider: "codex", model: "main-model" });
  });

  test("resolves inherited runtime config for ucode", async () => {
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








});

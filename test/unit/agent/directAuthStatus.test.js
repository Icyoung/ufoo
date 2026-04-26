jest.mock("../../../src/agent/credentials/codex", () => ({
  resolveCodexAuthPaths: jest.fn(({ authPath } = {}) => ({
    configDir: "/tmp/codex",
    authPath: authPath || "/tmp/codex/auth.json",
  })),
  resolveCodexUpstreamCredentials: jest.fn(),
}));
jest.mock("../../../src/agent/credentials/claude", () => ({
  resolveClaudeOauthPaths: jest.fn(({ profile = "", tokenPath = "" } = {}) => ({
    configDir: "/tmp/claude",
    profile,
    profileDir: profile ? `/tmp/claude/profiles/${profile}` : "/tmp/claude",
    tokenPath: tokenPath || (profile ? `/tmp/claude/profiles/${profile}/oauth.json` : "/tmp/claude/oauth.json"),
    lockPath: `${tokenPath || (profile ? `/tmp/claude/profiles/${profile}/oauth.json` : "/tmp/claude/oauth.json")}.lock`,
  })),
  resolveClaudeUpstreamCredentials: jest.fn(),
}));

const {
  resolveCodexAuthPaths,
  resolveCodexUpstreamCredentials,
} = require("../../../src/agent/credentials/codex");
const {
  resolveClaudeUpstreamCredentials,
} = require("../../../src/agent/credentials/claude");
const {
  inspectDirectAuthStatus,
  inspectCodexDirectAuth,
  inspectClaudeDirectAuth,
  formatDirectAuthStatus,
  formatCodexDirectAuthStatus,
  formatClaudeDirectAuthStatus,
} = require("../../../src/agent/directAuthStatus");

describe("agent directAuthStatus", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("inspects codex direct credentials without auto-refresh by default", async () => {
    resolveCodexUpstreamCredentials.mockResolvedValue({
      provider: "codex",
      credentialKind: "oauth",
      accessToken: "access-token",
      tokenType: "Bearer",
      source: "auth-file",
      state: "near_expiry",
      refreshable: true,
      accountEmail: "dev@example.com",
      accountId: "acct_123",
      expiresAt: "2026-04-26T12:00:00.000Z",
      credentialPath: "/tmp/codex/auth.json",
    });

    const result = await inspectCodexDirectAuth({
      projectRoot: "/tmp/project",
      env: {},
      loadConfigImpl: () => ({
        codexAuthPath: "/tmp/codex/auth.json",
        codexOauthRefreshWindowSec: 120,
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "codex",
      transport: "codex-responses",
      credentialKind: "oauth",
      state: "near_expiry",
      refreshable: true,
      account: "dev@example.com (acct_123)",
    });
    expect(resolveCodexUpstreamCredentials).toHaveBeenCalledWith(expect.objectContaining({
      authPath: "/tmp/codex/auth.json",
      refreshWindowMs: 120000,
      autoRefresh: false,
    }));
  });

  test("formats unavailable credentials with local login hint", async () => {
    const err = new Error("Codex auth file not found and OPENAI_API_KEY is unset");
    err.code = "CODEX_AUTH_UNAVAILABLE";
    resolveCodexUpstreamCredentials.mockRejectedValue(err);

    const result = await inspectCodexDirectAuth({
      projectRoot: "/tmp/project",
      env: {},
      loadConfigImpl: () => ({ codexAuthPath: "/tmp/missing.json" }),
    });
    const lines = formatCodexDirectAuthStatus(result);

    expect(resolveCodexAuthPaths).toHaveBeenCalledWith({ authPath: "/tmp/missing.json" });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("CODEX_AUTH_UNAVAILABLE");
    expect(lines.join("\n")).toContain("Codex direct API: FAIL");
    expect(lines.join("\n")).toContain("Run Codex login once or set OPENAI_API_KEY");
    expect(lines.join("\n")).not.toContain("access-token");
  });

  test("formats compact chat status without path or account id noise", () => {
    const lines = formatCodexDirectAuthStatus({
      ok: true,
      transport: "codex-responses",
      credentialKind: "oauth",
      state: "fresh",
      source: "auth-file",
      account: "dev@example.com (acct_123)",
      accountEmail: "dev@example.com",
      accountId: "acct_123",
      expiresAt: "2026-05-06T16:05:33.613Z",
      credentialPath: "/tmp/codex/auth.json",
      refreshable: true,
    }, { compact: true });

    expect(lines).toEqual([
      "Codex API: OK · oauth/codex-responses · fresh",
      "  auth-file · dev@example.com · expires 2026-05-06 16:05Z · refreshable",
    ]);
    expect(lines.join("\n")).not.toContain("acct_123");
    expect(lines.join("\n")).not.toContain("/tmp/codex/auth.json");
  });

  test("inspects configured claude provider instead of codex", async () => {
    resolveClaudeUpstreamCredentials.mockResolvedValue({
      provider: "claude",
      credentialKind: "oauth",
      source: "oauth",
      state: "fresh",
      refreshable: true,
      profile: "work",
      expiresAt: "2026-05-06T16:05:33.613Z",
      credentialPath: "/tmp/claude/profiles/work/oauth.json",
    });

    const result = await inspectDirectAuthStatus({
      projectRoot: "/tmp/project",
      env: {},
      loadConfigImpl: () => ({
        agentProvider: "claude-cli",
        claudeOauthProfile: "work",
        claudeOauthRefreshWindowSec: 180,
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "claude",
      transport: "anthropic-messages",
      profile: "work",
      state: "fresh",
    });
    expect(resolveClaudeUpstreamCredentials).toHaveBeenCalledWith(expect.objectContaining({
      profile: "work",
      refreshWindowMs: 180000,
    }));
    expect(resolveCodexUpstreamCredentials).not.toHaveBeenCalled();
  });

  test("formats compact claude status", () => {
    const lines = formatDirectAuthStatus({
      ok: true,
      provider: "claude",
      transport: "anthropic-messages",
      credentialKind: "oauth",
      source: "oauth",
      state: "fresh",
      profile: "work",
      expiresAt: "2026-05-06T16:05:33.613Z",
      credentialPath: "/tmp/claude/profiles/work/oauth.json",
      refreshable: true,
    }, { compact: true });

    expect(lines).toEqual([
      "Claude API: OK · oauth/anthropic-messages · fresh",
      "  oauth · profile work · expires 2026-05-06 16:05Z · refreshable",
    ]);
    expect(lines.join("\n")).not.toContain("/tmp/claude");
    expect(formatClaudeDirectAuthStatus({ ok: false, provider: "claude", errorCode: "CLAUDE_AUTH_UNAVAILABLE" }, { compact: true })[0])
      .toBe("Claude API: FAIL · CLAUDE_AUTH_UNAVAILABLE");
  });
});

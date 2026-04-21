const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  ClaudeOauthTokenReader,
  resolveClaudeOauthPaths,
  parseClaudeOauthFile,
  classifyTokenState,
} = require("../../../src/agent/claudeOauthTokenReader");

function writeV1Token(filePath, overrides = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    version: "claude-code-oauth-v1",
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: "2026-04-20T10:10:00.000Z",
    tokenType: "Bearer",
    refreshUrl: "https://auth.example/refresh",
    ...overrides,
  }, null, 2));
}

describe("agent claudeOauthTokenReader", () => {
  test("resolves profile and explicit token paths", () => {
    const root = path.join(os.tmpdir(), "ufoo-claude-oauth-paths");
    expect(resolveClaudeOauthPaths({ configDir: root, profile: "work" })).toEqual({
      configDir: root,
      profile: "work",
      profileDir: path.join(root, "profiles", "work"),
      tokenPath: path.join(root, "profiles", "work", "oauth.json"),
      lockPath: path.join(root, "profiles", "work", "oauth.json.lock"),
    });

    expect(resolveClaudeOauthPaths({
      configDir: root,
      profile: "ignored",
      tokenPath: path.join(root, "custom.json"),
    }).tokenPath).toBe(path.join(root, "custom.json"));
  });

  test("sniffs supported token schema and rejects unknown schema", () => {
    expect(parseClaudeOauthFile({
      version: "claude-code-oauth-v1",
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-04-20T10:10:00.000Z",
    }).schemaVersion).toBe("claude-code-oauth-v1");

    expect(parseClaudeOauthFile({
      version: 2,
      oauth: {
        access_token: "a",
        refresh_token: "r",
        expires_at: "2026-04-20T10:10:00.000Z",
      },
    }).schemaVersion).toBe("claude-code-oauth-v2");

    expect(() => parseClaudeOauthFile({ version: "future" })).toThrow(/Unsupported Claude OAuth token schema/);
  });

  test("classifies token freshness states", () => {
    const now = Date.parse("2026-04-20T10:00:00.000Z");
    expect(classifyTokenState(Date.parse("2026-04-20T10:20:00.000Z"), now, 5 * 60 * 1000)).toBe("fresh");
    expect(classifyTokenState(Date.parse("2026-04-20T10:03:00.000Z"), now, 5 * 60 * 1000)).toBe("near_expiry");
    expect(classifyTokenState(Date.parse("2026-04-20T09:59:00.000Z"), now, 5 * 60 * 1000)).toBe("expired");
    expect(classifyTokenState(NaN, now, 5 * 60 * 1000)).toBe("invalid");
  });

  test("prefers ANTHROPIC_API_KEY over oauth file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-api-key-"));
    const tokenPath = path.join(dir, "oauth.json");
    writeV1Token(tokenPath);

    const reader = new ClaudeOauthTokenReader({
      tokenPath,
      env: { ANTHROPIC_API_KEY: "api-key-1" },
    });

    await expect(reader.resolveAuth()).resolves.toMatchObject({
      source: "api-key",
      token: "api-key-1",
      tokenPath: "",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns fresh oauth token without refresh", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-fresh-"));
    const tokenPath = path.join(dir, "oauth.json");
    writeV1Token(tokenPath, { expiresAt: "2026-04-20T10:30:00.000Z" });

    const refreshAccessToken = jest.fn();
    const reader = new ClaudeOauthTokenReader({
      tokenPath,
      now: () => Date.parse("2026-04-20T10:00:00.000Z"),
      refreshWindowMs: 5 * 60 * 1000,
      refreshAccessToken,
    });

    await expect(reader.resolveAuth()).resolves.toMatchObject({
      source: "oauth",
      token: "access-1",
      state: "fresh",
    });
    expect(refreshAccessToken).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refreshes near-expiry token and writes back atomically", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-near-"));
    const tokenPath = path.join(dir, "oauth.json");
    writeV1Token(tokenPath, { expiresAt: "2026-04-20T10:03:00.000Z" });

    const refreshAccessToken = jest.fn(async () => ({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: "2026-04-20T11:00:00.000Z",
    }));

    const reader = new ClaudeOauthTokenReader({
      tokenPath,
      now: () => Date.parse("2026-04-20T10:00:00.000Z"),
      refreshWindowMs: 5 * 60 * 1000,
      refreshAccessToken,
    });

    await expect(reader.resolveAuth()).resolves.toMatchObject({
      source: "oauth",
      token: "access-2",
      state: "fresh",
    });
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
    expect(saved.accessToken).toBe("access-2");
    expect(saved.refreshToken).toBe("refresh-2");
    expect(saved.expiresAt).toBe("2026-04-20T11:00:00.000Z");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refreshes expired token and leaves old file intact on refresh failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-expired-"));
    const tokenPath = path.join(dir, "oauth.json");
    writeV1Token(tokenPath, { expiresAt: "2026-04-20T09:59:00.000Z" });
    const before = fs.readFileSync(tokenPath, "utf8");

    const reader = new ClaudeOauthTokenReader({
      tokenPath,
      now: () => Date.parse("2026-04-20T10:00:00.000Z"),
      refreshWindowMs: 5 * 60 * 1000,
      refreshAccessToken: async () => {
        throw new Error("refresh failed");
      },
    });

    await expect(reader.resolveAuth()).rejects.toThrow(/refresh failed/);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(before);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("invalid expiry is surfaced as invalid state and refreshable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-invalid-"));
    const tokenPath = path.join(dir, "oauth.json");
    writeV1Token(tokenPath, { expiresAt: "not-a-timestamp" });

    const reader = new ClaudeOauthTokenReader({
      tokenPath,
      now: () => Date.parse("2026-04-20T10:00:00.000Z"),
      refreshWindowMs: 5 * 60 * 1000,
      refreshAccessToken: async () => ({
        accessToken: "access-3",
        refreshToken: "refresh-3",
        expiresAt: "2026-04-20T11:30:00.000Z",
      }),
    });

    await expect(reader.resolveAuth()).resolves.toMatchObject({
      token: "access-3",
      state: "fresh",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("throws a recognizable error when no oauth token and no api key are available", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-missing-"));
    const reader = new ClaudeOauthTokenReader({
      tokenPath: path.join(dir, "missing.json"),
      env: {},
    });

    await expect(reader.resolveAuth()).rejects.toMatchObject({
      code: "CLAUDE_AUTH_UNAVAILABLE",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("concurrent refresh attempts serialize and refresh only once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-claude-concurrent-"));
    const tokenPath = path.join(dir, "oauth.json");
    writeV1Token(tokenPath, { expiresAt: "2026-04-20T10:02:00.000Z" });

    let releaseRefresh;
    const refreshGate = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshAccessToken = jest.fn(async () => {
      await refreshGate;
      return {
        accessToken: "access-4",
        refreshToken: "refresh-4",
        expiresAt: "2026-04-20T11:45:00.000Z",
      };
    });

    const options = {
      tokenPath,
      now: () => Date.parse("2026-04-20T10:00:00.000Z"),
      refreshWindowMs: 5 * 60 * 1000,
      refreshAccessToken,
      lockTimeoutMs: 1000,
      lockRetryMs: 10,
    };
    const readerA = new ClaudeOauthTokenReader(options);
    const readerB = new ClaudeOauthTokenReader(options);

    const first = readerA.resolveAuth();
    const second = readerB.resolveAuth();
    releaseRefresh();

    const [authA, authB] = await Promise.all([first, second]);
    expect(refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(authA.token).toBe("access-4");
    expect(authB.token).toBe("access-4");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

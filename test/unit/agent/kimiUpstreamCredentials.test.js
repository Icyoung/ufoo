const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveKimiCredentialPaths,
  parseKimiCredentialFile,
  parseKimiExpiresAtMs,
  resolveKimiUpstreamCredentials,
  readKimiAccessToken,
  KIMI_OAUTH_TOKEN_URL,
  KIMI_OAUTH_CLIENT_ID,
} = require("../../../src/agents/providers/credentials/kimi");

function writeCredential(dir, payload) {
  const credentialPath = path.join(dir, "credentials", "kimi-code.json");
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  fs.writeFileSync(credentialPath, JSON.stringify(payload, null, 2));
  return credentialPath;
}

describe("agent kimiUpstreamCredentials", () => {
  test("resolves default and explicit credential paths", () => {
    const home = path.join(os.tmpdir(), "ufoo-kimi-home");
    expect(resolveKimiCredentialPaths({ env: { KIMI_CODE_HOME: home } })).toEqual({
      home,
      credentialPath: path.join(home, "credentials", "kimi-code.json"),
      lockPath: path.join(home, "credentials", "kimi-code.json.lock"),
    });
    expect(resolveKimiCredentialPaths({
      env: {},
      credentialPath: path.join(home, "custom.json"),
    }).credentialPath).toBe(path.join(home, "custom.json"));
  });

  test("parses kimi credential file with epoch-seconds expires_at", () => {
    const parsed = parseKimiCredentialFile({
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_type: "Bearer",
      scope: "openid",
      expires_in: 3600,
      expires_at: 1784486687,
    });

    expect(parsed).toMatchObject({
      schemaVersion: "kimi-code-credentials-v1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      tokenType: "Bearer",
      expiresAtMs: 1784486687 * 1000,
    });
    expect(parsed.expiresAt).toBe(new Date(1784486687 * 1000).toISOString());
  });

  test("parseKimiExpiresAtMs accepts seconds, millis, and ISO strings", () => {
    expect(parseKimiExpiresAtMs(1784486687)).toBe(1784486687000);
    expect(parseKimiExpiresAtMs(1784486687000)).toBe(1784486687000);
    expect(parseKimiExpiresAtMs("1784486687")).toBe(1784486687000);
    expect(parseKimiExpiresAtMs("2026-07-19T12:00:00.000Z"))
      .toBe(Date.parse("2026-07-19T12:00:00.000Z"));
    expect(Number.isNaN(parseKimiExpiresAtMs(""))).toBe(true);
  });

  test("reads fresh kimi credential without calling fetch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-fresh-"));
    const now = Date.parse("2026-04-20T10:00:00.000Z");
    const credentialPath = writeCredential(dir, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_at: Math.floor((now + 3600 * 1000) / 1000),
    });
    const fetchImpl = jest.fn();

    await expect(resolveKimiUpstreamCredentials({
      credentialPath,
      env: {},
      fetchImpl,
      now: () => now,
    })).resolves.toMatchObject({
      provider: "kimi",
      credentialKind: "oauth",
      source: "credential-file",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      state: "fresh",
      refreshable: true,
      credentialPath,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("throws a recognizable error when credential file is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-missing-"));
    await expect(resolveKimiUpstreamCredentials({
      credentialPath: path.join(dir, "missing.json"),
      env: {},
    })).rejects.toMatchObject({
      code: "KIMI_AUTH_UNAVAILABLE",
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("returns expired descriptor without refresh token and never fetches", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-expired-"));
    const now = Date.parse("2026-04-20T10:00:00.000Z");
    const credentialPath = writeCredential(dir, {
      access_token: "access-old",
      expires_at: Math.floor((now - 1000) / 1000),
    });
    const fetchImpl = jest.fn();

    await expect(resolveKimiUpstreamCredentials({
      credentialPath,
      env: {},
      fetchImpl,
      now: () => now,
    })).resolves.toMatchObject({
      accessToken: "access-old",
      state: "expired",
      refreshable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refreshes near-expiry kimi token and atomically updates credential file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-refresh-"));
    const now = Date.parse("2026-04-20T10:00:00.000Z");
    const credentialPath = writeCredential(dir, {
      access_token: "access-old",
      refresh_token: "refresh-old",
      token_type: "Bearer",
      scope: "openid",
      expires_at: Math.floor((now + 60 * 1000) / 1000),
    });

    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-new",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid",
      }),
    });

    await expect(resolveKimiUpstreamCredentials({
      credentialPath,
      env: {},
      fetchImpl,
      now: () => now,
    })).resolves.toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      state: "fresh",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      KIMI_OAUTH_TOKEN_URL,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: expect.stringContaining("grant_type=refresh_token"),
      })
    );
    const body = fetchImpl.mock.calls[0][1].body;
    expect(body).toContain(`client_id=${KIMI_OAUTH_CLIENT_ID}`);
    expect(body).toContain("refresh_token=refresh-old");

    const saved = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    expect(saved.access_token).toBe("access-new");
    expect(saved.refresh_token).toBe("refresh-new");
    expect(saved.expires_at).toBe(Math.floor((now + 3600 * 1000) / 1000));
    expect(saved.scope).toBe("openid");
    // Credential file must stay private.
    expect(fs.statSync(credentialPath).mode & 0o777).toBe(0o600);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refresh failure surfaces an error and leaves the file untouched", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-refresh-fail-"));
    const now = Date.parse("2026-04-20T10:00:00.000Z");
    const credentialPath = writeCredential(dir, {
      access_token: "access-old",
      refresh_token: "refresh-old",
      expires_at: Math.floor((now + 60 * 1000) / 1000),
    });

    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid refresh token",
    });

    await expect(resolveKimiUpstreamCredentials({
      credentialPath,
      env: {},
      fetchImpl,
      now: () => now,
      refreshRetries: 1,
    })).rejects.toMatchObject({
      code: "KIMI_AUTH_REFRESH_FAILED",
    });

    const saved = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
    expect(saved.access_token).toBe("access-old");
    expect(saved.refresh_token).toBe("refresh-old");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("readKimiAccessToken is synchronous and tolerates missing files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-kimi-sync-"));
    const now = Date.now();
    const credentialPath = writeCredential(dir, {
      access_token: "access-sync",
      refresh_token: "refresh-sync",
      expires_at: Math.floor((now + 3600 * 1000) / 1000),
    });

    expect(readKimiAccessToken({ credentialPath })).toMatchObject({
      provider: "kimi",
      accessToken: "access-sync",
      state: "fresh",
    });
    expect(readKimiAccessToken({
      credentialPath: path.join(dir, "missing.json"),
    })).toBeNull();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

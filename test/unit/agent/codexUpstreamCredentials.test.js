const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  resolveCodexAuthPaths,
  parseCodexAuthFile,
  decodeJwtPayload,
  resolveCodexUpstreamCredentials,
} = require("../../../src/agent/credentials/codex");

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeJwt(payload) {
  return [
    encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    encodeBase64Url(JSON.stringify(payload)),
    "signature",
  ].join(".");
}

describe("agent codexUpstreamCredentials", () => {
  test("resolves default and explicit auth paths", () => {
    const root = path.join(os.tmpdir(), "ufoo-codex-auth-paths");
    expect(resolveCodexAuthPaths({ configDir: root })).toEqual({
      configDir: root,
      authPath: path.join(root, "auth.json"),
      lockPath: path.join(root, "auth.json.lock"),
    });
    expect(resolveCodexAuthPaths({
      configDir: root,
      authPath: path.join(root, "custom.json"),
    }).authPath).toBe(path.join(root, "custom.json"));
  });

  test("parses codex auth file with oauth tokens", () => {
    const parsed = parseCodexAuthFile({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "jwt",
        access_token: "access-1",
        refresh_token: "refresh-1",
        account_id: "acct_123",
      },
      last_refresh: "2026-04-20T10:00:00.000Z",
    });

    expect(parsed).toMatchObject({
      schemaVersion: "codex-auth-v1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accountId: "acct_123",
      authMode: "chatgpt",
    });
  });

  test("decodes jwt payload for derived email and expiry", () => {
    const jwt = makeJwt({
      email: "dev@example.com",
      exp: Math.floor(Date.parse("2026-04-20T11:00:00.000Z") / 1000),
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_claims",
      },
    });
    expect(decodeJwtPayload(jwt)).toMatchObject({
      email: "dev@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_claims",
      },
    });
  });

  test("prefers OPENAI_API_KEY over auth file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-codex-api-key-"));
    const authPath = path.join(dir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      tokens: {
        access_token: "access-1",
      },
    }, null, 2));

    await expect(resolveCodexUpstreamCredentials({
      authPath,
      env: { OPENAI_API_KEY: "api-key-1" },
    })).resolves.toMatchObject({
      provider: "codex",
      credentialKind: "api-key",
      apiKey: "api-key-1",
      credentialPath: "",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("reads codex oauth descriptor from auth.json and derives email", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-codex-auth-file-"));
    const authPath = path.join(dir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: makeJwt({
          email: "dev@example.com",
          exp: Math.floor(Date.parse("2026-04-20T11:00:00.000Z") / 1000),
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_from_claims",
          },
        }),
        access_token: "access-1",
        refresh_token: "refresh-1",
      },
      last_refresh: "2026-04-20T10:00:00.000Z",
    }, null, 2));

    await expect(resolveCodexUpstreamCredentials({
      authPath,
      env: {},
      now: () => Date.parse("2026-04-20T10:00:00.000Z"),
      refreshWindowMs: 60 * 1000,
    })).resolves.toMatchObject({
      provider: "codex",
      credentialKind: "oauth",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accountId: "acct_from_claims",
      accountEmail: "dev@example.com",
      state: "fresh",
    });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("throws a recognizable error when auth file is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-codex-missing-"));
    await expect(resolveCodexUpstreamCredentials({
      authPath: path.join(dir, "missing.json"),
      env: {},
    })).rejects.toMatchObject({
      code: "CODEX_AUTH_UNAVAILABLE",
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("refreshes near-expiry codex oauth token and atomically updates auth file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-codex-refresh-"));
    const authPath = path.join(dir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: makeJwt({
          email: "old@example.com",
          exp: Math.floor(Date.parse("2026-04-20T10:00:30.000Z") / 1000),
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_old",
          },
        }),
        access_token: "access-old",
        refresh_token: "refresh-old",
      },
      last_refresh: "2026-04-20T09:00:00.000Z",
    }, null, 2));

    const refreshedIdToken = makeJwt({
      email: "new@example.com",
      exp: Math.floor(Date.parse("2026-04-20T11:00:00.000Z") / 1000),
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_new",
      },
    });
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-new",
        id_token: refreshedIdToken,
        token_type: "Bearer",
        expires_in: 3600,
      }),
    });

    await expect(resolveCodexUpstreamCredentials({
      authPath,
      env: {},
      fetchImpl,
      now: () => Date.parse("2026-04-20T10:00:00.000Z"),
      refreshWindowMs: 60 * 1000,
    })).resolves.toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      accountId: "acct_new",
      accountEmail: "new@example.com",
      state: "fresh",
    });

    const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
    expect(saved.tokens.access_token).toBe("access-new");
    expect(saved.tokens.refresh_token).toBe("refresh-new");
    expect(saved.tokens.account_id).toBe("acct_new");
    expect(saved.email).toBe("new@example.com");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/x-www-form-urlencoded",
        }),
        body: expect.stringContaining("grant_type=refresh_token"),
      })
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

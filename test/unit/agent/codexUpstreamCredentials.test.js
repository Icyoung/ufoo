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
    });
    expect(decodeJwtPayload(jwt)).toMatchObject({
      email: "dev@example.com",
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
        }),
        access_token: "access-1",
        refresh_token: "refresh-1",
        account_id: "acct_456",
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
      accountId: "acct_456",
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
});

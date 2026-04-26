"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildCredentialDescriptor,
  parseTimestamp,
} = require("./index");

const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_REFRESH_WINDOW_MS = 300 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultCodexConfigDir() {
  return path.join(os.homedir(), ".codex");
}

function resolveCodexAuthPaths(options = {}) {
  const configDir = String(options.configDir || defaultCodexConfigDir()).trim() || defaultCodexConfigDir();
  const explicitAuthPath = String(options.authPath || "").trim();
  const authPath = explicitAuthPath || path.join(configDir, "auth.json");
  return {
    configDir,
    authPath,
    lockPath: `${authPath}.lock`,
  };
}

function decodeJwtPayload(token = "") {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function codexAuthClaims(claims = {}) {
  const info = claims["https://api.openai.com/auth"];
  return info && typeof info === "object" && !Array.isArray(info) ? info : {};
}

function deriveAccountIdFromClaims(claims = {}) {
  const info = codexAuthClaims(claims);
  return firstString(
    info.chatgpt_account_id,
    info.account_id,
    info.user_id,
    claims.account_id,
    claims.sub
  );
}

function deriveEmailFromClaims(claims = {}) {
  return firstString(claims.email);
}

function deriveExpiresAtFromClaims(claims = {}) {
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp <= 0) return "";
  return new Date(exp * 1000).toISOString();
}

async function withLockFile(lockPath, options = {}, fn) {
  const fsModule = options.fsModule || fs;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : DEFAULT_LOCK_RETRY_MS;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_LOCK_MS;
  const sleepFn = typeof options.sleep === "function" ? options.sleep : sleep;
  const startedAt = Date.now();

  fsModule.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  while ((Date.now() - startedAt) <= timeoutMs) {
    let fd = null;
    try {
      fd = fsModule.openSync(lockPath, "wx", 0o600);
      try {
        return await fn();
      } finally {
        try { fsModule.closeSync(fd); } catch {}
        try { fsModule.unlinkSync(lockPath); } catch {}
      }
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
      try {
        const stat = fsModule.statSync(lockPath);
        if ((Date.now() - stat.mtimeMs) > staleMs) {
          fsModule.unlinkSync(lockPath);
          continue;
        }
      } catch {}
      // eslint-disable-next-line no-await-in-loop
      await sleepFn(retryMs);
    }
  }

  const err = new Error(`Timed out waiting for Codex OAuth lock: ${lockPath}`);
  err.code = "CODEX_AUTH_LOCK_TIMEOUT";
  throw err;
}

function parseCodexAuthFile(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("Codex auth payload must be a JSON object");
    err.code = "CODEX_AUTH_INVALID";
    throw err;
  }

  const tokens = raw.tokens && typeof raw.tokens === "object" ? raw.tokens : null;
  const apiKey = firstString(raw.OPENAI_API_KEY, raw.api_key);
  const accessToken = firstString(tokens && tokens.access_token, raw.access_token);
  const refreshToken = firstString(tokens && tokens.refresh_token, raw.refresh_token);
  const idToken = firstString(tokens && tokens.id_token, raw.id_token);
  const accountId = firstString(tokens && tokens.account_id, raw.account_id);
  const expiresAt = firstString(
    raw.expired,
    raw.expire,
    raw.expires_at,
    tokens && tokens.expired,
    tokens && tokens.expires_at
  );
  const email = firstString(raw.email, tokens && tokens.email);

  if (!apiKey && !accessToken) {
    const err = new Error("Unsupported Codex auth schema");
    err.code = "CODEX_AUTH_SCHEMA_UNSUPPORTED";
    throw err;
  }

  return {
    schemaVersion: "codex-auth-v1",
    raw,
    apiKey,
    accessToken,
    refreshToken,
    idToken,
    accountId,
    email,
    expiresAt,
    lastRefresh: typeof raw.last_refresh === "string" ? raw.last_refresh : "",
    authMode: typeof raw.auth_mode === "string" ? raw.auth_mode : "",
  };
}

class CodexUpstreamCredentialResolver {
  constructor(options = {}) {
    this.fs = options.fsModule || fs;
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.paths = resolveCodexAuthPaths(options);
    this.refreshWindowMs = Number.isFinite(options.refreshWindowMs) ? options.refreshWindowMs : DEFAULT_REFRESH_WINDOW_MS;
    this.autoRefresh = options.autoRefresh !== false;
    this.refreshRetries = Number.isInteger(options.refreshRetries) && options.refreshRetries > 0
      ? options.refreshRetries
      : 2;
    this.sleep = typeof options.sleep === "function" ? options.sleep : sleep;
    this.lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = Number.isFinite(options.lockRetryMs) ? options.lockRetryMs : DEFAULT_LOCK_RETRY_MS;
    this.lockStaleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DEFAULT_STALE_LOCK_MS;
  }

  resolvePaths() {
    return { ...this.paths };
  }

  readAuthFile() {
    const raw = JSON.parse(this.fs.readFileSync(this.paths.authPath, "utf8"));
    const parsed = parseCodexAuthFile(raw);
    const claims = decodeJwtPayload(parsed.idToken);
    const derivedEmail = deriveEmailFromClaims(claims);
    const derivedAccountId = deriveAccountIdFromClaims(claims);
    const derivedExpiresAt = deriveExpiresAtFromClaims(claims);
    const expiresAt = parsed.expiresAt || derivedExpiresAt;
    return {
      ...parsed,
      accountEmail: parsed.email || derivedEmail,
      accountId: parsed.accountId || derivedAccountId,
      expiresAt,
      expiresAtMs: parseTimestamp(expiresAt),
    };
  }

  writeAuthFile(raw) {
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    const tmpPath = `${this.paths.authPath}.tmp-${process.pid}-${Date.now()}`;
    this.fs.mkdirSync(path.dirname(this.paths.authPath), { recursive: true, mode: 0o700 });
    this.fs.writeFileSync(tmpPath, text, "utf8");
    this.fs.renameSync(tmpPath, this.paths.authPath);
  }

  async refreshTokens(refreshToken) {
    if (typeof this.fetchImpl !== "function") {
      const err = new Error("fetch is unavailable for Codex token refresh");
      err.code = "CODEX_AUTH_REFRESH_UNAVAILABLE";
      throw err;
    }

    let lastErr = null;
    for (let attempt = 0; attempt < this.refreshRetries; attempt += 1) {
      try {
        const body = new URLSearchParams({
          client_id: CODEX_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: "openid profile email",
        });
        const response = await this.fetchImpl(CODEX_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: body.toString(),
        });
        const text = await response.text();
        if (!response.ok) {
          const err = new Error(`Codex token refresh failed (${response.status}): ${text.slice(0, 500)}`);
          err.code = "CODEX_AUTH_REFRESH_FAILED";
          err.status = response.status;
          throw err;
        }
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== "object" || !payload.access_token) {
          const err = new Error("Codex token refresh response did not include access_token");
          err.code = "CODEX_AUTH_REFRESH_SCHEMA_UNSUPPORTED";
          throw err;
        }
        const claims = decodeJwtPayload(payload.id_token);
        return {
          accessToken: firstString(payload.access_token),
          refreshToken: firstString(payload.refresh_token, refreshToken),
          idToken: firstString(payload.id_token),
          tokenType: firstString(payload.token_type, "Bearer"),
          expiresAt: Number.isFinite(Number(payload.expires_in))
            ? new Date(this.now() + Number(payload.expires_in) * 1000).toISOString()
            : deriveExpiresAtFromClaims(claims),
          accountId: deriveAccountIdFromClaims(claims),
          email: deriveEmailFromClaims(claims),
        };
      } catch (err) {
        lastErr = err;
        if (err && (
          err.code === "CODEX_AUTH_REFRESH_SCHEMA_UNSUPPORTED"
          || String(err.message || "").toLowerCase().includes("refresh_token_reused")
        )) {
          throw err;
        }
      }
    }

    const err = new Error(lastErr && lastErr.message ? lastErr.message : "Codex token refresh failed");
    err.code = lastErr && lastErr.code ? lastErr.code : "CODEX_AUTH_REFRESH_FAILED";
    err.cause = lastErr;
    throw err;
  }

  async refreshAuthRecord(record) {
    if (!record || !record.refreshToken) {
      const err = new Error("Codex OAuth credential is expired and has no refresh token");
      err.code = "CODEX_AUTH_REFRESH_UNAVAILABLE";
      throw err;
    }

    return withLockFile(this.paths.lockPath, {
      fsModule: this.fs,
      timeoutMs: this.lockTimeoutMs,
      retryMs: this.lockRetryMs,
      staleMs: this.lockStaleMs,
      sleep: this.sleep,
    }, async () => {
      const currentRecord = this.readAuthFile();
      const currentDescriptor = this.buildResolvedCredential(currentRecord);
      if (currentDescriptor.state === "fresh") {
        return currentRecord;
      }
      if (!currentRecord.refreshToken) {
        const err = new Error("Codex OAuth credential is expired and has no refresh token");
        err.code = "CODEX_AUTH_REFRESH_UNAVAILABLE";
        throw err;
      }

      const refreshed = await this.refreshTokens(currentRecord.refreshToken);
      const nextRaw = currentRecord.raw && typeof currentRecord.raw === "object" && !Array.isArray(currentRecord.raw)
        ? { ...currentRecord.raw }
        : {};
      const existingTokens = nextRaw.tokens && typeof nextRaw.tokens === "object" && !Array.isArray(nextRaw.tokens)
        ? { ...nextRaw.tokens }
        : {};

      nextRaw.tokens = {
        ...existingTokens,
        id_token: refreshed.idToken || existingTokens.id_token || currentRecord.idToken || "",
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken || existingTokens.refresh_token || currentRecord.refreshToken || "",
        account_id: refreshed.accountId || currentRecord.accountId || existingTokens.account_id || "",
      };
      nextRaw.last_refresh = new Date(this.now()).toISOString();
      nextRaw.expired = refreshed.expiresAt || currentRecord.expiresAt || "";
      if (refreshed.email || currentRecord.accountEmail || currentRecord.email) {
        nextRaw.email = refreshed.email || currentRecord.accountEmail || currentRecord.email || "";
      }
      if (currentRecord.authMode && !nextRaw.auth_mode) {
        nextRaw.auth_mode = currentRecord.authMode;
      }
      this.writeAuthFile(nextRaw);
      return this.readAuthFile();
    });
  }

  buildResolvedCredential(record) {
    if (record.apiKey) {
      return buildCredentialDescriptor({
        provider: "codex",
        credentialKind: "api-key",
        source: "auth-file",
        apiKey: record.apiKey,
        tokenType: "Bearer",
        state: "fresh",
        refreshable: false,
        credentialPath: this.paths.authPath,
        accountId: record.accountId,
        accountEmail: record.accountEmail,
        schemaVersion: record.schemaVersion,
        nowMs: this.now(),
        refreshWindowMs: this.refreshWindowMs,
        metadata: {
          authMode: record.authMode,
          lastRefresh: record.lastRefresh,
        },
      });
    }

    return buildCredentialDescriptor({
      provider: "codex",
      credentialKind: "oauth",
      source: "auth-file",
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      tokenType: "Bearer",
      expiresAt: record.expiresAt,
      expiresAtMs: record.expiresAtMs,
      refreshable: Boolean(record.refreshToken),
      credentialPath: this.paths.authPath,
      accountId: record.accountId,
      accountEmail: record.accountEmail,
      schemaVersion: record.schemaVersion,
      nowMs: this.now(),
      refreshWindowMs: this.refreshWindowMs,
      metadata: {
        authMode: record.authMode,
        idTokenPresent: Boolean(record.idToken),
        lastRefresh: record.lastRefresh,
      },
    });
  }

  async resolveCredentials() {
    const apiKey = typeof this.env.OPENAI_API_KEY === "string" ? this.env.OPENAI_API_KEY.trim() : "";
    if (apiKey) {
      return buildCredentialDescriptor({
        provider: "codex",
        credentialKind: "api-key",
        source: "env:OPENAI_API_KEY",
        apiKey,
        tokenType: "Bearer",
        state: "fresh",
        refreshable: false,
        credentialPath: "",
        nowMs: this.now(),
      });
    }

    let authRecord;
    try {
      authRecord = this.readAuthFile();
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const missing = new Error("Codex auth file not found and OPENAI_API_KEY is unset");
        missing.code = "CODEX_AUTH_UNAVAILABLE";
        throw missing;
      }
      throw err;
    }
    const descriptor = this.buildResolvedCredential(authRecord);
    if (
      this.autoRefresh
      && descriptor.credentialKind === "oauth"
      && descriptor.refreshable
      && (descriptor.state === "expired" || descriptor.state === "near_expiry")
    ) {
      const refreshedRecord = await this.refreshAuthRecord(authRecord);
      return this.buildResolvedCredential(refreshedRecord);
    }
    return descriptor;
  }
}

async function resolveCodexUpstreamCredentials(options = {}) {
  const resolver = new CodexUpstreamCredentialResolver(options);
  return resolver.resolveCredentials();
}

module.exports = {
  CodexUpstreamCredentialResolver,
  resolveCodexUpstreamCredentials,
  resolveCodexAuthPaths,
  parseCodexAuthFile,
  decodeJwtPayload,
  deriveAccountIdFromClaims,
  deriveExpiresAtFromClaims,
};

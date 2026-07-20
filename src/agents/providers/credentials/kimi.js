"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildCredentialDescriptor,
} = require("./index");

const KIMI_OAUTH_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEFAULT_REFRESH_WINDOW_MS = 300 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultKimiHome(env = process.env) {
  const configured = String(env.KIMI_CODE_HOME || "").trim();
  if (configured) return configured;
  return path.join(os.homedir(), ".kimi-code");
}

function resolveKimiCredentialPaths(options = {}) {
  const env = options.env || process.env;
  const home = String(options.home || options.configDir || defaultKimiHome(env)).trim() || defaultKimiHome(env);
  const explicitCredentialPath = String(options.credentialPath || "").trim();
  const credentialPath = explicitCredentialPath || path.join(home, "credentials", "kimi-code.json");
  return {
    home,
    credentialPath,
    lockPath: `${credentialPath}.lock`,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// kimi CLI stores expires_at as Unix epoch seconds (e.g. 1784486687); accept
// epoch millis and ISO strings as well so hand-rolled fixtures keep working.
function parseKimiExpiresAtMs(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
  }
  const text = String(value || "").trim();
  if (!text) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const num = Number(text);
    return num > 1e12 ? Math.floor(num) : Math.floor(num * 1000);
  }
  return Date.parse(text);
}

function parseKimiCredentialFile(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("Kimi credential payload must be a JSON object");
    err.code = "KIMI_AUTH_INVALID";
    throw err;
  }

  const accessToken = firstString(raw.access_token, raw.accessToken);
  const refreshToken = firstString(raw.refresh_token, raw.refreshToken);
  if (!accessToken && !refreshToken) {
    const err = new Error("Unsupported Kimi credential schema");
    err.code = "KIMI_AUTH_SCHEMA_UNSUPPORTED";
    throw err;
  }

  const expiresAtMs = parseKimiExpiresAtMs(
    raw.expires_at !== undefined ? raw.expires_at : raw.expiresAt
  );

  return {
    schemaVersion: "kimi-code-credentials-v1",
    raw,
    accessToken,
    refreshToken,
    tokenType: firstString(raw.token_type, raw.tokenType, "Bearer"),
    scope: firstString(raw.scope),
    expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : "",
    expiresAtMs,
  };
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

  const err = new Error(`Timed out waiting for Kimi OAuth lock: ${lockPath}`);
  err.code = "KIMI_AUTH_LOCK_TIMEOUT";
  throw err;
}

class KimiUpstreamCredentialResolver {
  constructor(options = {}) {
    this.fs = options.fsModule || fs;
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl || global.fetch;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.paths = resolveKimiCredentialPaths(options);
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

  readCredentialFile() {
    const raw = JSON.parse(this.fs.readFileSync(this.paths.credentialPath, "utf8"));
    return parseKimiCredentialFile(raw);
  }

  writeCredentialFile(raw) {
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    const tmpPath = `${this.paths.credentialPath}.tmp-${process.pid}-${Date.now()}`;
    this.fs.mkdirSync(path.dirname(this.paths.credentialPath), { recursive: true, mode: 0o700 });
    this.fs.writeFileSync(tmpPath, text, { encoding: "utf8", mode: 0o600 });
    this.fs.renameSync(tmpPath, this.paths.credentialPath);
    try { this.fs.chmodSync(this.paths.credentialPath, 0o600); } catch {}
  }

  async refreshTokens(refreshToken) {
    if (typeof this.fetchImpl !== "function") {
      const err = new Error("fetch is unavailable for Kimi token refresh");
      err.code = "KIMI_AUTH_REFRESH_UNAVAILABLE";
      throw err;
    }

    let lastErr = null;
    for (let attempt = 0; attempt < this.refreshRetries; attempt += 1) {
      try {
        const body = new URLSearchParams({
          client_id: KIMI_OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });
        const response = await this.fetchImpl(KIMI_OAUTH_TOKEN_URL, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: body.toString(),
        });
        const text = await response.text();
        if (!response.ok) {
          const err = new Error(`Kimi token refresh failed (${response.status}): ${text.slice(0, 500)}`);
          err.code = "KIMI_AUTH_REFRESH_FAILED";
          err.status = response.status;
          throw err;
        }
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== "object" || !payload.access_token) {
          const err = new Error("Kimi token refresh response did not include access_token");
          err.code = "KIMI_AUTH_REFRESH_SCHEMA_UNSUPPORTED";
          throw err;
        }
        const expiresIn = Number(payload.expires_in);
        const expiresAtMs = Number.isFinite(expiresIn) && expiresIn > 0
          ? this.now() + Math.floor(expiresIn * 1000)
          : NaN;
        return {
          accessToken: firstString(payload.access_token),
          refreshToken: firstString(payload.refresh_token, refreshToken),
          tokenType: firstString(payload.token_type, "Bearer"),
          scope: firstString(payload.scope),
          expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : "",
          expiresAtMs,
        };
      } catch (err) {
        lastErr = err;
        if (err && err.code === "KIMI_AUTH_REFRESH_SCHEMA_UNSUPPORTED") {
          throw err;
        }
      }
    }

    const err = new Error(lastErr && lastErr.message ? lastErr.message : "Kimi token refresh failed");
    err.code = lastErr && lastErr.code ? lastErr.code : "KIMI_AUTH_REFRESH_FAILED";
    err.cause = lastErr;
    throw err;
  }

  async refreshCredentialRecord(record) {
    if (!record || !record.refreshToken) {
      const err = new Error("Kimi OAuth credential is expired and has no refresh token");
      err.code = "KIMI_AUTH_REFRESH_UNAVAILABLE";
      throw err;
    }

    return withLockFile(this.paths.lockPath, {
      fsModule: this.fs,
      timeoutMs: this.lockTimeoutMs,
      retryMs: this.lockRetryMs,
      staleMs: this.lockStaleMs,
      sleep: this.sleep,
    }, async () => {
      const currentRecord = this.readCredentialFile();
      const currentDescriptor = this.buildResolvedCredential(currentRecord);
      if (currentDescriptor.state === "fresh") {
        return currentRecord;
      }
      if (!currentRecord.refreshToken) {
        const err = new Error("Kimi OAuth credential is expired and has no refresh token");
        err.code = "KIMI_AUTH_REFRESH_UNAVAILABLE";
        throw err;
      }

      const refreshed = await this.refreshTokens(currentRecord.refreshToken);
      const nextRaw = currentRecord.raw && typeof currentRecord.raw === "object" && !Array.isArray(currentRecord.raw)
        ? { ...currentRecord.raw }
        : {};
      nextRaw.access_token = refreshed.accessToken;
      nextRaw.refresh_token = refreshed.refreshToken || currentRecord.refreshToken || "";
      if (refreshed.tokenType) nextRaw.token_type = refreshed.tokenType;
      if (refreshed.scope) nextRaw.scope = refreshed.scope;
      if (Number.isFinite(refreshed.expiresAtMs)) {
        nextRaw.expires_at = Math.floor(refreshed.expiresAtMs / 1000);
      }
      this.writeCredentialFile(nextRaw);
      return this.readCredentialFile();
    });
  }

  buildResolvedCredential(record) {
    return buildCredentialDescriptor({
      provider: "kimi",
      credentialKind: "oauth",
      source: "credential-file",
      accessToken: record.accessToken,
      refreshToken: record.refreshToken,
      tokenType: record.tokenType || "Bearer",
      expiresAt: record.expiresAt,
      expiresAtMs: record.expiresAtMs,
      refreshable: Boolean(record.refreshToken),
      credentialPath: this.paths.credentialPath,
      schemaVersion: record.schemaVersion,
      nowMs: this.now(),
      refreshWindowMs: this.refreshWindowMs,
      metadata: {
        scope: record.scope,
      },
    });
  }

  async resolveCredentials() {
    let record;
    try {
      record = this.readCredentialFile();
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const missing = new Error("Kimi credential file not found; run `kimi` once to sign in");
        missing.code = "KIMI_AUTH_UNAVAILABLE";
        throw missing;
      }
      throw err;
    }
    const descriptor = this.buildResolvedCredential(record);
    if (
      this.autoRefresh
      && descriptor.refreshable
      && (descriptor.state === "expired" || descriptor.state === "near_expiry")
    ) {
      const refreshedRecord = await this.refreshCredentialRecord(record);
      return this.buildResolvedCredential(refreshedRecord);
    }
    return descriptor;
  }
}

async function resolveKimiUpstreamCredentials(options = {}) {
  const resolver = new KimiUpstreamCredentialResolver(options);
  return resolver.resolveCredentials();
}

// Synchronous, network-free read used by resolveRuntimeConfig: returns the
// credential descriptor (fresh or not) or null when the file is unusable.
function readKimiAccessToken(options = {}) {
  try {
    const resolver = new KimiUpstreamCredentialResolver({ ...options, autoRefresh: false });
    const record = resolver.readCredentialFile();
    return resolver.buildResolvedCredential(record);
  } catch {
    return null;
  }
}

module.exports = {
  KimiUpstreamCredentialResolver,
  resolveKimiUpstreamCredentials,
  resolveKimiCredentialPaths,
  parseKimiCredentialFile,
  parseKimiExpiresAtMs,
  readKimiAccessToken,
  KIMI_OAUTH_TOKEN_URL,
  KIMI_OAUTH_CLIENT_ID,
};

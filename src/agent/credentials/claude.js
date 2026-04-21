"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildCredentialDescriptor,
  parseTimestamp,
} = require("./index");

const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_LOCK_TIMEOUT_MS = 3000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 30 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultClaudeConfigDir() {
  return path.join(os.homedir(), ".claude");
}

function resolveClaudeOauthPaths(options = {}) {
  const configDir = String(options.configDir || defaultClaudeConfigDir()).trim() || defaultClaudeConfigDir();
  const profile = String(options.profile || "").trim();
  const explicitTokenPath = String(options.tokenPath || "").trim();
  const profileDir = profile ? path.join(configDir, "profiles", profile) : configDir;
  const tokenPath = explicitTokenPath || path.join(profileDir, "oauth.json");
  return {
    configDir,
    profile,
    profileDir,
    tokenPath,
    lockPath: `${tokenPath}.lock`,
  };
}

function classifyTokenState(expiresAtMs, nowMs, refreshWindowMs) {
  if (!Number.isFinite(expiresAtMs)) return "invalid";
  if (expiresAtMs <= nowMs) return "expired";
  if ((expiresAtMs - nowMs) <= refreshWindowMs) return "near_expiry";
  return "fresh";
}

function parseClaudeOauthFile(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("Claude OAuth token payload must be a JSON object");
    err.code = "CLAUDE_OAUTH_INVALID";
    throw err;
  }

  if (
    raw.version === "claude-code-oauth-v1"
    && typeof raw.accessToken === "string"
    && typeof raw.refreshToken === "string"
  ) {
    return {
      schemaVersion: "claude-code-oauth-v1",
      raw,
      accessToken: raw.accessToken,
      refreshToken: raw.refreshToken,
      expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : "",
      tokenType: typeof raw.tokenType === "string" ? raw.tokenType : "Bearer",
      refreshUrl: typeof raw.refreshUrl === "string" ? raw.refreshUrl : "",
    };
  }

  if (
    raw.version === 2
    && raw.oauth
    && typeof raw.oauth === "object"
    && typeof raw.oauth.access_token === "string"
    && typeof raw.oauth.refresh_token === "string"
  ) {
    return {
      schemaVersion: "claude-code-oauth-v2",
      raw,
      accessToken: raw.oauth.access_token,
      refreshToken: raw.oauth.refresh_token,
      expiresAt: typeof raw.oauth.expires_at === "string" ? raw.oauth.expires_at : "",
      tokenType: typeof raw.oauth.token_type === "string" ? raw.oauth.token_type : "Bearer",
      refreshUrl: typeof raw.oauth.refresh_url === "string" ? raw.oauth.refresh_url : "",
    };
  }

  const err = new Error("Unsupported Claude OAuth token schema");
  err.code = "CLAUDE_OAUTH_SCHEMA_UNSUPPORTED";
  throw err;
}

function serializeClaudeOauthToken(parsedToken, updates = {}) {
  const accessToken = typeof updates.accessToken === "string" ? updates.accessToken : parsedToken.accessToken;
  const refreshToken = typeof updates.refreshToken === "string" ? updates.refreshToken : parsedToken.refreshToken;
  const expiresAt = typeof updates.expiresAt === "string" ? updates.expiresAt : parsedToken.expiresAt;
  const tokenType = typeof updates.tokenType === "string" ? updates.tokenType : parsedToken.tokenType;
  const refreshUrl = typeof updates.refreshUrl === "string" ? updates.refreshUrl : parsedToken.refreshUrl;

  if (parsedToken.schemaVersion === "claude-code-oauth-v1") {
    return {
      ...parsedToken.raw,
      accessToken,
      refreshToken,
      expiresAt,
      tokenType,
      refreshUrl,
    };
  }

  if (parsedToken.schemaVersion === "claude-code-oauth-v2") {
    return {
      ...parsedToken.raw,
      oauth: {
        ...parsedToken.raw.oauth,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: expiresAt,
        token_type: tokenType,
        refresh_url: refreshUrl,
      },
    };
  }

  const err = new Error(`Unsupported Claude OAuth schema version: ${parsedToken.schemaVersion}`);
  err.code = "CLAUDE_OAUTH_SCHEMA_UNSUPPORTED";
  throw err;
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

  const err = new Error(`Timed out waiting for Claude OAuth lock: ${lockPath}`);
  err.code = "CLAUDE_OAUTH_LOCK_TIMEOUT";
  throw err;
}

function atomicWriteJson(filePath, value, options = {}) {
  const fsModule = options.fsModule || fs;
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.tmp-${path.basename(filePath)}.${process.pid}.${Date.now()}`);
  fsModule.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsModule.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fsModule.renameSync(tmpPath, filePath);
}

class ClaudeUpstreamCredentialResolver {
  constructor(options = {}) {
    this.fs = options.fsModule || fs;
    this.env = options.env || process.env;
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.refreshAccessToken = typeof options.refreshAccessToken === "function"
      ? options.refreshAccessToken
      : null;
    this.sleep = typeof options.sleep === "function" ? options.sleep : sleep;
    this.lockTimeoutMs = Number.isFinite(options.lockTimeoutMs) ? options.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = Number.isFinite(options.lockRetryMs) ? options.lockRetryMs : DEFAULT_LOCK_RETRY_MS;
    this.lockStaleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DEFAULT_STALE_LOCK_MS;
    this.refreshWindowMs = Number.isFinite(options.refreshWindowMs)
      ? options.refreshWindowMs
      : DEFAULT_REFRESH_WINDOW_MS;
    this.paths = resolveClaudeOauthPaths(options);
  }

  resolvePaths() {
    return { ...this.paths };
  }

  readTokenFile() {
    const raw = JSON.parse(this.fs.readFileSync(this.paths.tokenPath, "utf8"));
    const parsed = parseClaudeOauthFile(raw);
    const nowMs = this.now();
    const expiresAtMs = parseTimestamp(parsed.expiresAt);
    return {
      ...parsed,
      expiresAtMs,
      state: classifyTokenState(expiresAtMs, nowMs, this.refreshWindowMs),
    };
  }

  buildResolvedCredential(tokenRecord) {
    return buildCredentialDescriptor({
      provider: "claude",
      credentialKind: "oauth",
      source: "oauth",
      accessToken: tokenRecord.accessToken,
      refreshToken: tokenRecord.refreshToken,
      tokenType: tokenRecord.tokenType || "Bearer",
      state: tokenRecord.state,
      expiresAt: tokenRecord.expiresAt,
      expiresAtMs: tokenRecord.expiresAtMs,
      refreshable: Boolean(tokenRecord.refreshToken),
      profile: this.paths.profile,
      credentialPath: this.paths.tokenPath,
      schemaVersion: tokenRecord.schemaVersion,
      refreshWindowMs: this.refreshWindowMs,
      nowMs: this.now(),
      metadata: {
        tokenPath: this.paths.tokenPath,
        refreshUrl: tokenRecord.refreshUrl || "",
      },
    });
  }

  async refreshIfNeeded(initialRecord) {
    if (!this.refreshAccessToken) {
      return this.buildResolvedCredential(initialRecord);
    }

    return withLockFile(this.paths.lockPath, {
      fsModule: this.fs,
      timeoutMs: this.lockTimeoutMs,
      retryMs: this.lockRetryMs,
      staleMs: this.lockStaleMs,
      sleep: this.sleep,
    }, async () => {
      const currentRecord = this.readTokenFile();
      if (currentRecord.state === "fresh") {
        return this.buildResolvedCredential(currentRecord);
      }

      const refreshed = await this.refreshAccessToken({
        profile: this.paths.profile,
        tokenPath: this.paths.tokenPath,
        refreshToken: currentRecord.refreshToken,
        accessToken: currentRecord.accessToken,
        expiresAt: currentRecord.expiresAt,
        refreshUrl: currentRecord.refreshUrl,
        tokenType: currentRecord.tokenType,
        schemaVersion: currentRecord.schemaVersion,
      });

      const nextRaw = serializeClaudeOauthToken(currentRecord, refreshed || {});
      atomicWriteJson(this.paths.tokenPath, nextRaw, { fsModule: this.fs });

      const nextRecord = this.readTokenFile();
      return this.buildResolvedCredential(nextRecord);
    });
  }

  async resolveCredentials() {
    const apiKey = typeof this.env.ANTHROPIC_API_KEY === "string" ? this.env.ANTHROPIC_API_KEY.trim() : "";
    if (apiKey) {
      return buildCredentialDescriptor({
        provider: "claude",
        credentialKind: "api-key",
        source: "api-key",
        apiKey,
        tokenType: "Bearer",
        state: "fresh",
        refreshable: false,
        profile: this.paths.profile,
        credentialPath: "",
        nowMs: this.now(),
        refreshWindowMs: this.refreshWindowMs,
      });
    }

    let tokenRecord;
    try {
      tokenRecord = this.readTokenFile();
    } catch (err) {
      if (err && err.code === "ENOENT") {
        const missing = new Error("Claude OAuth token not found and ANTHROPIC_API_KEY is unset");
        missing.code = "CLAUDE_AUTH_UNAVAILABLE";
        throw missing;
      }
      throw err;
    }

    if (tokenRecord.state === "fresh") {
      return this.buildResolvedCredential(tokenRecord);
    }

    return this.refreshIfNeeded(tokenRecord);
  }
}

async function resolveClaudeUpstreamCredentials(options = {}) {
  const resolver = new ClaudeUpstreamCredentialResolver(options);
  return resolver.resolveCredentials();
}

module.exports = {
  ClaudeUpstreamCredentialResolver,
  DEFAULT_REFRESH_WINDOW_MS,
  resolveClaudeUpstreamCredentials,
  resolveClaudeOauthPaths,
  parseClaudeOauthFile,
  serializeClaudeOauthToken,
  classifyTokenState,
  withLockFile,
  atomicWriteJson,
};

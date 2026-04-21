"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildCredentialDescriptor,
  parseTimestamp,
} = require("./index");

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

function parseCodexAuthFile(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    const err = new Error("Codex auth payload must be a JSON object");
    err.code = "CODEX_AUTH_INVALID";
    throw err;
  }

  const tokens = raw.tokens && typeof raw.tokens === "object" ? raw.tokens : null;
  const apiKey = typeof raw.OPENAI_API_KEY === "string" ? raw.OPENAI_API_KEY : "";
  const accessToken = tokens && typeof tokens.access_token === "string"
    ? tokens.access_token
    : (typeof raw.access_token === "string" ? raw.access_token : "");
  const refreshToken = tokens && typeof tokens.refresh_token === "string"
    ? tokens.refresh_token
    : (typeof raw.refresh_token === "string" ? raw.refresh_token : "");
  const idToken = tokens && typeof tokens.id_token === "string"
    ? tokens.id_token
    : (typeof raw.id_token === "string" ? raw.id_token : "");
  const accountId = tokens && typeof tokens.account_id === "string"
    ? tokens.account_id
    : (typeof raw.account_id === "string" ? raw.account_id : "");
  const expiresAt = typeof raw.expired === "string"
    ? raw.expired
    : (typeof raw.expire === "string" ? raw.expire : "");
  const email = typeof raw.email === "string" ? raw.email : "";

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
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.paths = resolveCodexAuthPaths(options);
    this.refreshWindowMs = Number.isFinite(options.refreshWindowMs) ? options.refreshWindowMs : 0;
  }

  resolvePaths() {
    return { ...this.paths };
  }

  readAuthFile() {
    const raw = JSON.parse(this.fs.readFileSync(this.paths.authPath, "utf8"));
    const parsed = parseCodexAuthFile(raw);
    const claims = decodeJwtPayload(parsed.idToken);
    const derivedEmail = typeof claims.email === "string" ? claims.email : "";
    const derivedExpiresAt = Number.isFinite(Number(claims.exp))
      ? new Date(Number(claims.exp) * 1000).toISOString()
      : "";
    const expiresAt = parsed.expiresAt || derivedExpiresAt;
    return {
      ...parsed,
      accountEmail: parsed.email || derivedEmail,
      expiresAt,
      expiresAtMs: parseTimestamp(expiresAt),
    };
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
    return this.buildResolvedCredential(authRecord);
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
};

"use strict";

const { loadConfig } = require("../config");
const {
  resolveCodexAuthPaths,
  resolveCodexUpstreamCredentials,
} = require("./credentials/codex");
const {
  resolveClaudeOauthPaths,
  resolveClaudeUpstreamCredentials,
} = require("./credentials/claude");

function normalizeRefreshWindowMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 300000;
  return Math.floor(num * 1000);
}

function normalizeErrorCode(err, fallback = "DIRECT_AUTH_STATUS_FAILED") {
  return String(err && err.code ? err.code : fallback).trim() || fallback;
}

function normalizeDirectAuthProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "claude" || text === "claude-cli" || text === "claude-code" || text === "anthropic") return "claude";
  return "codex";
}

function formatAccount(credential = {}) {
  const email = String(credential.accountEmail || "").trim();
  const accountId = String(credential.accountId || "").trim();
  if (email && accountId) return `${email} (${accountId})`;
  if (email) return email;
  if (accountId) return accountId;
  return "";
}

function formatCompactAccount(status = {}) {
  return String(status.accountEmail || status.account || status.accountId || "").trim();
}

function formatCompactExpires(value = "") {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return text;
  return `${match[1]} ${match[2]}${text.endsWith("Z") ? "Z" : ""}`;
}

function codexTransportFromCredential(credential = {}) {
  return credential.credentialKind === "oauth" && credential.accessToken
    ? "codex-responses"
    : "openai-chat";
}

async function inspectCodexDirectAuth({
  projectRoot,
  env = process.env,
  fetchImpl = global.fetch,
  loadConfigImpl = loadConfig,
  autoRefresh = false,
} = {}) {
  const config = loadConfigImpl(projectRoot) || {};
  const paths = resolveCodexAuthPaths({ authPath: config.codexAuthPath });
  try {
    const credential = await resolveCodexUpstreamCredentials({
      authPath: config.codexAuthPath,
      refreshWindowMs: normalizeRefreshWindowMs(config.codexOauthRefreshWindowSec),
      fetchImpl,
      env,
      autoRefresh,
    });
    return {
      ok: true,
      provider: "codex",
      transport: codexTransportFromCredential(credential),
      credentialKind: String(credential.credentialKind || ""),
      source: String(credential.source || ""),
      state: String(credential.state || ""),
      refreshable: credential.refreshable === true,
      account: formatAccount(credential),
      accountId: String(credential.accountId || ""),
      accountEmail: String(credential.accountEmail || ""),
      expiresAt: String(credential.expiresAt || ""),
      credentialPath: String(credential.credentialPath || paths.authPath || ""),
    };
  } catch (err) {
    return {
      ok: false,
      provider: "codex",
      error: err && err.message ? err.message : "Codex direct API credentials are unavailable",
      errorCode: normalizeErrorCode(err, "CODEX_AUTH_STATUS_FAILED"),
      credentialPath: paths.authPath || "",
      hint: "Run Codex login once or set OPENAI_API_KEY; ufoo-agent will not fall back to the CLI.",
    };
  }
}

async function inspectClaudeDirectAuth({
  projectRoot,
  env = process.env,
  loadConfigImpl = loadConfig,
} = {}) {
  const config = loadConfigImpl(projectRoot) || {};
  const paths = resolveClaudeOauthPaths({
    profile: config.claudeOauthProfile,
    tokenPath: config.claudeOauthTokenPath,
  });
  try {
    const credential = await resolveClaudeUpstreamCredentials({
      profile: config.claudeOauthProfile,
      tokenPath: config.claudeOauthTokenPath,
      refreshWindowMs: normalizeRefreshWindowMs(config.claudeOauthRefreshWindowSec),
      env,
    });
    return {
      ok: true,
      provider: "claude",
      transport: "anthropic-messages",
      credentialKind: String(credential.credentialKind || ""),
      source: String(credential.source || ""),
      state: String(credential.state || ""),
      refreshable: credential.refreshable === true,
      profile: String(credential.profile || paths.profile || ""),
      expiresAt: String(credential.expiresAt || ""),
      credentialPath: String(credential.credentialPath || paths.tokenPath || ""),
    };
  } catch (err) {
    return {
      ok: false,
      provider: "claude",
      error: err && err.message ? err.message : "Claude direct API credentials are unavailable",
      errorCode: normalizeErrorCode(err, "CLAUDE_AUTH_STATUS_FAILED"),
      credentialPath: paths.tokenPath || "",
      hint: "Use ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ~/.claude/settings.json, or Claude OAuth token file; restart chat/daemon if you changed shell env.",
    };
  }
}

async function inspectDirectAuthStatus(options = {}) {
  const { projectRoot, loadConfigImpl = loadConfig, provider = "" } = options;
  const config = loadConfigImpl(projectRoot) || {};
  const selected = normalizeDirectAuthProvider(provider || config.agentProvider || config.routerProvider || "");
  const nextOptions = {
    ...options,
    loadConfigImpl: () => config,
  };
  if (selected === "claude") {
    return inspectClaudeDirectAuth(nextOptions);
  }
  return inspectCodexDirectAuth(nextOptions);
}

function formatCodexDirectAuthStatus(status = {}, options = {}) {
  if (options.compact === true) {
    if (status.ok) {
      const credential = status.credentialKind || "credential";
      const transport = status.transport || "unknown";
      const state = status.state || "unknown";
      const details = [
        status.source || "",
        formatCompactAccount(status),
        status.expiresAt ? `expires ${formatCompactExpires(status.expiresAt)}` : "",
        status.refreshable ? "refreshable" : "",
      ].filter(Boolean);
      const lines = [
        `Codex API: OK · ${credential}/${transport} · ${state}`,
      ];
      if (details.length > 0) lines.push(`  ${details.join(" · ")}`);
      return lines;
    }

    const hint = String(status.hint || "Run Codex login once or set OPENAI_API_KEY.").replace(/;.*$/, ".");
    return [
      `Codex API: FAIL · ${status.errorCode || "CODEX_AUTH_STATUS_FAILED"}`,
      `  ${status.error || "Codex direct API credentials are unavailable"} · ${hint}`,
    ];
  }

  if (status.ok) {
    const state = status.state || "unknown";
    const lines = [
      `Codex direct API: OK (${status.transport || "unknown"}, ${status.credentialKind || "credential"}, ${state})`,
      `  - source: ${status.source || "(unknown)"}`,
    ];
    if (status.account) lines.push(`  - account: ${status.account}`);
    if (status.expiresAt) lines.push(`  - expires: ${status.expiresAt}`);
    if (status.credentialPath) lines.push(`  - path: ${status.credentialPath}`);
    if (status.refreshable) lines.push("  - refreshable: yes");
    return lines;
  }

  const lines = [
    `Codex direct API: FAIL (${status.errorCode || "CODEX_AUTH_STATUS_FAILED"})`,
    `  - ${status.error || "Codex direct API credentials are unavailable"}`,
  ];
  if (status.credentialPath) lines.push(`  - expected path: ${status.credentialPath}`);
  if (status.hint) lines.push(`  - ${status.hint}`);
  return lines;
}

function formatClaudeDirectAuthStatus(status = {}, options = {}) {
  if (options.compact === true) {
    if (status.ok) {
      const credential = status.credentialKind || "credential";
      const transport = status.transport || "anthropic-messages";
      const state = status.state || "unknown";
      const details = [
        status.source || "",
        status.profile ? `profile ${status.profile}` : "",
        status.expiresAt ? `expires ${formatCompactExpires(status.expiresAt)}` : "",
        status.refreshable ? "refreshable" : "",
      ].filter(Boolean);
      const lines = [
        `Claude API: OK · ${credential}/${transport} · ${state}`,
      ];
      if (details.length > 0) lines.push(`  ${details.join(" · ")}`);
      return lines;
    }

    const hint = String(status.hint || "Use ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, Claude settings, or Claude OAuth.").replace(/;.*$/, ".");
    return [
      `Claude API: FAIL · ${status.errorCode || "CLAUDE_AUTH_STATUS_FAILED"}`,
      `  ${status.error || "Claude direct API credentials are unavailable"} · ${hint}`,
    ];
  }

  if (status.ok) {
    const state = status.state || "unknown";
    const lines = [
      `Claude direct API: OK (${status.transport || "anthropic-messages"}, ${status.credentialKind || "credential"}, ${state})`,
      `  - source: ${status.source || "(unknown)"}`,
    ];
    if (status.profile) lines.push(`  - profile: ${status.profile}`);
    if (status.expiresAt) lines.push(`  - expires: ${status.expiresAt}`);
    if (status.credentialPath) lines.push(`  - path: ${status.credentialPath}`);
    if (status.refreshable) lines.push("  - refreshable: yes");
    return lines;
  }

  const lines = [
    `Claude direct API: FAIL (${status.errorCode || "CLAUDE_AUTH_STATUS_FAILED"})`,
    `  - ${status.error || "Claude direct API credentials are unavailable"}`,
  ];
  if (status.credentialPath) lines.push(`  - expected path: ${status.credentialPath}`);
  if (status.hint) lines.push(`  - ${status.hint}`);
  return lines;
}

function formatDirectAuthStatus(status = {}, options = {}) {
  if (status.provider === "claude") {
    return formatClaudeDirectAuthStatus(status, options);
  }
  return formatCodexDirectAuthStatus(status, options);
}

module.exports = {
  inspectDirectAuthStatus,
  inspectCodexDirectAuth,
  inspectClaudeDirectAuth,
  formatDirectAuthStatus,
  formatCodexDirectAuthStatus,
  formatClaudeDirectAuthStatus,
  normalizeDirectAuthProvider,
};

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadConfig } = require("../../config");
const {
  resolveCodexAuthPaths,
  resolveCodexUpstreamCredentials,
} = require("./credentials/codex");
const {
  resolveClaudeOauthPaths,
  resolveClaudeUpstreamCredentials,
} = require("./credentials/claude");
const {
  resolveKimiCredentialPaths,
  resolveKimiUpstreamCredentials,
} = require("./credentials/kimi");

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
  if (text === "agy" || text === "agy-cli" || text === "antigravity") return "agy";
  if (text === "kimi" || text === "kimi-code" || text === "moonshot") return "kimi";
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

/**
 * Default agy log directory: ~/.gemini/antigravity-cli/log
 * Agy doesn't expose an API for auth status, so we tail its own structured
 * server-side log and grep for the markers it prints during the OAuth
 * handshake. This is best-effort observability, not a real credential
 * check — agy owns the keyring, not us.
 */
function resolveAgyLogDir(env = process.env) {
  const home = String(env.HOME || os.homedir() || "").trim();
  if (!home) return "";
  return path.join(home, ".gemini", "antigravity-cli", "log");
}

function findMostRecentAgyLog(logDir = "") {
  try {
    if (!logDir || !fs.existsSync(logDir)) return "";
    const entries = fs.readdirSync(logDir)
      .filter((name) => name.startsWith("cli-") && name.endsWith(".log"));
    if (entries.length === 0) return "";
    // Filenames are cli-YYYYMMDD_HHMMSS.log — lexicographic sort matches mtime.
    entries.sort();
    return path.join(logDir, entries[entries.length - 1]);
  } catch {
    return "";
  }
}

function readAgyLogTail(file = "", maxBytes = 32 * 1024) {
  try {
    if (!file || !fs.existsSync(file)) return "";
    const stat = fs.statSync(file);
    const offset = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, offset);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function classifyAgyLogTail(text = "") {
  const str = String(text || "");
  if (!str) {
    return {
      ok: false,
      state: "unknown",
      errorCode: "AGY_AUTH_NO_LOG",
      message: "no agy log file found yet — launch agy at least once to produce one",
    };
  }
  if (/Eligibility check failed/i.test(str) || /Account ineligible/i.test(str)) {
    const emailMatch = str.match(/authenticated successfully as ([^\s]+)/);
    return {
      ok: false,
      state: "ineligible",
      errorCode: "AGY_ACCOUNT_INELIGIBLE",
      message: "agy account is signed in but not eligible (18+ / supported region required)",
      accountEmail: emailMatch ? emailMatch[1] : "",
    };
  }
  if (/User location is not supported/i.test(str)) {
    const emailMatch = str.match(/authenticated successfully as ([^\s]+)/);
    return {
      ok: false,
      state: "region_blocked",
      errorCode: "AGY_REGION_BLOCKED",
      message: "agy backend rejected this region (FAILED_PRECONDITION)",
      accountEmail: emailMatch ? emailMatch[1] : "",
    };
  }
  const authMatch = str.match(/OAuth: authenticated successfully as ([^\s]+)/);
  if (authMatch) {
    return {
      ok: true,
      state: "fresh",
      accountEmail: authMatch[1],
    };
  }
  return {
    ok: false,
    state: "unknown",
    errorCode: "AGY_AUTH_UNVERIFIED",
    message: "no successful OAuth handshake found in recent agy log",
  };
}

async function inspectAgyDirectAuth({
  env = process.env,
  readLogTailImpl = readAgyLogTail,
  findLogImpl = findMostRecentAgyLog,
  resolveLogDirImpl = resolveAgyLogDir,
} = {}) {
  const logDir = resolveLogDirImpl(env);
  const file = findLogImpl(logDir);
  const tail = file ? readLogTailImpl(file) : "";
  const classification = classifyAgyLogTail(tail);
  const base = {
    provider: "agy",
    transport: "antigravity-tui",  // No API mode — TUI is the only path.
    credentialKind: "oauth",
    source: "google-keyring",
    credentialPath: file || logDir || "",
  };
  if (classification.ok) {
    return {
      ...base,
      ok: true,
      state: classification.state,
      accountEmail: classification.accountEmail || "",
      account: classification.accountEmail || "",
    };
  }
  return {
    ...base,
    ok: false,
    state: classification.state,
    errorCode: classification.errorCode,
    error: classification.message,
    accountEmail: classification.accountEmail || "",
    hint: classification.errorCode === "AGY_ACCOUNT_INELIGIBLE"
      || classification.errorCode === "AGY_REGION_BLOCKED"
      ? "Antigravity requires an 18+ Google account in a supported region. Try a different account or wait for broader rollout."
      : "Run `agy` once to produce an authentication handshake log.",
  };
}

async function inspectKimiDirectAuth({
  env = process.env,
  fetchImpl = global.fetch,
  autoRefresh = false,
} = {}) {
  const paths = resolveKimiCredentialPaths({ env });
  try {
    const credential = await resolveKimiUpstreamCredentials({
      env,
      fetchImpl,
      autoRefresh,
    });
    return {
      ok: true,
      provider: "kimi",
      transport: "openai-chat",
      credentialKind: String(credential.credentialKind || ""),
      source: String(credential.source || ""),
      state: String(credential.state || ""),
      refreshable: credential.refreshable === true,
      expiresAt: String(credential.expiresAt || ""),
      credentialPath: String(credential.credentialPath || paths.credentialPath || ""),
    };
  } catch (err) {
    return {
      ok: false,
      provider: "kimi",
      error: err && err.message ? err.message : "Kimi direct API credentials are unavailable",
      errorCode: normalizeErrorCode(err, "KIMI_AUTH_STATUS_FAILED"),
      credentialPath: paths.credentialPath || "",
      hint: "Run `kimi` once to sign in or set UFOO_UCODE_API_KEY; ufoo-agent will not fall back to the CLI.",
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
  if (selected === "agy") {
    return inspectAgyDirectAuth(nextOptions);
  }
  if (selected === "kimi") {
    return inspectKimiDirectAuth(nextOptions);
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

function formatAgyDirectAuthStatus(status = {}, options = {}) {
  if (options.compact === true) {
    if (status.ok) {
      const details = [
        status.accountEmail ? status.accountEmail : "",
        status.source || "google-keyring",
      ].filter(Boolean);
      const lines = [`Agy: OK · keyring · ${status.state || "fresh"}`];
      if (details.length > 0) lines.push(`  ${details.join(" · ")}`);
      return lines;
    }
    const hint = String(status.hint || "Run `agy` once to verify the OAuth handshake.").replace(/;.*$/, ".");
    return [
      `Agy: FAIL · ${status.errorCode || "AGY_AUTH_STATUS_FAILED"}`,
      `  ${status.error || "agy authentication state unknown"} · ${hint}`,
    ];
  }

  if (status.ok) {
    const lines = [
      `Agy CLI: OK (keyring, ${status.state || "fresh"})`,
      `  - source: ${status.source || "google-keyring"}`,
    ];
    if (status.accountEmail) lines.push(`  - account: ${status.accountEmail}`);
    if (status.credentialPath) lines.push(`  - log: ${status.credentialPath}`);
    return lines;
  }

  const lines = [
    `Agy CLI: FAIL (${status.errorCode || "AGY_AUTH_STATUS_FAILED"})`,
    `  - ${status.error || "agy authentication state unknown"}`,
  ];
  if (status.accountEmail) lines.push(`  - account: ${status.accountEmail}`);
  if (status.credentialPath) lines.push(`  - log: ${status.credentialPath}`);
  if (status.hint) lines.push(`  - ${status.hint}`);
  return lines;
}

function formatKimiDirectAuthStatus(status = {}, options = {}) {
  if (options.compact === true) {
    if (status.ok) {
      const credential = status.credentialKind || "credential";
      const transport = status.transport || "openai-chat";
      const state = status.state || "unknown";
      const details = [
        status.source || "",
        status.expiresAt ? `expires ${formatCompactExpires(status.expiresAt)}` : "",
        status.refreshable ? "refreshable" : "",
      ].filter(Boolean);
      const lines = [
        `Kimi API: OK · ${credential}/${transport} · ${state}`,
      ];
      if (details.length > 0) lines.push(`  ${details.join(" · ")}`);
      return lines;
    }

    const hint = String(status.hint || "Run `kimi` once to sign in or set UFOO_UCODE_API_KEY.").replace(/;.*$/, ".");
    return [
      `Kimi API: FAIL · ${status.errorCode || "KIMI_AUTH_STATUS_FAILED"}`,
      `  ${status.error || "Kimi direct API credentials are unavailable"} · ${hint}`,
    ];
  }

  if (status.ok) {
    const state = status.state || "unknown";
    const lines = [
      `Kimi direct API: OK (${status.transport || "openai-chat"}, ${status.credentialKind || "credential"}, ${state})`,
      `  - source: ${status.source || "(unknown)"}`,
    ];
    if (status.expiresAt) lines.push(`  - expires: ${status.expiresAt}`);
    if (status.credentialPath) lines.push(`  - path: ${status.credentialPath}`);
    if (status.refreshable) lines.push("  - refreshable: yes");
    return lines;
  }

  const lines = [
    `Kimi direct API: FAIL (${status.errorCode || "KIMI_AUTH_STATUS_FAILED"})`,
    `  - ${status.error || "Kimi direct API credentials are unavailable"}`,
  ];
  if (status.credentialPath) lines.push(`  - expected path: ${status.credentialPath}`);
  if (status.hint) lines.push(`  - ${status.hint}`);
  return lines;
}

function formatDirectAuthStatus(status = {}, options = {}) {
  if (status.provider === "claude") {
    return formatClaudeDirectAuthStatus(status, options);
  }
  if (status.provider === "agy") {
    return formatAgyDirectAuthStatus(status, options);
  }
  if (status.provider === "kimi") {
    return formatKimiDirectAuthStatus(status, options);
  }
  return formatCodexDirectAuthStatus(status, options);
}

module.exports = {
  inspectDirectAuthStatus,
  inspectCodexDirectAuth,
  inspectClaudeDirectAuth,
  inspectAgyDirectAuth,
  inspectKimiDirectAuth,
  formatDirectAuthStatus,
  formatCodexDirectAuthStatus,
  formatClaudeDirectAuthStatus,
  formatAgyDirectAuthStatus,
  formatKimiDirectAuthStatus,
  normalizeDirectAuthProvider,
  classifyAgyLogTail,
};

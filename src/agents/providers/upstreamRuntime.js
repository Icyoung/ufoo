"use strict";

const { loadConfig, defaultAgentModelForProvider, sameModelProvider } = require("../../config");
const { resolveRuntimeConfig } = require("./runtimeConfig");
const { resolveClaudeUpstreamCredentials } = require("./credentials/claude");
const { resolveCodexUpstreamCredentials } = require("./credentials/codex");
const { resolveKimiUpstreamCredentials } = require("./credentials/kimi");
const { buildUpstreamAuthFromCredential } = require("./credentials");

const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "ucode";
  if (text === "codex-cli" || text === "codex-code" || text === "codex" || text === "openai") return "codex";
  if (text === "claude-cli" || text === "claude-code" || text === "claude" || text === "anthropic") return "claude";
  if (text === "grok" || text === "grok-cli" || text === "grok-build" || text === "grok-shell" || text === "grok-api" || text === "xai") return "grok";
  if (text === "ucode") return "ucode";
  if (text === "kimi-cli" || text === "kimi-code" || text === "moonshot") return "kimi";
  return text;
}

function resolveConfiguredModelForProvider(config = {}, provider = "") {
  if (config.agentProvider && sameModelProvider(config.agentProvider, provider)) {
    return config.agentModel;
  }
  return "";
}

async function resolveUpstreamRuntime({
  projectRoot,
  provider = "",
  model = "",
  env = process.env,
  fetchImpl = global.fetch,
  loadConfigImpl = loadConfig,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const config = loadConfigImpl(projectRoot);

  if (normalizedProvider === "codex") {
    const credential = await resolveCodexUpstreamCredentials({
      authPath: config.codexAuthPath,
      refreshWindowMs: Number(config.codexOauthRefreshWindowSec || 300) * 1000,
      fetchImpl,
      env,
    });
    const useCodexOAuth = credential.credentialKind === "oauth" && Boolean(credential.accessToken);
    const baseUrl = useCodexOAuth
      ? String(env.UFOO_CODEX_BASE_URL || "").trim() || CODEX_DEFAULT_BASE_URL
      : String(env.OPENAI_BASE_URL || "").trim() || "https://api.openai.com/v1";
    const resolvedModel = String(
      model
        || resolveConfiguredModelForProvider(config, "codex")
        || defaultAgentModelForProvider("codex")
    ).trim();
    return {
      provider: "codex",
      transport: "codex-responses",
      requestProfile: useCodexOAuth ? "codex-subscription" : "openai-responses",
      model: resolvedModel,
      baseUrl,
      credential,
      auth: buildUpstreamAuthFromCredential(credential),
      credentialSource: String(credential.source || ""),
    };
  }

  if (normalizedProvider === "claude") {
    const credential = await resolveClaudeUpstreamCredentials({
      profile: config.claudeOauthProfile,
      tokenPath: config.claudeOauthTokenPath,
      refreshWindowMs: Number(config.claudeOauthRefreshWindowSec || 300) * 1000,
      env,
    });
    const baseUrl = String(env.ANTHROPIC_BASE_URL || credential.metadata?.baseUrl || "").trim() || "https://api.anthropic.com/v1";
    const resolvedModel = String(
      model
        || resolveConfiguredModelForProvider(config, "claude")
        || defaultAgentModelForProvider("claude")
    ).trim();
    return {
      provider: "claude",
      transport: "anthropic-messages",
      model: resolvedModel,
      baseUrl,
      credential,
      auth: buildUpstreamAuthFromCredential(credential),
      credentialSource: String(credential.source || ""),
    };
  }

  if (normalizedProvider === "grok") {
    const runtime = resolveRuntimeConfig({
      workspaceRoot: projectRoot,
      provider: "grok-build",
      model: model || resolveConfiguredModelForProvider(config, "grok-build") || defaultAgentModelForProvider("grok-build"),
      useCodingConfig: false,
    });
    const auth = runtime.apiKey ? { apiKey: String(runtime.apiKey).trim() } : { headers: {} };
    return {
      provider: "grok-build",
      transport: "openai-responses",
      model: String(runtime.model || model || "").trim(),
      baseUrl: String(runtime.baseUrl || "").trim(),
      credential: null,
      auth,
      credentialSource: runtime.apiKey ? "runtime-api-key" : "",
    };
  }

  const runtime = resolveRuntimeConfig({
    workspaceRoot: projectRoot,
    provider: normalizedProvider === "ucode" ? "" : normalizedProvider,
    model: model || resolveConfiguredModelForProvider(config, normalizedProvider) || defaultAgentModelForProvider(config.agentProvider),
    useCodingConfig: normalizedProvider === "ucode",
  });
  let credential = null;
  if (runtime.provider === "kimi" && runtime.apiKeySource === "kimi-credential") {
    credential = await resolveKimiUpstreamCredentials({ env, fetchImpl });
    runtime.apiKey = credential.accessToken;
  }
  const auth = runtime.apiKey ? { apiKey: String(runtime.apiKey || "").trim() } : { headers: {} };
  return {
    provider: String(runtime.provider || normalizedProvider || "ucode"),
    transport: String(runtime.transport || "openai-chat"),
    model: String(runtime.model || "").trim(),
    baseUrl: String(runtime.baseUrl || "").trim(),
    credential,
    auth,
    credentialSource: runtime.apiKey ? "runtime-api-key" : "",
  };
}

module.exports = { normalizeProvider, resolveUpstreamRuntime };

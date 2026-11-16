"use strict";

const { loadConfig, defaultAgentModelForProvider, defaultAuxModelForProvider, sameModelProvider } = require("../../config");
const { readKimiAccessToken } = require("./credentials/kimi");
const { DEFAULT_AGY_BASE_URL } = require("./credentials/agy");

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_GROK_BUILD_BASE_URL = DEFAULT_XAI_BASE_URL;
const DEFAULT_GROK_BUILD_MODEL = "grok-4.6";
const DEFAULT_KIMI_MODEL = "k3";

const { normalizeProvider } = require("./providerId");

function normalizeKimiModel(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const suffix = raw.match(/^(.*?)(\([^)]*\))$/);
  const base = String(suffix ? suffix[1] : raw).trim().replace(/\[1m\]$/i, "");
  const lower = base.toLowerCase();
  let normalized = lower;
  if (["kimi-k2.7-code", "k2.7-code", "kimi-for-coding", "for-coding"].includes(lower)) {
    normalized = "kimi-for-coding";
  } else if (["kimi-k2.7-code-highspeed", "k2.7-code-highspeed", "kimi-for-coding-highspeed", "for-coding-highspeed"].includes(lower)) {
    normalized = "kimi-for-coding-highspeed";
  } else if (normalized.startsWith("kimi-")) {
    normalized = normalized.slice("kimi-".length);
  }
  return `${normalized}${suffix ? suffix[2] : ""}`;
}

function resolveTransport({ provider = "", baseUrl = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const url = String(baseUrl || "").trim().toLowerCase();

  if (normalizedProvider === "codex" || normalizedProvider === "grok-build" || normalizedProvider === "xai") {
    return "openai-responses";
  }
  if (normalizedProvider === "anthropic") return "anthropic-messages";
  if (normalizedProvider === "agy") return "antigravity";
  if (normalizedProvider === "kimi") return "openai-chat";
  if (/\/responses(?:$|[/?#])/.test(url)) return "openai-responses";

  return "openai-chat";
}

function resolveRuntimeConfig({ workspaceRoot = process.cwd(), provider = "", model = "", useCodingConfig = true } = {}) {
  const config = loadConfig(workspaceRoot);
  const configuredProvider = normalizeProvider((useCodingConfig ? config.ucodeProvider : "") || config.agentProvider || "");
  const selectedProvider = normalizeProvider(
    provider
      || (useCodingConfig ? process.env.UFOO_UCODE_PROVIDER : "")
      || configuredProvider
      || "openai"
  ) || "openai";
  const custom = selectedProvider === "openai" && config.agentProvider === "custom"
    && (!useCodingConfig || !(config.ucodeProvider || process.env.UFOO_UCODE_PROVIDER));
  const useCodingGateway = useCodingConfig && (selectedProvider !== "agy" || normalizeProvider(config.ucodeProvider) === "agy");
  const modelProviderMatches = sameModelProvider((useCodingConfig ? config.ucodeProvider : "") || config.agentProvider, selectedProvider);
  function modelSetting(codingModel, agentModel) {
    if (selectedProvider === "agy") {
      return (useCodingGateway ? codingModel : "") || (normalizeProvider(config.agentProvider) === "agy" ? agentModel : "");
    }
    return modelProviderMatches ? ((useCodingConfig ? codingModel : "") || agentModel) : "";
  }
  const configuredModel = modelSetting(config.ucodeModel, config.agentModel);

  const selectedModel = String(
    model
      || (useCodingConfig ? process.env.UFOO_UCODE_MODEL : "")
      || configuredModel
      || (selectedProvider === "kimi"
        ? DEFAULT_KIMI_MODEL
        : (selectedProvider === "grok-build" ? DEFAULT_GROK_BUILD_MODEL : custom ? "" : defaultAgentModelForProvider(selectedProvider)))
  ).trim();

  const defaultBaseUrl = selectedProvider === "anthropic"
    ? String(process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL)
    : selectedProvider === "kimi"
      ? String(process.env.KIMI_BASE_URL || DEFAULT_KIMI_BASE_URL)
      : selectedProvider === "codex"
        ? String(process.env.UFOO_CODEX_BASE_URL || DEFAULT_CODEX_BASE_URL)
        : selectedProvider === "grok-build"
          ? String(
            process.env.UFOO_GROK_BUILD_BASE_URL
              || process.env.GROK_BUILD_BASE_URL
              || DEFAULT_GROK_BUILD_BASE_URL
          )
          : selectedProvider === "xai"
            ? String(process.env.XAI_BASE_URL || DEFAULT_XAI_BASE_URL)
            : selectedProvider === "agy"
              ? String(process.env.UFOO_AGY_BASE_URL || DEFAULT_AGY_BASE_URL)
              : String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL);

  let baseUrl = String(
    (custom ? process.env.UFOO_AGENT_BASE_URL || config.agentBaseUrl : "")
      || (useCodingConfig ? process.env.UFOO_UCODE_BASE_URL : "")
      || (useCodingGateway ? config.ucodeBaseUrl : "")
      || defaultBaseUrl
  ).trim();
  if (custom) baseUrl = String(process.env.UFOO_AGENT_BASE_URL || config.agentBaseUrl || "").trim();

  const explicitApiKey = String(custom ? process.env.UFOO_AGENT_API_KEY || config.agentApiKey || "" :
    (useCodingConfig ? process.env.UFOO_UCODE_API_KEY : "")
      || (useCodingGateway ? config.ucodeApiKey : "")
      || ""
  ).trim();
  let apiKey = explicitApiKey;
  let apiKeySource = explicitApiKey ? "explicit" : "";
  let kimiCredentialState = "";
  if (!apiKey && selectedProvider === "kimi") {
    const credential = readKimiAccessToken({ env: process.env });
    if (credential && credential.accessToken) {
      apiKey = String(credential.accessToken).trim();
      apiKeySource = "kimi-credential";
      kimiCredentialState = String(credential.state || "");
    }
  }
  if (!apiKey && !custom) {
    apiKey = String(
      (selectedProvider === "openai" ? process.env.OPENAI_API_KEY : "")
        || (selectedProvider === "anthropic" ? process.env.ANTHROPIC_API_KEY : "")
        || (selectedProvider === "codex" ? process.env.OPENAI_API_KEY : "")
        || (selectedProvider === "grok-build" ? (process.env.GROK_BUILD_API_KEY || process.env.XAI_API_KEY) : "")
        || (selectedProvider === "xai" ? process.env.XAI_API_KEY : "")
        || ""
    ).trim();
    if (apiKey) apiKeySource = "env";
  }

  // ChatGPT's Codex backend accepts Codex OAuth credentials, while standard
  // OpenAI API keys belong on the public OpenAI API. Generic ucode base URL
  // overrides remain authoritative for an explicitly configured gateway.
  if (
    selectedProvider === "codex"
    && apiKey
    && !String(useCodingConfig ? process.env.UFOO_UCODE_BASE_URL || "" : "").trim()
    && !String(useCodingConfig ? config.ucodeBaseUrl || "" : "").trim()
  ) {
    baseUrl = String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim();
  }

  const configuredAuxModel = modelSetting(config.ucodeAuxModel, config.agentAuxModel);
  const selectedAuxModel = String(
    (useCodingConfig ? process.env.UFOO_UCODE_AUX_MODEL : "")
      || configuredAuxModel
      || (custom ? "" : defaultAuxModelForProvider(selectedProvider))
  ).trim();

  return {
    provider: selectedProvider,
    model: selectedModel,
    auxModel: selectedAuxModel,
    baseUrl,
    apiKey,
    apiKeySource,
    kimiCredentialState,
    transport: resolveTransport({ provider: selectedProvider, baseUrl }),
    allowUnlistedModels: custom,
  };
}

// Model discovery and inference must resolve the same credentials and URL.
// The synchronous resolver alone cannot refresh subscription credentials.
async function resolveAuthenticatedRuntime(options = {}) {
  const runtime = resolveRuntimeConfig(options);
  const workspaceRoot = options.workspaceRoot || process.cwd();
  let accountId = "";
  if (runtime.provider === "codex" && !runtime.apiKey) {
    try {
      const config = loadConfig(workspaceRoot) || {};
      const { resolveCodexUpstreamCredentials } = require("./credentials/codex");
      const credential = await resolveCodexUpstreamCredentials({
        authPath: config.codexAuthPath,
        refreshWindowMs: Number(config.codexOauthRefreshWindowSec || 300) * 1000,
        env: process.env,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      const token = String(credential && (credential.accessToken || credential.apiKey) || "").trim();
      if (token) {
        runtime.apiKey = token;
        runtime.apiKeySource = String(credential.source || "codex-credential");
      }
      if (credential?.credentialKind === "api-key"
        && !String(process.env.UFOO_UCODE_BASE_URL || "").trim()
        && !String(config.ucodeBaseUrl || "").trim()) {
        runtime.baseUrl = String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).trim();
      }
      if (credential?.credentialKind === "oauth") accountId = String(credential.accountId || "").trim();
    } catch { /* Requests surface missing/invalid credentials. */ }
  }
  if (runtime.provider === "kimi" && runtime.apiKeySource === "kimi-credential" && runtime.kimiCredentialState !== "fresh") {
    try {
      const { resolveKimiUpstreamCredentials } = require("./credentials/kimi");
      const credential = await resolveKimiUpstreamCredentials({ env: process.env,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
      if (credential?.accessToken) runtime.apiKey = String(credential.accessToken).trim();
    } catch { /* Retain the file token; requests surface auth failures. */ }
  }
  return { ...runtime, accountId, requestHeaders: accountId ? { "chatgpt-account-id": accountId } : {} };
}

function resolveCompletionUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/chat/completions`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/chat/completions`;
  return `${normalized}/chat/completions`;
}

function resolveResponsesUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\/+$/, "");
  if (/\/responses$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/responses`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/responses`;
  return `${normalized}/responses`;
}

function resolveAnthropicMessagesUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim() || DEFAULT_ANTHROPIC_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (/\/messages$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/messages`;
  return `${normalized}/messages`;
}

module.exports = { normalizeProvider, normalizeKimiModel, resolveTransport, resolveRuntimeConfig, resolveAuthenticatedRuntime, resolveCompletionUrl, resolveResponsesUrl, resolveAnthropicMessagesUrl, DEFAULT_OPENAI_BASE_URL };

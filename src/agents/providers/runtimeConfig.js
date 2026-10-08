"use strict";

const { loadConfig, defaultAgentModelForProvider, sameModelProvider } = require("../../config");
const { readKimiAccessToken } = require("./credentials/kimi");

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_GROK_BUILD_BASE_URL = DEFAULT_XAI_BASE_URL;
const DEFAULT_GROK_BUILD_MODEL = "grok-4.6";
const DEFAULT_KIMI_MODEL = "k3";

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "codex" || text === "codex-cli" || text === "codex-code") return "codex";
  if (text === "claude" || text === "claude-cli" || text === "claude-code") return "anthropic";
  if (text === "kimi" || text === "kimi-code" || text === "moonshot") return "kimi";
  if (text === "grok" || text === "grok-build" || text === "grok-shell" || text === "grok-api") return "grok-build";
  if (text === "xai") return "xai";
  if (text === "openai" || text === "anthropic") return text;
  return text;
}

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
  if (normalizedProvider === "kimi") return "openai-chat";
  if (/\/responses(?:$|[/?#])/.test(url)) return "openai-responses";
  if (url.includes("anthropic.com")) return "anthropic-messages";
  if (/\/messages(?:$|[/?#])/.test(url) && !/\/chat\/completions(?:$|[/?#])/.test(url)) {
    return "anthropic-messages";
  }

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
  const configuredModel = sameModelProvider((useCodingConfig ? config.ucodeProvider : "") || config.agentProvider, selectedProvider)
    ? ((useCodingConfig ? config.ucodeModel : "") || config.agentModel)
    : "";

  const selectedModel = String(
    model
      || (useCodingConfig ? process.env.UFOO_UCODE_MODEL : "")
      || configuredModel
      || (selectedProvider === "kimi"
        ? DEFAULT_KIMI_MODEL
        : (selectedProvider === "grok-build" ? DEFAULT_GROK_BUILD_MODEL : defaultAgentModelForProvider(selectedProvider)))
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
            : String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL);

  let baseUrl = String(
    (useCodingConfig ? process.env.UFOO_UCODE_BASE_URL : "")
      || (useCodingConfig ? config.ucodeBaseUrl : "")
      || defaultBaseUrl
  ).trim();

  const explicitApiKey = String(
    (useCodingConfig ? process.env.UFOO_UCODE_API_KEY : "")
      || (useCodingConfig ? config.ucodeApiKey : "")
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
  if (!apiKey) {
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

  return {
    provider: selectedProvider,
    model: selectedModel,
    baseUrl,
    apiKey,
    apiKeySource,
    kimiCredentialState,
    transport: resolveTransport({ provider: selectedProvider, baseUrl }),
  };
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

module.exports = { normalizeProvider, normalizeKimiModel, resolveTransport, resolveRuntimeConfig, resolveCompletionUrl, resolveResponsesUrl, resolveAnthropicMessagesUrl, DEFAULT_OPENAI_BASE_URL };

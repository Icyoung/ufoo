"use strict";

const os = require("os");
const { randomUUID } = require("crypto");
const {
  loadConfig,
  defaultAgentModelForProvider,
  defaultRouterModelForProvider,
  sameModelProvider,
} = require("../../config");
const {
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveAnthropicMessagesUrl,
} = require("../../code/nativeRunner");
const {
  buildResponsesPayload,
  parseResponsesEvents,
  resolveResponsesUrl,
} = require("../../code/providers/responsesProtocol");
const { resolveClaudeUpstreamCredentials } = require("./credentials/claude");
const { resolveCodexUpstreamCredentials } = require("./credentials/codex");
const { buildUpstreamAuthFromCredential } = require("./credentials");

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "ucode";
  if (text === "codex-cli" || text === "codex-code" || text === "codex" || text === "openai") return "codex";
  if (text === "claude-cli" || text === "claude-code" || text === "claude" || text === "anthropic") return "claude";
  if (text === "grok" || text === "grok-cli" || text === "grok-build" || text === "grok-shell" || text === "grok-api" || text === "xai") return "grok";
  if (text === "ucode" || text === "ufoo" || text === "ufoo-code") return "ucode";
  return text;
}

function clipText(value = "", maxChars = 500) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated]`;
}

const CODEX_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_DEFAULT_USER_AGENT = "codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)";
const CODEX_DEFAULT_ORIGINATOR = "codex-tui";
const GROK_DEFAULT_CLIENT_VERSION = "0.2.120";
const KIMI_DEFAULT_CLIENT_VERSION = (() => {
  try {
    return String(require("../../../package.json").version || "dev").trim() || "dev";
  } catch {
    return "dev";
  }
})();

function normalizeKimiUpstreamModel(value = "") {
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

function applyKimiHeaders(headers, { apiKey = "", stream = false } = {}) {
  const version = String(process.env.UFOO_KIMI_CLIENT_VERSION || KIMI_DEFAULT_CLIENT_VERSION).trim()
    || KIMI_DEFAULT_CLIENT_VERSION;
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  headers["User-Agent"] = `ufoo/${version}`;
  headers["X-Msh-Platform"] = "ufoo";
  headers["X-Msh-Version"] = version;
  headers["X-Msh-Device-Name"] = os.hostname();
  headers["X-Msh-Device-Model"] = `${process.platform} ${process.arch}`;
  headers["X-Msh-Device-Id"] = String(process.env.KIMI_DEVICE_ID || "ufoo-kimi-device").trim() || "ufoo-kimi-device";
  headers.Accept = stream ? "text/event-stream" : "application/json";
  return headers;
}

function isGrokCliProxyUrl(url = "") {
  try {
    return new URL(String(url || "")).hostname.toLowerCase() === "cli-chat-proxy.grok.com";
  } catch {
    return false;
  }
}

function applyGrokResponsesHeaders(headers, { provider = "", baseUrl = "", sessionId = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider !== "grok" && normalizedProvider !== "xai") return headers;
  const version = String(process.env.UFOO_GROK_CLIENT_VERSION || GROK_DEFAULT_CLIENT_VERSION).trim()
    || GROK_DEFAULT_CLIENT_VERSION;
  if (sessionId) headers["x-grok-conv-id"] = String(sessionId);
  if (isGrokCliProxyUrl(baseUrl)) {
    headers["X-XAI-Token-Auth"] = "xai-grok-cli";
    headers["x-grok-client-version"] = version;
    headers["x-grok-client-identifier"] = "grok-shell";
    headers["x-authenticateresponse"] = "authenticate-response";
    headers["User-Agent"] = `xai-grok-workspace/${version}`;
  } else if (normalizedProvider === "grok") {
    headers["User-Agent"] = `grok-shell/${version}`;
  }
  return headers;
}

function resolveConfiguredModelForProvider(config = {}, provider = "") {
  if (config.routerProvider && sameModelProvider(config.routerProvider, provider)) {
    return config.routerModel;
  }
  if (config.agentProvider && sameModelProvider(config.agentProvider, provider)) {
    return config.agentModel;
  }
  return "";
}

function buildOpenAiChatRequest({
  model = "",
  systemPrompt = "",
  prompt = "",
  messages = [],
  tools = [],
  temperature = 0,
} = {}) {
  const requestMessages = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
  if (!requestMessages.length) {
    if (systemPrompt) requestMessages.push({ role: "system", content: String(systemPrompt) });
    requestMessages.push({ role: "user", content: String(prompt || "") });
  }
  const request = {
    model: String(model || "").trim(),
    messages: requestMessages,
    temperature,
  };
  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = tools.slice();
  }
  return request;
}

// Anthropic prompt caching allows up to 4 cache_control breakpoints; the
// system prompt is a stable prefix, so it is always marked, and once there
// is real history the last user message is marked too so follow-up turns
// reuse the cached conversation prefix.
const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };
const ANTHROPIC_CACHE_MIN_HISTORY = 3;

function withAnthropicCacheControl(content) {
  if (Array.isArray(content)) {
    if (!content.length) return content;
    return content.map((block, index) => (
      index === content.length - 1 && block && typeof block === "object"
        ? { ...block, cache_control: { ...ANTHROPIC_CACHE_CONTROL } }
        : block
    ));
  }
  return [{
    type: "text",
    text: String(content || ""),
    cache_control: { ...ANTHROPIC_CACHE_CONTROL },
  }];
}

function buildAnthropicMessagesRequest({
  model = "",
  systemPrompt = "",
  prompt = "",
  messages = [],
  tools = [],
  maxTokens = 4096,
  temperature = 0,
} = {}) {
  const requestMessages = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
  if (!requestMessages.length) {
    requestMessages.push({ role: "user", content: String(prompt || "") });
  }
  if (requestMessages.length >= ANTHROPIC_CACHE_MIN_HISTORY) {
    for (let i = requestMessages.length - 1; i >= 0; i -= 1) {
      if (requestMessages[i].role !== "user") continue;
      requestMessages[i].content = withAnthropicCacheControl(requestMessages[i].content);
      break;
    }
  }
  const request = {
    model: String(model || "").trim(),
    max_tokens: maxTokens,
    messages: requestMessages,
    temperature,
  };
  if (systemPrompt) request.system = withAnthropicCacheControl(String(systemPrompt));
  if (Array.isArray(tools) && tools.length > 0) {
    request.tools = tools.slice();
  }
  return request;
}

function normalizeCodexContentPart(role = "user", text = "") {
  return {
    type: role === "assistant" ? "output_text" : "input_text",
    text: String(text || ""),
  };
}

function normalizeCodexMessage(role = "user", content = "") {
  return {
    type: "message",
    role: role === "system" ? "developer" : role,
    content: [normalizeCodexContentPart(role, content)],
  };
}

function buildCodexResponsesRequest({
  model = "",
  systemPrompt = "",
  prompt = "",
  messages = [],
  tools = [],
  maxTokens = 131072,
  reasoningEffort = "",
} = {}) {
  const inputMessages = Array.isArray(messages) ? messages.slice() : [];
  if (String(prompt || "").trim()) {
    inputMessages.push({ role: "user", content: String(prompt || "") });
  }
  return buildResponsesPayload({
    model,
    instructions: systemPrompt,
    messages: inputMessages,
    tools,
    maxOutputTokens: maxTokens,
    reasoningEffort,
    provider: "codex",
  });
}

function resolveCodexResponseOutput(response = {}) {
  const output = Array.isArray(response.output) ? response.output : [];
  return output
    .filter((item) => item && item.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part && part.type === "output_text")
    .map((part) => String(part.text || ""))
    .join("");
}

function parseCodexSsePayload(payload = "") {
  const lines = String(payload || "").split(/\r?\n/);
  const frames = [];
  let currentEvent = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("event:")) {
      currentEvent = trimmed.slice(6).trim();
      continue;
    }
    if (!trimmed.startsWith("data:")) continue;
    const dataText = trimmed.slice(5).trim();
    if (!dataText || dataText === "[DONE]") continue;
    try {
      const data = JSON.parse(dataText);
      frames.push({ event: currentEvent || data.type || "", data });
      currentEvent = "";
    } catch {
      continue;
    }
  }

  const parsed = parseResponsesEvents(frames);
  const rawUsage = parsed.response && parsed.response.usage && typeof parsed.response.usage === "object"
    ? parsed.response.usage
    : null;

  return {
    text: String(parsed.text || "").trim(),
    response: parsed.response,
    usage: rawUsage,
    normalizedUsage: parsed.usage,
    toolCalls: parsed.toolCalls,
    terminal: parsed.terminal,
    incompleteDetails: parsed.incompleteDetails,
    events: parsed.events,
  };
}

function resolveUpstreamResponsesUsage(parsed = {}) {
  const raw = parsed.response && parsed.response.usage && typeof parsed.response.usage === "object"
    ? parsed.response.usage
    : null;
  if (raw) return raw;
  const normalized = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null;
  if (!normalized) return null;
  return {
    input_tokens: Number(normalized.input || 0) || 0,
    output_tokens: Number(normalized.output || 0) || 0,
    cache_read_input_tokens: Number(normalized.cacheRead || 0) || 0,
    cache_creation_input_tokens: Number(normalized.cacheCreation || 0) || 0,
  };
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
        || defaultRouterModelForProvider("codex")
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
    const baseUrl = String(env.ANTHROPIC_BASE_URL || "").trim() || "https://api.anthropic.com/v1";
    const resolvedModel = String(
      model
        || resolveConfiguredModelForProvider(config, "claude")
        || defaultRouterModelForProvider("claude")
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
      model: model || resolveConfiguredModelForProvider(config, "grok-build") || defaultRouterModelForProvider("grok-build"),
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
  });
  const auth = runtime.apiKey ? { apiKey: String(runtime.apiKey || "").trim() } : { headers: {} };
  return {
    provider: String(runtime.provider || normalizedProvider || "ucode"),
    transport: String(runtime.transport || "openai-chat"),
    model: String(runtime.model || "").trim(),
    baseUrl: String(runtime.baseUrl || "").trim(),
    credential: null,
    auth,
    credentialSource: runtime.apiKey ? "runtime-api-key" : "",
  };
}

async function sendUpstreamRequest({
  runtime,
  request,
  sessionId = "",
  timeoutMs = 120000,
  fetchImpl = global.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "fetch is unavailable" };
  }
  const resolvedRuntime = runtime && typeof runtime === "object" ? runtime : {};
  const rawRequestModel = String((request && request.model) || resolvedRuntime.model || "").trim();
  const isKimi = normalizeProvider(resolvedRuntime.provider) === "kimi";
  const requestModel = isKimi ? normalizeKimiUpstreamModel(rawRequestModel) : rawRequestModel;
  if (!requestModel) {
    return { ok: false, error: `${resolvedRuntime.provider || "provider"} model is not configured` };
  }

  const isAnthropic = resolvedRuntime.transport === "anthropic-messages";
  const isCodexResponses = resolvedRuntime.transport === "codex-responses";
  const isResponses = isCodexResponses || resolvedRuntime.transport === "openai-responses";
  const url = isAnthropic
    ? resolveAnthropicMessagesUrl(resolvedRuntime.baseUrl)
    : isResponses
      ? resolveResponsesUrl(resolvedRuntime.baseUrl)
      : resolveCompletionUrl(resolvedRuntime.baseUrl);

  if (!url) {
    return { ok: false, error: `${resolvedRuntime.provider || "provider"} baseUrl is not configured` };
  }

  const headers = { "content-type": "application/json" };
  if (resolvedRuntime.auth && resolvedRuntime.auth.headers && typeof resolvedRuntime.auth.headers === "object") {
    Object.assign(headers, resolvedRuntime.auth.headers);
  }
  if (isAnthropic) {
    headers["anthropic-version"] = "2023-06-01";
    if (resolvedRuntime.auth && resolvedRuntime.auth.apiKey) headers["x-api-key"] = resolvedRuntime.auth.apiKey;
  } else if (isResponses) {
    headers.Accept = "text/event-stream";
    headers.Connection = "Keep-Alive";
    if (resolvedRuntime.auth && resolvedRuntime.auth.apiKey) {
      headers.authorization = `Bearer ${resolvedRuntime.auth.apiKey}`;
    }
    const resolvedSessionId = String(
      sessionId
        || (request && (request.sessionId || request.session_id))
        || resolvedRuntime.sessionId
        || ""
    ).trim() || randomUUID();
    if (isCodexResponses) {
      headers["User-Agent"] = CODEX_DEFAULT_USER_AGENT;
      headers.Originator = CODEX_DEFAULT_ORIGINATOR;
      if (resolvedRuntime.credential && resolvedRuntime.credential.accountId) {
        headers["Chatgpt-Account-Id"] = String(resolvedRuntime.credential.accountId);
      }
      headers["Session-Id"] = resolvedSessionId;
    } else {
      applyGrokResponsesHeaders(headers, {
        provider: resolvedRuntime.provider,
        baseUrl: resolvedRuntime.baseUrl,
        sessionId: resolvedSessionId,
      });
    }
  } else {
    if (isKimi) {
      applyKimiHeaders(headers, {
        apiKey: resolvedRuntime.auth && resolvedRuntime.auth.apiKey,
        stream: Boolean(request && request.stream),
      });
    } else if (resolvedRuntime.auth && resolvedRuntime.auth.apiKey) {
      headers.authorization = `Bearer ${resolvedRuntime.auth.apiKey}`;
    }
  }
  const requestBody = request && typeof request === "object" ? { ...request } : {};
  // The ChatGPT subscription Codex endpoint is Responses-shaped but does not
  // accept the public Responses API's optional max_output_tokens field. Keep
  // the limit for api.openai.com/API-key traffic and omit it only for the
  // OAuth-backed Codex subscription profile.
  if (isCodexResponses && resolvedRuntime.requestProfile === "codex-subscription") {
    delete requestBody.max_output_tokens;
  }
  if (isKimi) requestBody.model = requestModel;
  const body = JSON.stringify(requestBody);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      return {
        ok: false,
        error: `provider request failed (${response.status}): ${clipText(errBody)}`,
        provider: resolvedRuntime.provider,
        model: requestModel,
        transport: resolvedRuntime.transport,
        credentialSource: resolvedRuntime.credentialSource,
      };
    }

    if (isResponses) {
      // Responses supports both the normal streaming form and a complete JSON
      // response. The provider contract is still Responses-only here; the
      // JSON branch is useful for non-streaming gateways and test doubles.
      let parsed;
      let rawData = null;
      if (typeof response.text === "function") {
        const raw = await response.text();
        parsed = parseCodexSsePayload(raw);
        if (!parsed.response && !parsed.text && parsed.toolCalls.length === 0) {
          try {
            rawData = JSON.parse(raw);
            parsed = parseResponsesEvents([
              { event: rawData && rawData.type ? rawData.type : "response", data: rawData },
            ], { assumeCompleted: true });
          } catch {
            // Keep the SSE parse result; the caller will receive an empty
            // completed response rather than falling back to Chat Completions.
          }
        }
      } else if (typeof response.json === "function") {
        rawData = await response.json();
        parsed = parseResponsesEvents([
          { event: rawData && rawData.type ? rawData.type : "response", data: rawData },
        ], { assumeCompleted: true });
      } else {
        parsed = parseResponsesEvents([], { assumeCompleted: true });
      }
      return {
        ok: true,
        output: parsed.text,
        provider: String(resolvedRuntime.provider || ""),
        model: requestModel,
        transport: resolvedRuntime.transport,
        credentialSource: resolvedRuntime.credentialSource,
        data: parsed.response || rawData,
        usage: resolveUpstreamResponsesUsage(parsed),
        toolCalls: parsed.toolCalls,
        incompleteDetails: parsed.incompleteDetails,
      };
    }

    const data = await response.json();
    let text = "";
    if (isAnthropic) {
      const content = Array.isArray(data.content) ? data.content : [];
      text = content
        .filter((item) => item && item.type === "text")
        .map((item) => String(item.text || ""))
        .join("");
    } else {
      const choice = data.choices && data.choices[0];
      text = choice && choice.message && typeof choice.message.content === "string"
        ? choice.message.content
        : "";
    }

    return {
      ok: true,
      output: text.trim(),
      provider: String(resolvedRuntime.provider || ""),
      model: requestModel,
      transport: resolvedRuntime.transport,
      credentialSource: resolvedRuntime.credentialSource,
      data,
      usage: data && typeof data === "object" && data.usage && typeof data.usage === "object"
        ? data.usage
        : null,
    };
  } catch (err) {
    const message = err && err.message ? err.message : "upstream request failed";
    return {
      ok: false,
      error: message,
      provider: resolvedRuntime.provider,
      model: requestModel,
      transport: resolvedRuntime.transport,
      credentialSource: resolvedRuntime.credentialSource,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendUpstreamPrompt({
  projectRoot,
  prompt,
  systemPrompt,
  provider = "",
  model = "",
  messages = [],
  tools = [],
  maxTokens = 4096,
  temperature = 0,
  sessionId = "",
  timeoutMs = 120000,
  fetchImpl = global.fetch,
  env = process.env,
  loadConfigImpl = loadConfig,
} = {}) {
  let runtime;
  try {
    runtime = await resolveUpstreamRuntime({
      projectRoot,
      provider,
      model,
      env,
      fetchImpl,
      loadConfigImpl,
    });
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "upstream runtime resolution failed",
      errorCode: err && err.code ? err.code : "UPSTREAM_RUNTIME_RESOLUTION_FAILED",
      provider: normalizeProvider(provider),
      model: String(model || "").trim(),
    };
  }

  const requestModel = String(runtime.model || "").trim();
  const request = runtime.transport === "anthropic-messages"
    ? buildAnthropicMessagesRequest({
      model: requestModel,
      systemPrompt,
      prompt,
      messages,
      tools,
      maxTokens,
      temperature,
    })
    : runtime.transport === "codex-responses"
      ? buildCodexResponsesRequest({
        model: requestModel,
        systemPrompt,
        prompt,
        messages,
        tools,
        maxTokens,
        })
      : runtime.transport === "openai-responses"
        ? buildCodexResponsesRequest({
          model: requestModel,
          systemPrompt,
          prompt,
          messages,
          tools,
          maxTokens,
        })
      : buildOpenAiChatRequest({
      model: requestModel,
      systemPrompt,
      prompt,
      messages,
      tools,
      temperature,
    });

  return sendUpstreamRequest({
    runtime,
    request,
    sessionId,
    timeoutMs,
    fetchImpl,
  });
}

module.exports = {
  buildAnthropicMessagesRequest,
  buildCodexResponsesRequest,
  buildOpenAiChatRequest,
  normalizeProvider,
  normalizeKimiUpstreamModel,
  parseCodexSsePayload,
  resolveCodexResponseOutput,
  resolveUpstreamRuntime,
  sendUpstreamRequest,
  sendUpstreamPrompt,
};

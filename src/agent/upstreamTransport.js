"use strict";

const { randomUUID } = require("crypto");
const { loadConfig } = require("../config");
const {
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveAnthropicMessagesUrl,
} = require("../code/nativeRunner");
const { resolveClaudeUpstreamCredentials } = require("./credentials/claude");
const { resolveCodexUpstreamCredentials } = require("./credentials/codex");
const { buildUpstreamAuthFromCredential } = require("./credentials");

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "ucode";
  if (text === "codex-cli" || text === "codex-code" || text === "codex" || text === "openai") return "codex";
  if (text === "claude-cli" || text === "claude-code" || text === "claude" || text === "anthropic") return "claude";
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
  const request = {
    model: String(model || "").trim(),
    max_tokens: maxTokens,
    messages: requestMessages,
    temperature,
  };
  if (systemPrompt) request.system = systemPrompt;
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
} = {}) {
  const input = [];
  const history = Array.isArray(messages) ? messages : [];
  for (const message of history) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").trim() || "user";
    let content = message.content;
    if (Array.isArray(content)) {
      content = content
        .map((item) => {
          if (!item || typeof item !== "object") return "";
          return String(item.text || item.content || "");
        })
        .join("");
    }
    input.push(normalizeCodexMessage(role, content));
  }
  input.push(normalizeCodexMessage("user", prompt));

  return {
    model: String(model || "").trim(),
    instructions: String(systemPrompt || ""),
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      effort: "medium",
      summary: "auto",
    },
    input,
  };
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
  const chunks = [];
  let text = "";
  let responseObject = null;
  let usage = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const dataText = trimmed.slice(5).trim();
    if (!dataText || dataText === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(dataText);
    } catch {
      continue;
    }
    chunks.push(event);
    const type = String(event.type || "");
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      continue;
    }
    if (type === "response.output_item.done" && event.item && event.item.type === "message" && !text) {
      const content = Array.isArray(event.item.content) ? event.item.content : [];
      text += content
        .filter((part) => part && part.type === "output_text")
        .map((part) => String(part.text || ""))
        .join("");
      continue;
    }
    if (type === "response.completed" && event.response && typeof event.response === "object") {
      responseObject = event.response;
      usage = event.response.usage && typeof event.response.usage === "object"
        ? event.response.usage
        : null;
      if (!text) {
        text = resolveCodexResponseOutput(event.response);
      }
    }
  }

  return {
    text: String(text || "").trim(),
    response: responseObject,
    usage,
    events: chunks,
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
    const useCodexResponses = credential.credentialKind === "oauth" && Boolean(credential.accessToken);
    const baseUrl = useCodexResponses
      ? String(env.UFOO_CODEX_BASE_URL || "").trim() || CODEX_DEFAULT_BASE_URL
      : String(env.OPENAI_BASE_URL || "").trim() || "https://api.openai.com/v1";
    const resolvedModel = String(model || config.routerModel || config.agentModel || "").trim();
    return {
      provider: "codex",
      transport: useCodexResponses ? "codex-responses" : "openai-chat",
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
    const resolvedModel = String(model || config.routerModel || config.agentModel || "").trim();
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

  const runtime = resolveRuntimeConfig({
    workspaceRoot: projectRoot,
    provider: normalizedProvider === "ucode" ? "" : normalizedProvider,
    model,
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
  timeoutMs = 120000,
  fetchImpl = global.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    return { ok: false, error: "fetch is unavailable" };
  }
  const resolvedRuntime = runtime && typeof runtime === "object" ? runtime : {};
  const requestModel = String((request && request.model) || resolvedRuntime.model || "").trim();
  if (!requestModel) {
    return { ok: false, error: `${resolvedRuntime.provider || "provider"} model is not configured` };
  }

  const isAnthropic = resolvedRuntime.transport === "anthropic-messages";
  const isCodexResponses = resolvedRuntime.transport === "codex-responses";
  const url = isAnthropic
    ? resolveAnthropicMessagesUrl(resolvedRuntime.baseUrl)
    : isCodexResponses
      ? `${String(resolvedRuntime.baseUrl || "").replace(/\/+$/, "")}/responses`
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
  } else if (isCodexResponses) {
    headers.Accept = "text/event-stream";
    headers.Connection = "Keep-Alive";
    headers["User-Agent"] = CODEX_DEFAULT_USER_AGENT;
    headers.Originator = CODEX_DEFAULT_ORIGINATOR;
    if (resolvedRuntime.credential && resolvedRuntime.credential.accountId) {
      headers["Chatgpt-Account-Id"] = String(resolvedRuntime.credential.accountId);
    }
    headers.Session_id = randomUUID();
  } else {
    if (resolvedRuntime.auth && resolvedRuntime.auth.apiKey) headers.authorization = `Bearer ${resolvedRuntime.auth.apiKey}`;
  }
  const body = JSON.stringify(request || {});

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

    if (isCodexResponses) {
      const raw = await response.text();
      const parsed = parseCodexSsePayload(raw);
      return {
        ok: true,
        output: parsed.text,
        provider: String(resolvedRuntime.provider || ""),
        model: requestModel,
        transport: resolvedRuntime.transport,
        credentialSource: resolvedRuntime.credentialSource,
        data: parsed.response,
        usage: parsed.usage,
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
    timeoutMs,
    fetchImpl,
  });
}

module.exports = {
  buildAnthropicMessagesRequest,
  buildCodexResponsesRequest,
  buildOpenAiChatRequest,
  normalizeProvider,
  parseCodexSsePayload,
  resolveCodexResponseOutput,
  resolveUpstreamRuntime,
  sendUpstreamRequest,
  sendUpstreamPrompt,
};

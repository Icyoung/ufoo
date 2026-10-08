"use strict";

const os = require("os");
const { randomUUID } = require("crypto");
const { Agent: UndiciAgent } = require("undici");
const { normalizeProvider, normalizeKimiModel, resolveCompletionUrl, resolveResponsesUrl, resolveAnthropicMessagesUrl } = require("./runtimeConfig");
const { stableStringify } = require("../runtime/core/stableJson");
const { systemBlocksToAnthropicPayload } = require("./transports/systemBlocks");
const { buildResponsesPayload, isResponsesKeepalive, responseEventDelta, parseResponsesEvents, parseResponsesSsePayload } = require("./transports/responsesProtocol");

const DEFAULT_NATIVE_TIMEOUT_MS = 43200000;
const DEFAULT_OPENAI_MAX_TOKENS = 32768;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 32768;
const NATIVE_SSE_DISPATCHER_OPTIONS = Object.freeze({ headersTimeout: 0, bodyTimeout: 0 });
const ANTHROPIC_CACHE_CONTROL = Object.freeze({ type: "ephemeral" });

function nowMs() {
  return Date.now();
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NATIVE_TIMEOUT_MS;
  return Math.max(1000, Math.floor(parsed));
}

let nativeSseDispatcher = null;

function createNativeSseDispatcher() {
  return new UndiciAgent({ ...NATIVE_SSE_DISPATCHER_OPTIONS });
}

function getNativeSseDispatcher() {
  if (!nativeSseDispatcher || nativeSseDispatcher.destroyed) {
    nativeSseDispatcher = createNativeSseDispatcher();
  }
  return nativeSseDispatcher;
}

function enrichProviderTransportError(err) {
  if (!err || typeof err !== "object") return err;

  const cause = err.cause && typeof err.cause === "object" ? err.cause : null;
  const code = String((cause && cause.code) || err.code || "").trim();
  const causeMessage = String((cause && cause.message) || "").trim();
  if (!code && !causeMessage) return err;

  const message = String(err.message || "provider transport failed").trim();
  const details = [code, causeMessage]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(": ");
  if (!details || message.includes(details)) return err;

  const enriched = new Error(`${message} (${details})`);
  enriched.code = code || err.code;
  enriched.cause = err;
  return enriched;
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function resolveMaxTokens(fallback) {
  return normalizePositiveInt(process.env.UFOO_UCODE_MAX_TOKENS, fallback);
}

function resolveThinkingBudgetTokens(options = {}) {
  const { resolveThinkingFromEnvAndConfig } = require("./thinkingLevels");
  const { loadGlobalUcodeConfig } = require("../../config");
  let configLevel = String(options.configLevel || "").trim();
  if (!configLevel) {
    try {
      configLevel = String((loadGlobalUcodeConfig() || {}).ucodeThinking || "").trim();
    } catch {
      configLevel = "";
    }
  }
  const resolved = resolveThinkingFromEnvAndConfig({
    env: options.env || process.env,
    configLevel,
  });
  return resolved.budgetTokens;
}

function resolveReasoningEffort(options = {}) {
  const { resolveThinkingFromEnvAndConfig } = require("./thinkingLevels");
  const { loadGlobalUcodeConfig } = require("../../config");
  let configLevel = String(options.configLevel || "").trim();
  if (!configLevel) {
    try {
      configLevel = String((loadGlobalUcodeConfig() || {}).ucodeThinking || "").trim();
    } catch {
      configLevel = "";
    }
  }
  const resolved = resolveThinkingFromEnvAndConfig({
    env: options.env || process.env,
    configLevel,
  });
  return resolved.reasoningEffort || "";
}

function toUsageInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function createUsageTotals() {
  return {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    lastContextTokens: 0,
  };
}

function addUsageTotals(totals, usage = null) {
  if (!usage || typeof usage !== "object") return totals;
  totals.input += toUsageInt(usage.input);
  totals.output += toUsageInt(usage.output);
  totals.cacheRead += toUsageInt(usage.cacheRead);
  totals.cacheCreation += toUsageInt(usage.cacheCreation);
  return totals;
}

// OpenAI-compatible streams end with one usage chunk carrying whole-turn
// totals (prompt_tokens_details.cached_tokens counts the cache hits).
function readOpenAiUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === "object"
    ? raw.prompt_tokens_details
    : {};
  return {
    input: toUsageInt(raw.prompt_tokens),
    output: toUsageInt(raw.completion_tokens),
    cacheRead: toUsageInt(details.cached_tokens),
    cacheCreation: toUsageInt(details.created_cache_tokens),
    inputIncludesCache: true,
  };
}

// Anthropic reports input/cache tokens once on message_start; output tokens
// arrive per message_delta. The non-streaming body carries the full totals.
function readAnthropicUsage(raw, { includeOutput = false } = {}) {
  if (!raw || typeof raw !== "object") return null;
  return {
    input: toUsageInt(raw.input_tokens),
    output: includeOutput ? toUsageInt(raw.output_tokens) : 0,
    cacheRead: toUsageInt(raw.cache_read_input_tokens),
    cacheCreation: toUsageInt(raw.cache_creation_input_tokens),
    inputIncludesCache: false,
  };
}

function clipText(value = "", maxChars = 6000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function createRequestController({ signal = null, timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, normalizeTimeoutMs(timeoutMs));

  let abortHandler = null;
  if (signal && typeof signal === "object") {
    abortHandler = () => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    };
    if (signal.aborted) {
      abortHandler();
    } else if (typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      if (signal && abortHandler && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortHandler);
      }
    },
  };
}

function parseJsonSafe(value = "", fallback = null) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return fallback;
  }
}

function cloneMessageList(value = []) {
  const parsed = parseJsonSafe(toJsonString(value), []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
}

function toJsonString(value) {
  return stableStringify(value);
}

function parseSseBlocks(text = "") {
  const source = String(text || "");
  const blocks = source.split(/\r?\n\r?\n/);
  if (blocks.length <= 1) {
    return { blocks: [], rest: source };
  }
  const rest = blocks.pop() || "";
  return { blocks, rest };
}

function parseSseEventBlock(block = "") {
  const lines = String(block || "").split(/\r?\n/);
  let event = "message";
  const data = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() || "message";
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    data: data.join("\n"),
  };
}

function parseSseDataBlock(block = "") {
  return parseSseEventBlock(block).data;
}

function normalizeToolCallArgs(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return {};
  const parsed = parseJsonSafe(text, null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}

function emitPhase(callback, event = {}) {
  if (typeof callback !== "function") return;
  try {
    callback(event);
  } catch {
    // ignore phase callback failures
  }
}

// Shared SSE transport skeleton: POST the payload, then read the stream as
// SSE blocks, dispatch each non-[DONE] block to onEvent, and stop after the
// batch that carried [DONE]. Timeout/cancel translation and request cleanup
// live here so each protocol turn only declares its event handling.
async function runSseRequest({
  url = "",
  headers = {},
  payload = {},
  signal = null,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
  onPhase = null,
  onNonStream,
  onEvent,
  onTail = null,
  buildResult,
} = {}) {
  const request = createRequestController({ signal, timeoutMs });

  emitPhase(onPhase, { type: "request_start" });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: request.signal,
      dispatcher: getNativeSseDispatcher(),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`provider request failed (${response.status}): ${clipText(body, 500)}`);
    }

    const contentType = String(response.headers && typeof response.headers.get === "function"
      ? response.headers.get("content-type") || "" : "");
    if (/application\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType)
      || !response.body || typeof response.body.getReader !== "function") {
      const data = await response.json();
      return onNonStream(data);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rawBuffer = "";
    let sawDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(rawBuffer);
      rawBuffer = parsed.rest;

      for (const block of parsed.blocks) {
        const { event, data } = parseSseEventBlock(block);
        if (!data) continue;
        if (data === "[DONE]") {
          // Stop reading after this batch instead of waiting for the server
          // to close the connection, but keep the buffered tail and finish
          // the blocks already parsed alongside [DONE] instead of silently
          // dropping them.
          sawDone = true;
          continue;
        }

        onEvent({ event, data });
      }

      if (sawDone) break;
    }

    if (typeof onTail === "function") {
      onTail(rawBuffer);
    }

    return buildResult();
  } catch (err) {
    if (request.timedOut()) {
      const timeoutError = new Error(`CLI timeout (${normalizeTimeoutMs(timeoutMs)}ms)`);
      timeoutError.code = "timeout";
      throw timeoutError;
    }
    if (signal && typeof signal === "object" && signal.aborted) {
      const cancelError = new Error("CLI cancelled");
      cancelError.code = "cancelled";
      throw cancelError;
    }
    throw enrichProviderTransportError(err);
  } finally {
    request.cleanup();
  }
}

async function runOpenAiLikeTurn({
  url = "",
  apiKey = "",
  requestHeaders = {},
  model = "",
  provider = "",
  messages = [],
  tools = [],
  onTextDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  signal = null,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const payload = {
    model: normalizedProvider === "kimi" ? normalizeKimiModel(model) : model,
    max_tokens: resolveMaxTokens(DEFAULT_OPENAI_MAX_TOKENS),
    messages,
    tools,
    tool_choice: "auto",
    stream: true,
    // Ask for the terminal usage chunk so token/cache accounting works.
    stream_options: { include_usage: true },
    // Kimi k3 rejects any temperature other than 1.
    temperature: normalizedProvider === "kimi" ? 1 : 0,
  };
  const reasoningEffort = resolveReasoningEffort();
  if (reasoningEffort) {
    // OpenAI-compatible gateways that support reasoning models accept this;
    // unknown fields are typically ignored by plain chat models.
    payload.reasoning_effort = reasoningEffort;
  }

  const headers = normalizedProvider === "kimi"
    ? buildKimiHeaders({ apiKey, stream: true })
    : { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  Object.assign(headers, requestHeaders);

  const toolCallMap = new Map();
  const announcedToolNames = new Set();
  let responseText = "";
  let nextSyntheticIndex = 0;
  let lastSyntheticIndex = -1;
  let streamUsage = null;

  return runSseRequest({
    url,
    headers,
    payload,
    signal,
    timeoutMs,
    onPhase,
    onNonStream: (data) => {
      const message = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message
        : {};
      const text = typeof message.content === "string" ? message.content : "";
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (text && typeof onTextDelta === "function") {
        onTextDelta(text);
      }
      return {
        text,
        toolCalls,
        usage: readOpenAiUsage(data && data.usage),
      };
    },
    onEvent: ({ data }) => {
      const chunk = parseJsonSafe(data, null);
      if (!chunk || typeof chunk !== "object") return;

      // The usage chunk carries empty choices, so read it before the
      // choice guard below; latest wins (it reports whole-turn totals).
      const chunkUsage = readOpenAiUsage(chunk.usage);
      if (chunkUsage) streamUsage = chunkUsage;

      const choice = chunk.choices && chunk.choices[0] ? chunk.choices[0] : null;
      if (!choice || typeof choice !== "object") return;

      const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};

      const reasoningChunk = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (reasoningChunk) {
        emitPhase(onPhase, { type: "thinking_delta", text: reasoningChunk });
        if (typeof onThinkingDelta === "function") {
          onThinkingDelta(reasoningChunk);
        }
      }

      if (typeof delta.content === "string" && delta.content) {
        responseText += delta.content;
        emitPhase(onPhase, { type: "text_delta", text: delta.content });
        if (typeof onTextDelta === "function") {
          onTextDelta(delta.content);
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const callPart of delta.tool_calls) {
          let index;
          if (Number.isFinite(callPart.index)) {
            index = callPart.index;
          } else if (typeof callPart.id === "string" && callPart.id) {
            // Provider omitted index: a chunk carrying an id starts a new
            // call, so give it its own synthetic index instead of
            // collapsing every call into slot 0.
            while (toolCallMap.has(nextSyntheticIndex)) nextSyntheticIndex += 1;
            index = nextSyntheticIndex;
            nextSyntheticIndex += 1;
            lastSyntheticIndex = index;
          } else if (lastSyntheticIndex >= 0) {
            // No index and no id: continuation of the latest synthetic call.
            index = lastSyntheticIndex;
          } else {
            index = 0;
          }
          const previous = toolCallMap.get(index) || {
            id: "",
            type: "function",
            function: {
              name: "",
              arguments: "",
            },
          };

          if (typeof callPart.id === "string" && callPart.id) previous.id = callPart.id;
          if (callPart.function && typeof callPart.function === "object") {
            if (typeof callPart.function.name === "string" && callPart.function.name) {
              previous.function.name = callPart.function.name;
            }
            if (typeof callPart.function.arguments === "string" && callPart.function.arguments) {
              previous.function.arguments += callPart.function.arguments;
            }
          }

          toolCallMap.set(index, previous);

          const toolName = previous.function.name;
          const announceKey = `${index}:${toolName}`;
          if (toolName && !announcedToolNames.has(announceKey)) {
            announcedToolNames.add(announceKey);
            emitPhase(onPhase, { type: "tool_request", name: toolName });
          }
        }
      }
    },
    onTail: (rawBuffer) => {
      if (!rawBuffer.trim()) return;
      const fallbackBlock = parseSseDataBlock(rawBuffer);
      if (fallbackBlock && fallbackBlock !== "[DONE]") {
        const chunk = parseJsonSafe(fallbackBlock, null);
        const tailUsage = readOpenAiUsage(chunk && chunk.usage);
        if (tailUsage) streamUsage = tailUsage;
        const choice = chunk && chunk.choices && chunk.choices[0] ? chunk.choices[0] : null;
        if (choice && choice.delta && typeof choice.delta.content === "string" && choice.delta.content) {
          responseText += choice.delta.content;
          if (typeof onTextDelta === "function") {
            onTextDelta(choice.delta.content);
          }
        }
      }
    },
    buildResult: () => ({
      text: responseText,
      toolCalls: Array.from(toolCallMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]),
      usage: streamUsage,
    }),
  });
}

function currentGrokClientVersion() {
  return String(process.env.UFOO_GROK_CLIENT_VERSION || "0.2.120").trim() || "0.2.120";
}

function isGrokCliProxyUrl(url = "") {
  try {
    return new URL(String(url || "")).hostname.toLowerCase() === "cli-chat-proxy.grok.com";
  } catch {
    return false;
  }
}

function currentKimiClientVersion() {
  try {
    return String(process.env.UFOO_KIMI_CLIENT_VERSION || require("../../../package.json").version || "dev").trim() || "dev";
  } catch {
    return "dev";
  }
}

function buildKimiHeaders({ apiKey = "", stream = true } = {}) {
  const version = currentKimiClientVersion();
  const headers = {
    "content-type": "application/json",
    "User-Agent": `ufoo/${version}`,
    "X-Msh-Platform": "ufoo",
    "X-Msh-Version": version,
    "X-Msh-Device-Name": os.hostname(),
    "X-Msh-Device-Model": `${process.platform} ${process.arch}`,
    "X-Msh-Device-Id": String(process.env.KIMI_DEVICE_ID || "ufoo-kimi-device").trim() || "ufoo-kimi-device",
    Accept: stream ? "text/event-stream" : "application/json",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildResponsesHeaders({ provider = "", apiKey = "", sessionId = "", accountId = "", url = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const headers = {
    "content-type": "application/json",
    Accept: "text/event-stream",
    Connection: "Keep-Alive",
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  if (normalizedProvider === "codex") {
    headers["User-Agent"] = String(
      process.env.UFOO_CODEX_USER_AGENT
        || "codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)"
    );
    headers.Originator = "codex-tui";
    headers["Session-Id"] = String(sessionId || randomUUID());
    if (accountId) headers["Chatgpt-Account-Id"] = String(accountId);
  }

  if (normalizedProvider === "grok-build" || normalizedProvider === "xai") {
    const version = currentGrokClientVersion();
    if (sessionId) headers["x-grok-conv-id"] = String(sessionId);
    if (isGrokCliProxyUrl(url)) {
      headers["X-XAI-Token-Auth"] = "xai-grok-cli";
      headers["x-grok-client-version"] = version;
      headers["x-grok-client-identifier"] = "grok-shell";
      headers["x-authenticateresponse"] = "authenticate-response";
      headers["User-Agent"] = `xai-grok-workspace/${version}`;
    } else if (normalizedProvider === "grok-build") {
      // CLIProxyAPI selects the Grok Build route from this identity.
      headers["User-Agent"] = `grok-shell/${version}`;
    }
  }

  return headers;
}

async function runResponsesTurn({
  url = "",
  apiKey = "",
  requestHeaders = {},
  requestProfile = "",
  model = "",
  provider = "",
  systemPrompt = "",
  messages = [],
  tools = [],
  sessionId = "",
  accountId = "",
  onTextDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  signal = null,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
} = {}) {
  const payload = buildResponsesPayload({
    model,
    instructions: systemPrompt,
    messages,
    tools,
    maxOutputTokens: resolveMaxTokens(DEFAULT_OPENAI_MAX_TOKENS),
    reasoningEffort: resolveReasoningEffort(),
    provider: normalizeProvider(provider),
  });
  const headers = buildResponsesHeaders({ provider, apiKey, sessionId, accountId, url });
  Object.assign(headers, requestHeaders);
  if (requestProfile === "codex-subscription") delete payload.max_output_tokens;
  const frames = [];

  const consumeFrame = (frame = {}) => {
    const data = frame && frame.data && typeof frame.data === "object"
      ? frame.data
      : parseJsonSafe(frame && frame.data, null);
    if (!data || isResponsesKeepalive(frame && frame.event, data)) return;
    frames.push({ event: String(frame.event || data.type || ""), data });

    const delta = responseEventDelta({ event: data.type || frame.event, data });
    if (delta.reasoning) {
      emitPhase(onPhase, { type: "thinking_delta", text: delta.reasoning });
      if (typeof onThinkingDelta === "function") onThinkingDelta(delta.reasoning);
    }
    if (delta.text) {
      emitPhase(onPhase, { type: "text_delta", text: delta.text });
      if (typeof onTextDelta === "function") onTextDelta(delta.text);
    }

    const item = data.item && typeof data.item === "object" ? data.item : null;
    if (
      item
      && item.type === "function_call"
      && item.name
      && (data.type === "response.output_item.added" || data.type === "response.output_item.done")
    ) {
      emitPhase(onPhase, { type: "tool_request", name: String(item.name) });
    }
  };

  return runSseRequest({
    url,
    headers,
    payload,
    signal,
    timeoutMs,
    onPhase,
    onNonStream: (data) => {
      const parsed = parseResponsesEvents([{ event: data && data.type ? data.type : "response", data }], {
        assumeCompleted: true,
      });
      if (parsed.reasoning && typeof onThinkingDelta === "function") onThinkingDelta(parsed.reasoning);
      if (parsed.text && typeof onTextDelta === "function") onTextDelta(parsed.text);
      return {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        outputItems: parsed.outputItems,
        usage: parsed.usage,
        response: parsed.response,
        responseId: parsed.responseId,
      };
    },
    onEvent: consumeFrame,
    onTail: (rawBuffer) => {
      if (!String(rawBuffer || "").trim()) return;
      const tail = parseResponsesSsePayload(rawBuffer);
      for (const data of tail.events || []) consumeFrame({ event: data.type, data });
    },
    buildResult: () => {
      const parsed = parseResponsesEvents(frames);
      if (!parsed.terminal) {
        throw new Error("Responses stream ended before response.completed or response.incomplete");
      }
      return {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        outputItems: parsed.outputItems,
        usage: parsed.usage,
        response: parsed.response,
        responseId: parsed.responseId,
        incompleteDetails: parsed.incompleteDetails,
      };
    },
  });
}

function normalizeAnthropicMessageContent(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      if (item.type === "text") {
        return {
          type: "text",
          text: String(item.text || ""),
        };
      }
      if (item.type === "thinking") {
        return {
          type: "thinking",
          thinking: String(item.thinking || ""),
          signature: String(item.signature || ""),
        };
      }
      if (item.type === "tool_use") {
        return {
          type: "tool_use",
          id: String(item.id || ""),
          name: String(item.name || ""),
          input: item.input && typeof item.input === "object" && !Array.isArray(item.input)
            ? item.input
            : {},
        };
      }
      return null;
    })
    .filter(Boolean);
}

function extractAnthropicToolCalls(content = []) {
  return normalizeAnthropicMessageContent(content)
    .filter((item) => item.type === "tool_use")
    .map((item) => ({
      id: String(item.id || `tool_${randomUUID()}`),
      name: String(item.name || ""),
      args: item.input && typeof item.input === "object" && !Array.isArray(item.input)
        ? item.input
        : {},
    }));
}

// Mark the newest message with a cache breakpoint so the append-only history
// prefix is served from the prompt cache. The payload gets a copy: stamping
// cache_control onto the shared history array would leave stale breakpoints
// behind as later turns append, eventually exceeding the 4-breakpoint limit.
function withAnthropicCacheBreakpoint(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  const copy = messages.slice();
  const lastIndex = copy.length - 1;
  const last = copy[lastIndex];
  if (!last || typeof last !== "object" || Array.isArray(last)) return copy;
  if (typeof last.content === "string") {
    if (!last.content) return copy;
    copy[lastIndex] = {
      ...last,
      content: [
        {
          type: "text",
          text: last.content,
          cache_control: { ...ANTHROPIC_CACHE_CONTROL },
        },
      ],
    };
    return copy;
  }
  if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content.slice();
    const blockIndex = blocks.length - 1;
    const block = blocks[blockIndex];
    if (block && typeof block === "object" && !Array.isArray(block)) {
      blocks[blockIndex] = {
        ...block,
        cache_control: { ...ANTHROPIC_CACHE_CONTROL },
      };
      copy[lastIndex] = {
        ...last,
        content: blocks,
      };
    }
  }
  return copy;
}

async function runAnthropicTurn({
  url = "",
  apiKey = "",
  requestHeaders = {},
  model = "",
  systemPrompt = "",
  systemBlocks = null,
  messages = [],
  tools = [],
  onTextDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  signal = null,
  timeoutMs = DEFAULT_NATIVE_TIMEOUT_MS,
} = {}) {
  const payload = {
    model,
    max_tokens: resolveMaxTokens(DEFAULT_ANTHROPIC_MAX_TOKENS),
    messages: withAnthropicCacheBreakpoint(messages),
    tools: tools.map((spec) => ({ name: spec.function.name, description: spec.function.description, input_schema: spec.function.parameters })),
    stream: true,
  };
  const thinkingBudget = Math.min(resolveThinkingBudgetTokens(), payload.max_tokens - 1);
  if (thinkingBudget >= 1024) {
    payload.thinking = { type: "enabled", budget_tokens: thinkingBudget };
  }
  if (Array.isArray(systemBlocks) && systemBlocks.length > 0) {
    payload.system = systemBlocksToAnthropicPayload(systemBlocks);
  } else {
    const systemText = String(systemPrompt || "").trim();
    if (systemText) {
      payload.system = [
        {
          type: "text",
          text: systemText,
          cache_control: { ...ANTHROPIC_CACHE_CONTROL },
        },
      ];
    }
  }

  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  Object.assign(headers, requestHeaders);

  const blockMap = new Map();
  let responseText = "";
  let nextSyntheticBlockIndex = 0;
  let lastBlockIndex = -1;
  const turnUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    inputIncludesCache: false,
  };

  return runSseRequest({
    url,
    headers,
    payload,
    signal,
    timeoutMs,
    onPhase,
    onNonStream: (data) => {
      const content = normalizeAnthropicMessageContent(data && data.content);
      const text = content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("");
      if (text && typeof onTextDelta === "function") {
        onTextDelta(text);
      }
      addUsageTotals(turnUsage, readAnthropicUsage(data && data.usage, { includeOutput: true }));
      return {
        text,
        assistantContent: content,
        toolCalls: extractAnthropicToolCalls(content),
        usage: turnUsage,
      };
    },
    onEvent: ({ event, data }) => {
      const payloadChunk = parseJsonSafe(data, null);
      if (!payloadChunk || typeof payloadChunk !== "object") return;

      if (event === "error") {
        const errMsg = payloadChunk.error && payloadChunk.error.message
          ? String(payloadChunk.error.message)
          : "anthropic stream error";
        throw new Error(errMsg);
      }

      if (event === "message_start") {
        const messageUsage = readAnthropicUsage(
          payloadChunk.message && typeof payloadChunk.message === "object"
            ? payloadChunk.message.usage
            : null
        );
        if (messageUsage) {
          turnUsage.input = messageUsage.input;
          turnUsage.cacheRead = messageUsage.cacheRead;
          turnUsage.cacheCreation = messageUsage.cacheCreation;
        }
        return;
      }

      if (event === "message_delta") {
        const deltaUsage = payloadChunk.usage && typeof payloadChunk.usage === "object"
          ? payloadChunk.usage
          : {};
        turnUsage.output += toUsageInt(deltaUsage.output_tokens);
        return;
      }

      if (event === "content_block_start") {
        let index;
        if (Number.isFinite(payloadChunk.index)) {
          index = payloadChunk.index;
        } else {
          // Provider omitted index: each start opens a new block, so give
          // it its own synthetic index instead of collapsing every block
          // into slot 0.
          while (blockMap.has(nextSyntheticBlockIndex)) nextSyntheticBlockIndex += 1;
          index = nextSyntheticBlockIndex;
          nextSyntheticBlockIndex += 1;
        }
        lastBlockIndex = index;
        const contentBlock = payloadChunk.content_block && typeof payloadChunk.content_block === "object"
          ? payloadChunk.content_block
          : {};

        if (contentBlock.type === "text") {
          blockMap.set(index, {
            order: index,
            type: "text",
            text: String(contentBlock.text || ""),
          });
        } else if (contentBlock.type === "thinking") {
          blockMap.set(index, {
            order: index,
            type: "thinking",
            text: String(contentBlock.thinking || ""),
            signature: String(contentBlock.signature || ""),
          });
        } else if (contentBlock.type === "tool_use") {
          blockMap.set(index, {
            order: index,
            type: "tool_use",
            id: String(contentBlock.id || ""),
            name: String(contentBlock.name || ""),
            input: contentBlock.input && typeof contentBlock.input === "object" && !Array.isArray(contentBlock.input)
              ? { ...contentBlock.input }
              : {},
            inputJson: "",
          });
          const toolName = String(contentBlock.name || "");
          if (toolName) {
            emitPhase(onPhase, { type: "tool_request", name: toolName });
          }
        }
        return;
      }

      if (event === "content_block_delta") {
        let index;
        if (Number.isFinite(payloadChunk.index)) {
          index = payloadChunk.index;
        } else if (lastBlockIndex >= 0) {
          // No index: continuation of the most recently started block.
          index = lastBlockIndex;
        } else {
          index = 0;
        }
        const delta = payloadChunk.delta && typeof payloadChunk.delta === "object"
          ? payloadChunk.delta
          : {};
        const current = blockMap.get(index) || { order: index, type: "text", text: "" };

        if (delta.type === "text_delta") {
          const deltaText = String(delta.text || "");
          current.type = "text";
          current.text = `${String(current.text || "")}${deltaText}`;
          blockMap.set(index, current);
          if (deltaText) {
            responseText += deltaText;
            emitPhase(onPhase, { type: "text_delta", text: deltaText });
            if (typeof onTextDelta === "function") {
              onTextDelta(deltaText);
            }
          }
          return;
        }

        if (delta.type === "thinking_delta") {
          const deltaText = String(delta.thinking || "");
          current.type = "thinking";
          current.text = `${String(current.text || "")}${deltaText}`;
          blockMap.set(index, current);
          if (deltaText) {
            emitPhase(onPhase, { type: "thinking_delta", text: deltaText });
            if (typeof onThinkingDelta === "function") {
              onThinkingDelta(deltaText);
            }
          }
          return;
        }

        if (delta.type === "signature_delta") {
          // Signed thinking blocks must be replayed verbatim on later turns
          // (tool-use continuation contract), so accumulate the signature
          // alongside the thinking text.
          current.type = "thinking";
          current.signature = `${String(current.signature || "")}${String(delta.signature || "")}`;
          blockMap.set(index, current);
          return;
        }

        if (delta.type === "input_json_delta") {
          current.type = "tool_use";
          current.inputJson = `${String(current.inputJson || "")}${String(delta.partial_json || "")}`;
          blockMap.set(index, current);
          return;
        }
      }
    },
    buildResult: () => {
      const assistantContent = Array.from(blockMap.values())
        .sort((a, b) => a.order - b.order)
        .map((item) => {
          if (item.type === "thinking") {
            // Kept (with signature) so tool-use continuation turns can
            // replay the thinking blocks the API requires.
            return {
              type: "thinking",
              thinking: String(item.text || ""),
              signature: String(item.signature || ""),
            };
          }

          if (item.type === "text") {
            return {
              type: "text",
              text: String(item.text || ""),
            };
          }

          const inputFromDelta = normalizeToolCallArgs(item.inputJson || "");
          const mergedInput = {
            ...(item.input && typeof item.input === "object" ? item.input : {}),
            ...(inputFromDelta && typeof inputFromDelta === "object" ? inputFromDelta : {}),
          };
          return {
            type: "tool_use",
            id: String(item.id || `tool_${randomUUID()}`),
            name: String(item.name || ""),
            input: mergedInput,
          };
        });

      if (!responseText) {
        responseText = assistantContent
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
      }

      return {
        text: responseText,
        assistantContent,
        toolCalls: extractAnthropicToolCalls(assistantContent),
        usage: turnUsage,
      };
    },
  });
}

const {
  createOpenAiChatTransport,
  createOpenAiResponsesTransport,
  createAnthropicMessagesTransport,
} = require("./transports");

// Transport descriptors: wire-format only. Plan Mode / leases / policy live in the loop.
const TRANSPORTS = {
  "openai-chat": createOpenAiChatTransport({
    resolveUrl: resolveCompletionUrl,
    runTurn: runOpenAiLikeTurn,
    normalizeToolName: (name) => String(name || "").trim().toLowerCase(),
    normalizeToolCallArgs,
    toJsonString,
    clipText,
  }),
  "openai-responses": createOpenAiResponsesTransport({
    resolveUrl: resolveResponsesUrl,
    runTurn: runResponsesTurn,
    normalizeToolName: (name) => String(name || "").trim().toLowerCase(),
    normalizeToolCallArgs,
    toJsonString,
    clipText,
  }),
  "anthropic-messages": createAnthropicMessagesTransport({
    resolveUrl: resolveAnthropicMessagesUrl,
    runTurn: runAnthropicTurn,
    toJsonString,
    clipText,
  }),
};

module.exports = {
  getNativeTransport: (name) => TRANSPORTS[name] || TRANSPORTS["openai-chat"],
  createNativeSseDispatcher, resolveThinkingBudgetTokens, resolveReasoningEffort,
  normalizeTimeoutMs, createUsageTotals, cloneMessageList,
};

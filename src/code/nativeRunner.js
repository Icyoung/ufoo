const { randomUUID } = require("crypto");
const { loadConfig, defaultAgentModelForProvider, sameModelProvider } = require("../config");
const { runToolCall } = require("./dispatch");
const { getReadToolDescription } = require("../agents/prompts/native/toolDescriptions/read");
const { getWriteToolDescription } = require("../agents/prompts/native/toolDescriptions/write");
const { getEditToolDescription } = require("../agents/prompts/native/toolDescriptions/edit");
const { getBashToolDescription } = require("../agents/prompts/native/toolDescriptions/bash");

const CORE_TOOL_NAMES = new Set(["read", "write", "edit", "bash"]);
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
// Claude Code SDK defaults to no turn limit; built-in agents cap at 30 (DreamTask)
// to 200 (fork). We count individual tool calls (not turns), so 100 leaves headroom
// for non-trivial tasks while still catching runaway loops. Override via env.
const DEFAULT_MAX_NATIVE_TOOL_CALLS = 100;
const DEFAULT_MAX_NATIVE_TOOL_ERRORS = 5;
// Anthropic Messages rejects max_tokens above the model's real cap (64K on
// current models), so the transports use different defaults. Override either
// via UFOO_UCODE_MAX_TOKENS (positive integer).
const DEFAULT_OPENAI_MAX_TOKENS = 131072;
const DEFAULT_ANTHROPIC_MAX_TOKENS = 64000;

function nowMs() {
  return Date.now();
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 300000;
  return Math.max(1000, Math.floor(parsed));
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function resolveNativeToolBudget(env = process.env) {
  return {
    maxToolCalls: normalizePositiveInt(env.UFOO_UCODE_MAX_TOOL_CALLS, DEFAULT_MAX_NATIVE_TOOL_CALLS),
    maxToolErrors: normalizePositiveInt(env.UFOO_UCODE_MAX_TOOL_ERRORS, DEFAULT_MAX_NATIVE_TOOL_ERRORS),
  };
}

function resolveMaxTokens(fallback) {
  return normalizePositiveInt(process.env.UFOO_UCODE_MAX_TOKENS, fallback);
}

function enforceNativeToolBudget({
  toolCallsExecuted = 0,
  toolErrors = 0,
  maxToolCalls = DEFAULT_MAX_NATIVE_TOOL_CALLS,
  maxToolErrors = DEFAULT_MAX_NATIVE_TOOL_ERRORS,
  lastTool = "",
  lastError = "",
} = {}) {
  if (toolCallsExecuted >= maxToolCalls) {
    throw new Error(`tool call budget exceeded (${maxToolCalls})`);
  }
  if (toolErrors >= maxToolErrors) {
    const detail = [lastTool, lastError].filter(Boolean).join(": ");
    throw new Error(`tool error budget exceeded (${maxToolErrors})${detail ? `: ${detail}` : ""}`);
  }
}

function createGuards({ signal = null, timeoutMs = 300000 } = {}) {
  const startedAt = nowMs();
  const budgetMs = normalizeTimeoutMs(timeoutMs);

  function ensureActive() {
    if (signal && typeof signal === "object" && signal.aborted) {
      const err = new Error("CLI cancelled");
      err.code = "cancelled";
      throw err;
    }
    if (nowMs() - startedAt > budgetMs) {
      const err = new Error(`CLI timeout (${budgetMs}ms)`);
      err.code = "timeout";
      throw err;
    }
  }

  return {
    ensureActive,
    budgetMs,
  };
}

function emitToolEvent(callback, event = {}) {
  if (typeof callback !== "function") return;
  try {
    callback(event);
  } catch {
    // ignore callback failures
  }
}

function clipText(value = "", maxChars = 6000) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "codex" || text === "codex-cli" || text === "codex-code") return "openai";
  if (text === "claude" || text === "claude-cli" || text === "claude-code") return "anthropic";
  if (text === "openai" || text === "anthropic") return text;
  return text;
}

function resolveTransport({ provider = "", baseUrl = "" } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const url = String(baseUrl || "").trim().toLowerCase();

  if (normalizedProvider === "anthropic") return "anthropic-messages";
  if (url.includes("anthropic.com")) return "anthropic-messages";
  if (/\/messages(?:$|[/?#])/.test(url) && !/\/chat\/completions(?:$|[/?#])/.test(url)) {
    return "anthropic-messages";
  }

  return "openai-chat";
}

function resolveRuntimeConfig({ workspaceRoot = process.cwd(), provider = "", model = "" } = {}) {
  const config = loadConfig(workspaceRoot);
  const configuredProvider = normalizeProvider(config.ucodeProvider || config.agentProvider || "");
  const selectedProvider = normalizeProvider(
    provider
      || process.env.UFOO_UCODE_PROVIDER
      || configuredProvider
      || "openai"
  ) || "openai";
  const configuredModel = sameModelProvider(config.ucodeProvider || config.agentProvider, selectedProvider)
    ? (config.ucodeModel || config.agentModel)
    : "";

  const selectedModel = String(
    model
      || process.env.UFOO_UCODE_MODEL
      || configuredModel
      || defaultAgentModelForProvider(selectedProvider)
  ).trim();

  const defaultBaseUrl = selectedProvider === "anthropic"
    ? String(process.env.ANTHROPIC_BASE_URL || DEFAULT_ANTHROPIC_BASE_URL)
    : String(process.env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL);

  const baseUrl = String(
    process.env.UFOO_UCODE_BASE_URL
      || config.ucodeBaseUrl
      || defaultBaseUrl
  ).trim();

  const apiKey = String(
    process.env.UFOO_UCODE_API_KEY
      || config.ucodeApiKey
      || (selectedProvider === "openai" ? process.env.OPENAI_API_KEY : "")
      || (selectedProvider === "anthropic" ? process.env.ANTHROPIC_API_KEY : "")
      || ""
  ).trim();

  return {
    provider: selectedProvider,
    model: selectedModel,
    baseUrl,
    apiKey,
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

function resolveAnthropicMessagesUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim() || DEFAULT_ANTHROPIC_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (/\/messages$/i.test(normalized)) return normalized;
  if (/\/v1$/i.test(normalized)) return `${normalized}/messages`;
  if (/\/api$/i.test(normalized)) return `${normalized}/v1/messages`;
  return `${normalized}/messages`;
}

function buildCoreToolSpecs() {
  return [
    {
      type: "function",
      function: {
        name: "read",
        description: getReadToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            startLine: { type: "integer" },
            endLine: { type: "integer" },
            maxBytes: { type: "integer" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write",
        description: getWriteToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            mode: {
              type: "string",
              enum: ["overwrite", "append"],
              description: 'Write mode: "overwrite" replaces the file (default), "append" adds to its end.',
            },
            append: { type: "boolean" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit",
        description: getEditToolDescription(),
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            find: { type: "string" },
            replace: { type: "string" },
            all: { type: "boolean" },
          },
          required: ["path", "find", "replace"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: getBashToolDescription(),
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeoutMs: { type: "integer" },
          },
          required: ["command"],
        },
      },
    },
  ];
}

function buildAnthropicToolSpecs() {
  return buildCoreToolSpecs().map((spec) => ({
    name: spec.function.name,
    description: spec.function.description,
    input_schema: spec.function.parameters,
  }));
}

function createRequestController({ signal = null, timeoutMs = 300000 } = {}) {
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

function normalizeToolName(value = "") {
  const name = String(value || "").trim().toLowerCase();
  if (!CORE_TOOL_NAMES.has(name)) return "";
  return name;
}

function toJsonString(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || "");
  }
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

function runCoreTool({ tool = "", args = {}, workspaceRoot = process.cwd(), onToolEvent = null } = {}) {
  const normalizedTool = normalizeToolName(tool);
  if (!normalizedTool) {
    emitToolEvent(onToolEvent, {
      tool: String(tool || "unknown"),
      phase: "error",
      args: args && typeof args === "object" ? { ...args } : {},
      error: `unsupported tool: ${tool}`,
    });
    return {
      ok: false,
      error: `unsupported tool: ${tool}`,
    };
  }

  const safeArgs = args && typeof args === "object" ? { ...args } : {};
  emitToolEvent(onToolEvent, {
    tool: normalizedTool,
    phase: "start",
    args: safeArgs,
    error: "",
  });

  const result = runToolCall(
    { tool: normalizedTool, args: safeArgs },
    { workspaceRoot, cwd: workspaceRoot }
  );

  if (!result || result.ok === false) {
    emitToolEvent(onToolEvent, {
      tool: normalizedTool,
      phase: "error",
      args: safeArgs,
      error: String((result && result.error) || `${normalizedTool} failed`),
    });
  }

  return result;
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
  timeoutMs = 300000,
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
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`provider request failed (${response.status}): ${clipText(body, 500)}`);
    }

    if (!response.body || typeof response.body.getReader !== "function") {
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
    throw err;
  } finally {
    request.cleanup();
  }
}

async function runOpenAiLikeTurn({
  url = "",
  apiKey = "",
  model = "",
  messages = [],
  onTextDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  signal = null,
  timeoutMs = 300000,
} = {}) {
  const payload = {
    model,
    max_tokens: resolveMaxTokens(DEFAULT_OPENAI_MAX_TOKENS),
    messages,
    tools: buildCoreToolSpecs(),
    tool_choice: "auto",
    stream: true,
    temperature: 0,
  };

  const headers = {
    "content-type": "application/json",
  };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const toolCallMap = new Map();
  const announcedToolNames = new Set();
  let responseText = "";
  let nextSyntheticIndex = 0;
  let lastSyntheticIndex = -1;

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
      };
    },
    onEvent: ({ data }) => {
      const chunk = parseJsonSafe(data, null);
      if (!chunk || typeof chunk !== "object") return;

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
    }),
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

async function runAnthropicTurn({
  url = "",
  apiKey = "",
  model = "",
  systemPrompt = "",
  messages = [],
  onTextDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  signal = null,
  timeoutMs = 300000,
} = {}) {
  const payload = {
    model,
    max_tokens: resolveMaxTokens(DEFAULT_ANTHROPIC_MAX_TOKENS),
    messages,
    tools: buildAnthropicToolSpecs(),
    stream: true,
  };
  const systemText = String(systemPrompt || "").trim();
  if (systemText) {
    payload.system = systemText;
  }

  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }

  const blockMap = new Map();
  let responseText = "";
  let nextSyntheticBlockIndex = 0;
  let lastBlockIndex = -1;

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
      return {
        text,
        assistantContent: content,
        toolCalls: extractAnthropicToolCalls(content),
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
        .filter((item) => item.type !== "thinking")
        .map((item) => {
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
      };
    },
  });
}

// Transport descriptors: everything the shared native loop needs that differs
// between the OpenAI chat-completions and Anthropic messages protocols —
// request URL resolution, initial message shaping, turn execution, and
// assistant/tool-result message formatting.
const TRANSPORTS = {
  "openai-chat": {
    resolveUrl: resolveCompletionUrl,
    prepareMessages({ messages, systemPrompt, prompt }) {
      const systemText = String(systemPrompt || "").trim();
      const hasSystem = messages.some((entry) => String(entry.role || "").trim() === "system");
      if (systemText && !hasSystem) {
        messages.unshift({ role: "system", content: systemText });
      }
      messages.push({ role: "user", content: String(prompt || "") });
    },
    runTurn: runOpenAiLikeTurn,
    getToolCalls(turnResult) {
      return Array.isArray(turnResult.toolCalls)
        ? turnResult.toolCalls.filter((call) => call && call.function && typeof call.function === "object")
        : [];
    },
    appendFinalAssistantMessage({ messages, turnResult }) {
      const text = String(turnResult.text || "").trim();
      if (text) {
        messages.push({
          role: "assistant",
          content: text,
        });
      }
    },
    prepareToolCalls({ messages, toolCalls }) {
      const assistantToolCalls = [];
      for (const call of toolCalls) {
        const callId = String(call.id || `call_${randomUUID()}`);
        const name = normalizeToolName(call.function.name || "");
        const args = normalizeToolCallArgs(call.function.arguments || "");

        assistantToolCalls.push({
          id: callId,
          type: "function",
          function: {
            name: name || String(call.function.name || ""),
            arguments: toJsonString(args),
          },
        });
      }

      if (assistantToolCalls.length === 0) return null;

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: assistantToolCalls,
      });

      return assistantToolCalls.map((toolCall) => ({
        name: toolCall.function.name,
        args: normalizeToolCallArgs(toolCall.function.arguments),
        source: toolCall,
      }));
    },
    appendToolResult({ messages, call, toolResult }) {
      messages.push({
        role: "tool",
        tool_call_id: call.source.id,
        content: clipText(toJsonString(toolResult), 12000),
      });
    },
  },
  "anthropic-messages": {
    resolveUrl: resolveAnthropicMessagesUrl,
    prepareMessages({ messages, prompt }) {
      messages.push({
        role: "user",
        content: String(prompt || ""),
      });
    },
    runTurn: runAnthropicTurn,
    getToolCalls(turnResult) {
      return Array.isArray(turnResult.toolCalls) ? turnResult.toolCalls : [];
    },
    appendFinalAssistantMessage({ messages, turnResult }) {
      const assistantContent = Array.isArray(turnResult.assistantContent)
        ? turnResult.assistantContent
        : [];
      if (assistantContent.length > 0) {
        messages.push({
          role: "assistant",
          content: assistantContent,
        });
      } else if (String(turnResult.text || "").trim()) {
        messages.push({
          role: "assistant",
          content: [
            {
              type: "text",
              text: String(turnResult.text || ""),
            },
          ],
        });
      }
    },
    prepareToolCalls({ messages, turnResult, toolCalls }) {
      const assistantContent = Array.isArray(turnResult.assistantContent)
        ? turnResult.assistantContent
        : [];

      messages.push({
        role: "assistant",
        content: assistantContent,
      });

      return toolCalls.map((call) => ({
        name: call.name,
        args: call.args,
        source: call,
      }));
    },
    appendToolResult({ collected, call, toolResult }) {
      collected.push({
        type: "tool_result",
        tool_use_id: String(call.source.id || ""),
        content: clipText(toJsonString(toolResult), 12000),
        is_error: Boolean(!toolResult || toolResult.ok === false),
      });
    },
    flushToolResults({ messages, collected }) {
      messages.push({
        role: "user",
        content: collected,
      });
    },
  },
};

async function runNativeLoop({
  transport,
  workspaceRoot = process.cwd(),
  prompt = "",
  systemPrompt = "",
  historyMessages = [],
  model = "",
  baseUrl = "",
  apiKey = "",
  timeoutMs = 300000,
  onStreamDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  onToolEvent = null,
  signal = null,
  guards,
} = {}) {
  const requestModel = String(model || "").trim();
  if (!requestModel) {
    throw new Error("ucode model is not configured");
  }

  const requestUrl = transport.resolveUrl(baseUrl);
  if (!requestUrl) {
    throw new Error("ucode baseUrl is not configured");
  }

  const messages = cloneMessageList(historyMessages);
  transport.prepareMessages({ messages, systemPrompt, prompt });

  let aggregated = "";
  let streamed = false;
  let toolCallsExecuted = 0;
  let toolErrors = 0;
  const toolBudget = resolveNativeToolBudget();

  while (true) {
    guards.ensureActive();

    const turnResult = await transport.runTurn({
      url: requestUrl,
      apiKey,
      model: requestModel,
      systemPrompt,
      messages,
      signal,
      timeoutMs,
      onPhase,
      onThinkingDelta,
      onTextDelta: (chunk) => {
        const text = String(chunk || "");
        if (!text) return;
        aggregated += text;
        if (typeof onStreamDelta === "function") {
          streamed = true;
          onStreamDelta(text);
        }
      },
    });

    const toolCalls = transport.getToolCalls(turnResult);

    if (toolCalls.length === 0) {
      transport.appendFinalAssistantMessage({ messages, turnResult });
      const text = String(turnResult.text || "").trim();
      if (!aggregated.trim() && text) {
        aggregated = text;
      }
      return {
        text: aggregated,
        streamed,
        toolCallsExecuted,
        messages,
      };
    }

    const pendingCalls = transport.prepareToolCalls({ messages, turnResult, toolCalls });
    if (!pendingCalls) {
      return {
        text: aggregated,
        streamed,
        toolCallsExecuted,
        messages,
      };
    }

    const collectedResults = [];
    for (const pending of pendingCalls) {
      const toolResult = runCoreTool({
        tool: pending.name,
        args: pending.args,
        workspaceRoot,
        onToolEvent,
      });
      toolCallsExecuted += 1;
      if (!toolResult || toolResult.ok === false) {
        toolErrors += 1;
      }
      enforceNativeToolBudget({
        toolCallsExecuted,
        toolErrors,
        maxToolCalls: toolBudget.maxToolCalls,
        maxToolErrors: toolBudget.maxToolErrors,
        lastTool: pending.name,
        lastError: toolResult && toolResult.error ? String(toolResult.error) : "",
      });
      transport.appendToolResult({
        messages,
        collected: collectedResults,
        call: pending,
        toolResult,
      });
    }

    if (typeof transport.flushToolResults === "function") {
      transport.flushToolResults({ messages, collected: collectedResults });
    }
  }
}

async function runNativeAgentTask({
  workspaceRoot = process.cwd(),
  prompt = "",
  systemPrompt = "",
  provider = "",
  model = "",
  messages = [],
  sessionId = "",
  timeoutMs = 300000,
  onStreamDelta = null,
  onThinkingDelta = null,
  onPhase = null,
  onToolEvent = null,
  signal = null,
} = {}) {
  const guards = createGuards({ signal, timeoutMs });
  const nextSessionId = String(sessionId || "").trim() || `native-${randomUUID()}`;
  const promptText = String(prompt || "").trim();
  // Track every text delta so the error path can return the partial output
  // the model already produced instead of discarding it.
  let partialOutput = "";
  const trackingStreamDelta = (chunk) => {
    const text = String(chunk || "");
    if (!text) return;
    partialOutput += text;
    if (typeof onStreamDelta === "function") {
      onStreamDelta(chunk);
    }
  };

  try {
    guards.ensureActive();

    if (!promptText) {
      return {
        ok: false,
        error: "empty task",
        output: "",
        sessionId: nextSessionId,
        streamed: false,
      };
    }

    const runtime = resolveRuntimeConfig({
      workspaceRoot,
      provider,
      model,
    });

    const transport = TRANSPORTS[runtime.transport] || TRANSPORTS["openai-chat"];

    const runResult = await runNativeLoop({
      transport,
      workspaceRoot,
      prompt: promptText,
      systemPrompt,
      historyMessages: messages,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      timeoutMs,
      onStreamDelta: trackingStreamDelta,
      onThinkingDelta,
      onPhase,
      onToolEvent,
      signal,
      guards,
    });

    const outputText = String(runResult.text || "").trim() || (
      runResult.toolCallsExecuted > 0
        ? `Completed ${runResult.toolCallsExecuted} tool call${runResult.toolCallsExecuted === 1 ? "" : "s"}.`
        : ""
    );

    return {
      ok: true,
      error: "",
      output: outputText,
      messages: cloneMessageList(runResult.messages),
      sessionId: nextSessionId,
      // The loop marks streamed=true whenever it receives a stream callback;
      // only report it when the caller actually registered one.
      streamed: Boolean(runResult.streamed) && typeof onStreamDelta === "function",
    };
  } catch (err) {
    const message = err && err.message ? err.message : "native runner failed";
    return {
      ok: false,
      error: message,
      output: partialOutput.trim(),
      sessionId: nextSessionId,
      streamed: false,
    };
  }
}

module.exports = {
  runNativeAgentTask,
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveAnthropicMessagesUrl,
  resolveTransport,
};

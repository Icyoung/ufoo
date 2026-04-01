const { randomUUID } = require("crypto");
const { loadConfig } = require("../config");
const { runToolCall } = require("./dispatch");
const { getReadToolDescription } = require("./prompts/toolDescriptions/read");
const { getWriteToolDescription } = require("./prompts/toolDescriptions/write");
const { getEditToolDescription } = require("./prompts/toolDescriptions/edit");
const { getBashToolDescription } = require("./prompts/toolDescriptions/bash");

const CORE_TOOL_NAMES = new Set(["read", "write", "edit", "bash"]);
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";

function nowMs() {
  return Date.now();
}

function normalizeTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 300000;
  return Math.max(1000, Math.floor(parsed));
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

function summarizeFileSnippet(file = "", content = "") {
  const target = String(file || "").trim();
  const body = String(content || "").trim();
  if (!body) return `${target}: empty`;

  if (target.toLowerCase().endsWith("package.json")) {
    try {
      const parsed = JSON.parse(body);
      const name = String(parsed.name || "").trim() || "(unknown)";
      const version = String(parsed.version || "").trim() || "(unknown)";
      const scripts = parsed.scripts && typeof parsed.scripts === "object"
        ? Object.keys(parsed.scripts).slice(0, 4)
        : [];
      const scriptText = scripts.length > 0 ? ` scripts=${scripts.join(",")}` : "";
      return `${target}: name=${name} version=${version}${scriptText}`;
    } catch {
      // fall through
    }
  }

  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => (line.length > 120 ? `${line.slice(0, 120)}...` : line));

  if (lines.length === 0) return `${target}: empty`;
  return `${target}: ${lines.join(" | ")}`;
}

function extractPreflightEvidence(systemPrompt = "") {
  const source = String(systemPrompt || "");
  if (!source) return [];

  const results = [];
  const fileRegex = /File:\s*([^\n]+)\n([\s\S]*?)(?=\n---\n(?:File|Command):|$)/g;
  let match = fileRegex.exec(source);
  while (match) {
    const file = String(match[1] || "").trim();
    const content = String(match[2] || "").trim();
    if (file) {
      results.push({ kind: "file", label: file, summary: summarizeFileSnippet(file, content) });
    }
    match = fileRegex.exec(source);
  }

  const cmdRegex = /Command:\s*([^\n]+)\n([\s\S]*?)(?=\n---\n(?:File|Command):|$)/g;
  match = cmdRegex.exec(source);
  while (match) {
    const command = String(match[1] || "").trim();
    const output = String(match[2] || "").trim();
    if (command) {
      const clipped = clipText(output, 300).replace(/\s+/g, " ").trim();
      results.push({ kind: "command", label: command, summary: `${command}: ${clipped || "(no output)"}` });
    }
    match = cmdRegex.exec(source);
  }

  return results;
}

function isAnalysisPrompt(text = "") {
  return /(?:analy[sz]e|analysis|review|audit|status|architecture|codebase|repo|project|现状|架构|审查|分析|项目|代码库)/i.test(text);
}

function parseReadIntent(prompt = "") {
  const text = String(prompt || "");
  const patterns = [
    /(?:\bread\b|\bcat\b|查看|读取)\s+([A-Za-z0-9_./\\-]+(?:\.[A-Za-z0-9._-]+)?)/i,
    /([A-Za-z0-9_./\\-]+\.(?:md|txt|json|js|ts|jsx|tsx|yml|yaml|toml|sh))/i,
  ];
  for (const re of patterns) {
    const match = text.match(re);
    if (!match || !match[1]) continue;
    const candidate = String(match[1]).trim().replace(/[),.;:]+$/, "");
    if (!candidate) continue;
    if (candidate.length > 260) continue;
    return candidate;
  }
  return "";
}

function parseBashIntent(prompt = "") {
  const text = String(prompt || "").trim();
  if (!text) return "";
  if (
    /\b(ls|dir|tree)\b/i.test(text)
    || /\b(list|show)\s+(files|dirs|directories|folders)\b/i.test(text)
    || /列出|目录|文件列表/.test(text)
  ) {
    return "ls -la";
  }
  const cmdMatch = text.match(/(?:运行|执行|run|exec(?:ute)?)\s+`([^`]+)`/i);
  if (cmdMatch && cmdMatch[1]) return String(cmdMatch[1]).trim();
  return "";
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

  const selectedModel = String(
    model
      || process.env.UFOO_UCODE_MODEL
      || config.ucodeModel
      || config.agentModel
      || ""
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

async function runOpenAiLikeTurn({
  url = "",
  apiKey = "",
  model = "",
  messages = [],
  onTextDelta = null,
  signal = null,
  timeoutMs = 300000,
} = {}) {
  const payload = {
    model,
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

  const request = createRequestController({ signal, timeoutMs });

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
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCallMap = new Map();
    let rawBuffer = "";
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(rawBuffer);
      rawBuffer = parsed.rest;

      for (const block of parsed.blocks) {
        const payloadText = parseSseDataBlock(block);
        if (!payloadText) continue;
        if (payloadText === "[DONE]") {
          rawBuffer = "";
          break;
        }

        const chunk = parseJsonSafe(payloadText, null);
        if (!chunk || typeof chunk !== "object") continue;

        const choice = chunk.choices && chunk.choices[0] ? chunk.choices[0] : null;
        if (!choice || typeof choice !== "object") continue;

        const delta = choice.delta && typeof choice.delta === "object" ? choice.delta : {};

        if (typeof delta.content === "string" && delta.content) {
          responseText += delta.content;
          if (typeof onTextDelta === "function") {
            onTextDelta(delta.content);
          }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const callPart of delta.tool_calls) {
            const index = Number.isFinite(callPart.index) ? callPart.index : 0;
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
          }
        }
      }
    }

    if (rawBuffer.trim()) {
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
    }

    return {
      text: responseText,
      toolCalls: Array.from(toolCallMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]),
    };
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
  signal = null,
  timeoutMs = 300000,
} = {}) {
  const payload = {
    model,
    max_tokens: 4096,
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

  const request = createRequestController({ signal, timeoutMs });

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
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const blockMap = new Map();
    let rawBuffer = "";
    let responseText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      rawBuffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBlocks(rawBuffer);
      rawBuffer = parsed.rest;

      for (const rawBlock of parsed.blocks) {
        const { event, data } = parseSseEventBlock(rawBlock);
        if (!data || data === "[DONE]") continue;

        const payloadChunk = parseJsonSafe(data, null);
        if (!payloadChunk || typeof payloadChunk !== "object") continue;

        if (event === "error") {
          const errMsg = payloadChunk.error && payloadChunk.error.message
            ? String(payloadChunk.error.message)
            : "anthropic stream error";
          throw new Error(errMsg);
        }

        if (event === "content_block_start") {
          const index = Number.isFinite(payloadChunk.index) ? payloadChunk.index : 0;
          const contentBlock = payloadChunk.content_block && typeof payloadChunk.content_block === "object"
            ? payloadChunk.content_block
            : {};

          if (contentBlock.type === "text") {
            blockMap.set(index, {
              order: index,
              type: "text",
              text: String(contentBlock.text || ""),
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
          }
          continue;
        }

        if (event === "content_block_delta") {
          const index = Number.isFinite(payloadChunk.index) ? payloadChunk.index : 0;
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
              if (typeof onTextDelta === "function") {
                onTextDelta(deltaText);
              }
            }
            continue;
          }

          if (delta.type === "input_json_delta") {
            current.type = "tool_use";
            current.inputJson = `${String(current.inputJson || "")}${String(delta.partial_json || "")}`;
            blockMap.set(index, current);
            continue;
          }
        }
      }
    }

    const assistantContent = Array.from(blockMap.values())
      .sort((a, b) => a.order - b.order)
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

async function runNativeLoopOpenAi({
  workspaceRoot = process.cwd(),
  prompt = "",
  systemPrompt = "",
  historyMessages = [],
  model = "",
  baseUrl = "",
  apiKey = "",
  timeoutMs = 300000,
  onStreamDelta = null,
  onToolEvent = null,
  signal = null,
  guards,
} = {}) {
  const requestModel = String(model || "").trim();
  if (!requestModel) {
    throw new Error("ucode model is not configured");
  }

  const requestUrl = resolveCompletionUrl(baseUrl);
  if (!requestUrl) {
    throw new Error("ucode baseUrl is not configured");
  }

  const messages = cloneMessageList(historyMessages);
  const systemText = String(systemPrompt || "").trim();
  const hasSystem = messages.some((entry) => String(entry.role || "").trim() === "system");
  if (systemText && !hasSystem) {
    messages.unshift({ role: "system", content: systemText });
  }
  messages.push({ role: "user", content: String(prompt || "") });

  let aggregated = "";
  let streamed = false;
  let toolCallsExecuted = 0;

  while (true) {
    guards.ensureActive();

    const turnResult = await runOpenAiLikeTurn({
      url: requestUrl,
      apiKey,
      model: requestModel,
      messages,
      signal,
      timeoutMs,
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

    const toolCalls = Array.isArray(turnResult.toolCalls)
      ? turnResult.toolCalls.filter((call) => call && call.function && typeof call.function === "object")
      : [];

    if (toolCalls.length === 0) {
      const text = String(turnResult.text || "").trim();
      if (text) {
        messages.push({
          role: "assistant",
          content: text,
        });
      }
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

    if (assistantToolCalls.length === 0) {
      return {
        text: aggregated,
        streamed,
        toolCallsExecuted,
        messages,
      };
    }

    messages.push({
      role: "assistant",
      content: null,
      tool_calls: assistantToolCalls,
    });

    for (const toolCall of assistantToolCalls) {
      const toolResult = runCoreTool({
        tool: toolCall.function.name,
        args: normalizeToolCallArgs(toolCall.function.arguments),
        workspaceRoot,
        onToolEvent,
      });
      toolCallsExecuted += 1;
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: clipText(toJsonString(toolResult), 12000),
      });
    }
  }

}

async function runNativeLoopAnthropic({
  workspaceRoot = process.cwd(),
  prompt = "",
  systemPrompt = "",
  historyMessages = [],
  model = "",
  baseUrl = "",
  apiKey = "",
  timeoutMs = 300000,
  onStreamDelta = null,
  onToolEvent = null,
  signal = null,
  guards,
} = {}) {
  const requestModel = String(model || "").trim();
  if (!requestModel) {
    throw new Error("ucode model is not configured");
  }

  const requestUrl = resolveAnthropicMessagesUrl(baseUrl);
  if (!requestUrl) {
    throw new Error("ucode baseUrl is not configured");
  }

  const messages = cloneMessageList(historyMessages);
  messages.push({
    role: "user",
    content: String(prompt || ""),
  });

  let aggregated = "";
  let streamed = false;
  let toolCallsExecuted = 0;

  while (true) {
    guards.ensureActive();

    const turnResult = await runAnthropicTurn({
      url: requestUrl,
      apiKey,
      model: requestModel,
      systemPrompt,
      messages,
      signal,
      timeoutMs,
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

    const toolCalls = Array.isArray(turnResult.toolCalls) ? turnResult.toolCalls : [];

    if (toolCalls.length === 0) {
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

    const assistantContent = Array.isArray(turnResult.assistantContent)
      ? turnResult.assistantContent
      : [];

    messages.push({
      role: "assistant",
      content: assistantContent,
    });

    const toolResults = [];
    for (const call of toolCalls) {
      const toolResult = runCoreTool({
        tool: call.name,
        args: call.args,
        workspaceRoot,
        onToolEvent,
      });
      toolCallsExecuted += 1;
      toolResults.push({
        type: "tool_result",
        tool_use_id: String(call.id || ""),
        content: clipText(toJsonString(toolResult), 12000),
        is_error: Boolean(!toolResult || toolResult.ok === false),
      });
    }

    messages.push({
      role: "user",
      content: toolResults,
    });
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
  onToolEvent = null,
  signal = null,
} = {}) {
  const guards = createGuards({ signal, timeoutMs });
  const nextSessionId = String(sessionId || "").trim() || `native-${randomUUID()}`;
  const promptText = String(prompt || "").trim();

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

    const loopRunner = runtime.transport === "anthropic-messages"
      ? runNativeLoopAnthropic
      : runNativeLoopOpenAi;

    const runResult = await loopRunner({
      workspaceRoot,
      prompt: promptText,
      systemPrompt,
      historyMessages: messages,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      timeoutMs,
      onStreamDelta,
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
      streamed: Boolean(runResult.streamed),
    };
  } catch (err) {
    const message = err && err.message ? err.message : "native runner failed";
    return {
      ok: false,
      error: message,
      output: "",
      sessionId: nextSessionId,
      streamed: false,
    };
  }
}

module.exports = {
  runNativeAgentTask,
  parseReadIntent,
  parseBashIntent,
  extractPreflightEvidence,
  resolveRuntimeConfig,
  resolveCompletionUrl,
  resolveAnthropicMessagesUrl,
  resolveTransport,
};

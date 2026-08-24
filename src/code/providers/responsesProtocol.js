"use strict";

const DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS = 131072;
const RESPONSES_REASONING_ITEMS = Symbol("ufoo.responsesReasoningItems");

function cloneJsonValue(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function reasoningItemsFromResponse(response = null) {
  const output = response && typeof response === "object" && Array.isArray(response.output)
    ? response.output
    : [];
  return output
    .filter((item) => (
      item
      && typeof item === "object"
      && item.type === "reasoning"
      && typeof item.encrypted_content === "string"
      && item.encrypted_content.length > 0
    ))
    .map(cloneJsonValue)
    .filter(Boolean);
}

function attachResponsesReasoningItems(message = null, response = null) {
  if (!message || typeof message !== "object") return message;
  const items = reasoningItemsFromResponse(response);
  if (items.length === 0) return message;
  Object.defineProperty(message, RESPONSES_REASONING_ITEMS, {
    value: items,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return message;
}

function getResponsesReasoningItems(message = null) {
  const items = message && typeof message === "object"
    ? message[RESPONSES_REASONING_ITEMS]
    : null;
  return (Array.isArray(items) ? items : [])
    .map(cloneJsonValue)
    .filter(Boolean);
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

function toJsonString(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value == null ? {} : value);
  } catch {
    return "{}";
  }
}

function normalizeArguments(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeContentParts(content, role = "user") {
  const outputRole = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content ? [{ type: outputRole, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const block of content) {
    if (typeof block === "string") {
      if (block) parts.push({ type: outputRole, text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || "").trim().toLowerCase();
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = String(block.text || block.content || "");
      if (text) parts.push({ type: type === "text" ? outputRole : type, text });
      continue;
    }
    if (type === "image_url") {
      const image = block.image_url;
      const url = typeof image === "string" ? image : image && image.url;
      if (url) parts.push({ type: "input_image", image_url: String(url) });
      continue;
    }
    if (type === "image") {
      const source = block.source && typeof block.source === "object" ? block.source : block;
      if (source && source.type === "base64" && source.data) {
        const mediaType = String(source.media_type || "application/octet-stream");
        parts.push({
          type: "input_image",
          image_url: `data:${mediaType};base64,${String(source.data)}`,
        });
      } else if (block.url) {
        parts.push({ type: "input_image", image_url: String(block.url) });
      }
      continue;
    }
    if (type === "reasoning" && block.encrypted_content) {
      parts.push({ type: "reasoning", encrypted_content: String(block.encrypted_content) });
    }
  }
  return parts;
}

function messagesToResponsesInput(messages = []) {
  const input = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user").trim().toLowerCase() || "user";

    if (role === "tool") {
      const callId = String(message.tool_call_id || message.call_id || "").trim();
      if (callId) {
        input.push({
          type: "function_call_output",
          call_id: callId,
          output: typeof message.content === "string" ? message.content : toJsonString(message.content),
        });
      }
      continue;
    }

    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      // With store=false and no previous_response_id, encrypted reasoning
      // output must be replayed before the corresponding function calls. The
      // items live on a non-enumerable message property, so this projection is
      // available only to the in-flight provider loop and cannot enter the
      // Session Journal through JSON serialization.
      input.push(...getResponsesReasoningItems(message));
      for (const call of message.tool_calls) {
        if (!call || typeof call !== "object") continue;
        const fn = call.function && typeof call.function === "object" ? call.function : call;
        const callId = String(call.id || call.call_id || "").trim();
        const name = String(fn.name || "").trim();
        if (!callId || !name) continue;
        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : toJsonString(fn.arguments),
        });
      }
      const assistantText = normalizeContentParts(message.content, "assistant");
      if (assistantText.length > 0) {
        input.push({ type: "message", role: "assistant", content: assistantText });
      }
      continue;
    }

    const responseRole = role === "system" ? "developer" : role;
    const content = normalizeContentParts(message.content, role);
    if (content.length > 0) {
      input.push({ type: "message", role: responseRole, content });
    }
  }
  return input;
}

function toolsToResponsesTools(tools = []) {
  const result = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type && tool.type !== "function") {
      // Hosted/namespace tools are provider-specific. Pass through only when
      // they already use the Responses shape.
      if (tool.type === "web_search" || tool.type === "x_search" || tool.type === "image_generation") {
        result.push({ ...tool });
      }
      continue;
    }
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    const name = String(fn.name || "").trim();
    if (!name) continue;
    result.push({
      type: "function",
      name,
      description: String(fn.description || ""),
      parameters: fn.parameters && typeof fn.parameters === "object"
        ? fn.parameters
        : { type: "object", properties: {}, additionalProperties: true },
    });
  }
  return result;
}

function buildResponsesPayload({
  model = "",
  instructions = "",
  messages = [],
  tools = [],
  maxOutputTokens = DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS,
  reasoningEffort = "",
  provider = "",
} = {}) {
  const payload = {
    model: String(model || "").trim(),
    instructions: String(instructions || ""),
    input: messagesToResponsesInput(messages),
    max_output_tokens: Math.max(1, Number(maxOutputTokens) || DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS),
    stream: true,
    store: false,
    parallel_tool_calls: true,
  };

  const responseTools = toolsToResponsesTools(tools);
  if (responseTools.length > 0) {
    payload.tools = responseTools;
    payload.tool_choice = "auto";
  }

  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "codex" || normalizedProvider === "openai"
    || normalizedProvider === "grok-build" || normalizedProvider === "xai") {
    payload.include = ["reasoning.encrypted_content"];
  }
  const effort = String(reasoningEffort || "").trim();
  if (effort) {
    payload.reasoning = { effort, summary: "auto" };
  } else if (normalizedProvider === "codex") {
    payload.reasoning = { effort: "medium", summary: "auto" };
  }
  return payload;
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}

function isResponsesKeepalive(eventName = "", data = null) {
  if (String(eventName || "").trim().toLowerCase() === "keepalive") return true;
  const parsed = parseJson(data);
  return Boolean(parsed && parsed.type === "keepalive");
}

function responseEventDelta(frame = {}) {
  const data = parseJson(frame.data);
  if (!data || isResponsesKeepalive(frame.event, data)) {
    return { text: "", reasoning: "", type: "" };
  }
  const type = String(data.type || frame.event || "").trim();
  if (type === "response.output_text.delta") {
    return { text: String(data.delta || ""), reasoning: "", type };
  }
  if (/^response\.(?:reasoning|reasoning_text|reasoning_summary|reasoning_summary_text)\.(?:delta|text\.delta)$/.test(type)) {
    return { text: "", reasoning: String(data.delta || data.text || ""), type };
  }
  return { text: "", reasoning: "", type };
}

function responseOutputText(output = []) {
  const parts = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const content of Array.isArray(item.content) ? item.content : []) {
        if (content && (content.type === "output_text" || content.type === "text")) {
          parts.push(String(content.text || ""));
        }
      }
    } else if (item.type === "output_text") {
      parts.push(String(item.text || ""));
    }
  }
  return parts.join("");
}

function responseUsage(response = null) {
  const usage = response && typeof response === "object" && response.usage && typeof response.usage === "object"
    ? response.usage
    : null;
  if (!usage) return null;
  const inputDetails = usage.input_token_details && typeof usage.input_token_details === "object"
    ? usage.input_token_details
    : {};
  return {
    input: Number(usage.input_tokens || usage.prompt_tokens || 0) || 0,
    output: Number(usage.output_tokens || usage.completion_tokens || 0) || 0,
    cacheRead: Number(
      inputDetails.cached_tokens || usage.cached_input_tokens || usage.cache_read_input_tokens || 0,
    ) || 0,
    cacheCreation: Number(usage.cache_creation_input_tokens || usage.cache_creation_tokens || 0) || 0,
    inputIncludesCache: true,
  };
}

function responseToolKey(data = {}, item = null) {
  return String(
    data.item_id
      || (item && item.id)
      || data.output_index
      || (item && (item.output_index || item.call_id))
      || data.call_id
      || "",
  ).trim();
}

function mergeFunctionCall(toolMap, data = {}, item = null) {
  const key = responseToolKey(data, item);
  if (!key) return;
  const existing = toolMap.get(key) || {
    order: Number.isFinite(Number(data.output_index)) ? Number(data.output_index) : toolMap.size,
    id: "",
    name: "",
    arguments: "",
  };
  const source = item && typeof item === "object" ? item : data;
  existing.id = String(source.call_id || source.id || existing.id || data.call_id || "").trim();
  existing.name = String(source.name || existing.name || data.name || "").trim();
  if (typeof source.arguments === "string") existing.arguments = source.arguments;
  if (typeof data.arguments === "string") existing.arguments = data.arguments;
  if (typeof data.delta === "string" && data.type === "response.function_call_arguments.delta") {
    existing.arguments += data.delta;
  }
  toolMap.set(key, existing);
}

function mergeResponseOutput(toolMap, output = []) {
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") mergeFunctionCall(toolMap, item, item);
  }
}

function mergeOutputItem(outputItemMap, data = {}, item = null) {
  if (!item || typeof item !== "object") return;
  const numericIndex = Number(data.output_index);
  const hasIndex = Number.isFinite(numericIndex);
  const key = hasIndex
    ? `index:${numericIndex}`
    : `id:${String(item.id || outputItemMap.size)}`;
  outputItemMap.set(key, {
    order: hasIndex ? numericIndex : outputItemMap.size,
    item: cloneJsonValue(item),
  });
}

function mergeCompletedOutput(outputItemMap, output = []) {
  for (const [index, item] of (Array.isArray(output) ? output : []).entries()) {
    if (!item || typeof item !== "object") continue;
    const key = `index:${index}`;
    if (!outputItemMap.has(key)) {
      mergeOutputItem(outputItemMap, { output_index: index }, item);
    }
  }
}

function parseResponsesEvents(frames = [], { assumeCompleted = false } = {}) {
  const events = [];
  const textParts = [];
  const reasoningParts = [];
  const toolMap = new Map();
  const outputItemMap = new Map();
  let response = null;
  let terminal = assumeCompleted ? "completed" : "";

  for (const frame of Array.isArray(frames) ? frames : []) {
    const data = parseJson(frame && frame.data);
    if (!data || isResponsesKeepalive(frame && frame.event, data)) continue;
    events.push(data);
    const type = String(data.type || (frame && frame.event) || "").trim();
    const delta = responseEventDelta({ event: type, data });
    if (delta.text) textParts.push(delta.text);
    if (delta.reasoning) reasoningParts.push(delta.reasoning);

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      mergeFunctionCall(toolMap, data, data.item);
      mergeOutputItem(outputItemMap, data, data.item);
    } else if (type === "response.function_call_arguments.delta"
      || type === "response.function_call_arguments.done") {
      mergeFunctionCall(toolMap, data, null);
    }

    if (type === "response.completed" || type === "response.incomplete") {
      terminal = type === "response.completed" ? "completed" : "incomplete";
      if (data.response && typeof data.response === "object") {
        response = data.response;
        mergeResponseOutput(toolMap, response.output);
        mergeCompletedOutput(outputItemMap, response.output);
        if (!textParts.length) {
          const fallbackText = responseOutputText(response.output);
          if (fallbackText) textParts.push(fallbackText);
        }
      }
    } else if (!response && data.object === "response") {
      response = data;
      mergeResponseOutput(toolMap, response.output);
      mergeCompletedOutput(outputItemMap, response.output);
      if (!textParts.length) {
        const fallbackText = responseOutputText(response.output);
        if (fallbackText) textParts.push(fallbackText);
      }
      if (data.status === "completed" || data.status === "incomplete") {
        terminal = data.status;
      }
    }
  }

  const toolCalls = Array.from(toolMap.values())
    .sort((left, right) => left.order - right.order)
    .filter((call) => call.id && call.name)
    .map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.arguments || "{}",
      },
    }));
  const outputItems = Array.from(outputItemMap.values())
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.item)
    .filter(Boolean);

  return {
    text: textParts.join(""),
    reasoning: reasoningParts.join(""),
    toolCalls,
    outputItems,
    response,
    responseId: String(response && response.id || "").trim(),
    usage: responseUsage(response),
    terminal,
    incompleteDetails: response && response.incomplete_details ? response.incomplete_details : null,
    events,
  };
}

function parseSseBlocks(raw = "") {
  const text = String(raw || "");
  const blocks = text.split(/\r?\n\r?\n/);
  const rest = blocks.pop() || "";
  return { blocks: blocks.filter(Boolean), rest };
}

function parseSseFrame(block = "") {
  let event = "";
  const dataLines = [];
  for (const line of String(block || "").split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return { event, data: dataLines.join("\n").trim() };
}

function parseResponsesSsePayload(payload = "") {
  const frames = [];
  let buffer = String(payload || "");
  const parsed = parseSseBlocks(buffer);
  for (const block of parsed.blocks) frames.push(parseSseFrame(block));
  buffer = parsed.rest;
  if (buffer.trim()) frames.push(parseSseFrame(buffer));
  return parseResponsesEvents(frames);
}

module.exports = {
  DEFAULT_RESPONSES_MAX_OUTPUT_TOKENS,
  attachResponsesReasoningItems,
  getResponsesReasoningItems,
  reasoningItemsFromResponse,
  resolveResponsesUrl,
  messagesToResponsesInput,
  toolsToResponsesTools,
  buildResponsesPayload,
  isResponsesKeepalive,
  responseEventDelta,
  responseOutputText,
  responseUsage,
  parseResponsesEvents,
  parseResponsesSsePayload,
};

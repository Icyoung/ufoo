"use strict";

const { createHash, randomUUID } = require("crypto");
const { buildAgyHeaders, resolveAgyCredentials } = require("../credentials/agy");
const { createAnthropicMessagesTransport } = require("./anthropicMessagesTransport");
const { assertTransport } = require("./transportContract");

function resolveAgyUrl(baseUrl, method = "streamGenerateContent") {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "").replace(/\/v1internal:[^/]+$/, "");
  url.pathname = `${basePath}/v1internal:${method}`;
  url.searchParams.delete("$alt");
  url.searchParams.delete("alt");
  if (method === "streamGenerateContent") url.searchParams.set("alt", "sse");
  return url.toString();
}

// Cloud Code accepts the Gemini Schema shape. Project only the keywords it
// understands, recursing into schemas rather than inspecting tool arguments.
function toAgySchema(schema = {}, requireNonempty = false) {
  const { type, description, properties, items, required, enum: choices, anyOf, oneOf } = schema || {};
  const variants = anyOf || oneOf;
  if (Array.isArray(variants) && variants.length) {
    if (!requireNonempty) return { anyOf: variants.map((option) => toAgySchema(option)) };
    const usable = variants.filter((option) => option?.type !== "null");
    const variant = toAgySchema({ ...usable[0], ...(description ? { description } : {}) }, requireNonempty);
    if (usable.length < variants.length) variant.nullable = true;
    return variant;
  }
  const result = {};
  if (typeof type === "string") result.type = type;
  if (description) result.description = description;
  if (Array.isArray(choices) && choices.length) {
    result.description = [description, `Allowed values: ${choices.map(JSON.stringify).join(", ")}.`].filter(Boolean).join(" ");
  }
  if (properties && typeof properties === "object") {
    result.properties = Object.fromEntries(Object.entries(properties).map(([name, value]) => [name, toAgySchema(value, requireNonempty)]));
  }
  if (items && typeof items === "object" && !Array.isArray(items)) result.items = toAgySchema(items, requireNonempty);
  if (Array.isArray(required) && required.length) result.required = required;
  if (requireNonempty && result.type === "object" && !Object.keys(result.properties || {}).length) {
    result.properties = { _unused: { type: "boolean", description: "Leave this field unset." } };
  }
  return result;
}

function agySessionId(sessionId) {
  const hash = createHash("sha256").update(sessionId || randomUUID()).digest();
  return `-${hash.readBigUInt64BE() >> 1n}`;
}

function toImagePart({ source } = {}) {
  if (source?.type !== "base64" || !source.data || !source.media_type) return null;
  return { inlineData: { mimeType: source.media_type, data: source.data } };
}

function toAgyContents(messages, model) {
  const calls = new Map();
  const contents = [];
  for (const message of messages) {
    if (message.role !== "assistant" && message.role !== "user") continue;
    const role = message.role === "assistant" ? "model" : "user";
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    const parts = [];
    const resultImages = [];
    for (const block of blocks) {
      if (!block) continue;
      const signature = block.thoughtSignature && block.signatureModel === model
        ? { thoughtSignature: block.thoughtSignature }
        : {};
      if (block.type === "text" && (block.text || signature.thoughtSignature)) {
        parts.push({ text: block.text || "", ...signature });
      } else if (block.type === "thinking" && signature.thoughtSignature) {
        parts.push({ text: block.thinking || "", thought: true, ...signature });
      } else if (block.type === "tool_use") {
        const call = { name: block.name, ...(block.upstreamId ? { id: block.upstreamId } : {}) };
        calls.set(block.id, call);
        parts.push({ functionCall: { ...call, args: block.input || {} }, ...signature });
      } else if (block.type === "tool_result" && calls.has(block.tool_use_id)) {
        const result = Array.isArray(block.content) ? block.content : [{ type: "text", text: block.content }];
        const text = result.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
        parts.push({ functionResponse: { ...calls.get(block.tool_use_id), response: {
          [block.is_error ? "error" : "output"]: text,
        } } });
        resultImages.push(...result.filter((item) => item?.type === "image").map(toImagePart).filter(Boolean));
        calls.delete(block.tool_use_id);
      } else if (block.type === "image") {
        const image = toImagePart(block);
        if (image) parts.push(image);
      }
    }
    parts.push(...resultImages);
    if (!parts.length) continue;
    const previous = contents.at(-1);
    if (role === "user" && previous?.role === role && parts.every((part) => part.functionResponse)
      && previous.parts.every((part) => part.functionResponse)) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  }
  return contents;
}

function agyThinkingConfig(model, effort) {
  if (!effort) return null;
  if (/^gemini-3/i.test(model)) {
    // Pro accepts LOW or HIGH. Flash also supports MINIMAL and MEDIUM.
    const flash = /flash/i.test(model);
    const thinkingLevel = {
      off: flash ? "minimal" : "low",
      low: "low",
      medium: flash ? "medium" : "high",
      high: "high",
      xhigh: "high",
      max: "high",
    }[effort];
    return thinkingLevel ? { thinkingLevel, includeThoughts: effort !== "off" } : null;
  }
  const budget = { off: 0, low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 }[effort];
  return /thinking|^gemini-2\.5/i.test(model) && budget !== undefined
    ? { thinkingBudget: budget, includeThoughts: effort !== "off" }
    : null;
}

function createAntigravityTransport({ runSseRequest, parseSseEventBlock, ...messageDeps }) {
  async function runTurn({
    url, apiKey, model, sessionId, messages = [], tools = [], systemPrompt = "", systemBlocks = null,
    thinkingLevel, maxOutputTokens, signal, timeoutMs, onTextDelta, onThinkingDelta, onPhase, onRequest, requestScope, requestPurpose, strategyVersion,
  }) {
    const credential = await resolveAgyCredentials({ apiKey, baseUrl: url, signal });
    const claude = /^claude-/i.test(model);
    const declarations = tools.map(({ function: tool }) => ({
      name: tool.name,
      description: tool.description,
      parameters: toAgySchema(tool.parameters, claude),
    }));
    const systemTexts = systemBlocks?.length ? systemBlocks.map((block) => block.text) : [systemPrompt];
    const systemParts = systemTexts.filter(Boolean).map((text) => ({ text }));
    const thinkingConfig = agyThinkingConfig(model, thinkingLevel);
    const generationConfig = {
      ...(claude && maxOutputTokens ? { maxOutputTokens } : {}),
      ...(thinkingConfig ? { thinkingConfig } : {}),
    };
    const payload = {
      model,
      project: credential.projectId,
      requestType: "agent",
      userAgent: "antigravity",
      requestId: `agent-${randomUUID()}`,
      request: {
        contents: toAgyContents(messages, model),
        sessionId: agySessionId(sessionId),
        ...(systemParts.length ? { systemInstruction: { role: "user", parts: systemParts } } : {}),
        ...(declarations.length ? {
          tools: [{ functionDeclarations: declarations }],
          toolConfig: { functionCallingConfig: { mode: claude ? "VALIDATED" : "AUTO" } },
        } : {}),
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      },
    };

    let text = "";
    let usage = null;
    let finishReason = "";
    const assistantContent = [];
    const toolCalls = [];
    function consume(chunk) {
      const response = chunk?.response || chunk;
      if (chunk?.error || response?.error) {
        throw new Error(`Antigravity stream error: ${(chunk.error || response.error).message || "unknown error"}`);
      }
      const stats = response?.usageMetadata;
      if (stats) {
        usage = {
          input: Number(stats.promptTokenCount) || 0,
          output: (Number(stats.candidatesTokenCount) || 0) + (Number(stats.thoughtsTokenCount) || 0),
          cacheRead: stats.cachedContentTokenCount == null ? null : Number(stats.cachedContentTokenCount) || 0,
          cacheCreation: null,
          inputIncludesCache: true,
        };
      }
      const candidate = response?.candidates?.[0];
      if (candidate?.finishReason) finishReason = candidate.finishReason;
      for (const part of candidate?.content?.parts || []) {
        const signature = part.thoughtSignature ? { thoughtSignature: part.thoughtSignature, signatureModel: model } : {};
        if (part.functionCall) {
          const { name, args = {}, id: upstreamId } = part.functionCall;
          if (!name) throw new Error("Antigravity returned a function call without a name.");
          const id = `tool_${randomUUID()}`;
          assistantContent.push({ type: "tool_use", id, name, input: args, upstreamId, ...signature });
          toolCalls.push({ id, name, args });
          continue;
        }
        const delta = typeof part.text === "string" ? part.text : "";
        if (!delta && !part.thoughtSignature) continue;
        if (part.thought) {
          if (part.thoughtSignature) assistantContent.push({ type: "thinking", thinking: delta, ...signature });
          if (delta) {
            onPhase?.({ type: "thinking_delta", text: delta });
            onThinkingDelta?.(delta);
          }
        } else {
          assistantContent.push({ type: "text", text: delta, ...signature });
          text += delta;
          if (delta) {
            onPhase?.({ type: "text_delta", text: delta });
            onTextDelta?.(delta);
          }
        }
      }
    }
    function buildResult() {
      if (!finishReason) throw new Error("Antigravity response ended before a finish reason was received.");
      if (!["STOP", "MAX_TOKENS"].includes(finishReason)) throw new Error(`Antigravity stopped: ${finishReason}`);
      if (finishReason === "MAX_TOKENS" && toolCalls.length) {
        throw new Error("Antigravity hit its output limit before completing the tool-call batch.");
      }
      return { text, assistantContent, toolCalls, usage };
    }
    const onEvent = ({ data }) => consume(JSON.parse(data));
    return runSseRequest({
      url, headers: { ...buildAgyHeaders(credential), Accept: "text/event-stream" }, payload, signal, timeoutMs, onPhase,
      onRequest, requestObservation: { transport: "antigravity", sessionId, requestScope, requestPurpose, strategyVersion },
      onNonStream(data) {
        for (const chunk of Array.isArray(data) ? data : [data]) consume(chunk);
        return buildResult();
      },
      onEvent,
      onTail(tail) {
        const { data } = parseSseEventBlock(tail);
        if (data && data !== "[DONE]") onEvent({ data });
      },
      buildResult,
    });
  }

  // Both adapters use content blocks with batched tool results in the journal.
  const messages = createAnthropicMessagesTransport({ ...messageDeps, resolveUrl: resolveAgyUrl, runTurn });
  return assertTransport({ ...messages, name: "antigravity" }, "antigravity");
}

module.exports = { createAntigravityTransport, resolveAgyUrl };

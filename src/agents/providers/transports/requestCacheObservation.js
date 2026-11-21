"use strict";

const { createHash } = require("crypto");

const MAX_SESSIONS = 200;
const previousRequests = new Map();
const digest = (value) => createHash("sha256").update(value).digest("hex");

function sectionsOf(payload) {
  const body = payload.request || payload;
  return [
    ["settings", [{ model: payload.model, tool_choice: body.tool_choice || body.toolConfig,
      thinking: body.thinking || body.reasoning || body.reasoning_effort || body.generationConfig?.thinkingConfig,
      effort: body.output_config?.effort }]],
    ["tools", body.tools || []],
    ["system", Array.isArray(body.system) ? body.system : body.systemInstruction?.parts || (body.instructions ? [body.instructions] : [])],
    ["messages", body.messages || body.input || body.contents || []],
  ];
}

function prefixContent(value) {
  if (Array.isArray(value)) return value.map(prefixContent);
  if (!value || typeof value !== "object") return value;
  const { cache_control: _cache, prompt_cache_breakpoint: _breakpoint, ...content } = value;
  if (Array.isArray(content.content)) content.content = prefixContent(content.content);
  return content;
}

function observeWireRequest({ payload, url, transport, sessionId, requestProfile, requestScope, requestPurpose, credentials, strategyVersion = 1, startedAt }) {
  const key = `${requestScope}\0${requestPurpose}\0${url}\0${transport}\0${sessionId}\0${payload.model}\0${requestProfile}\0${digest(credentials)}`;
  const previous = sessionId ? previousRequests.get(key) : null;
  const parts = sectionsOf(payload).flatMap(([section, values]) => values.map((value, index) => {
    const content = section === "messages" && transport === "anthropic-messages" && typeof value.content === "string"
      ? { ...value, content: [{ type: "text", text: value.content }] } : value;
    const text = JSON.stringify(prefixContent(content));
    return { section, index, digest: digest(text), estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4) };
  }));
  let common = 0;
  while (previous && common < Math.min(previous.parts.length, parts.length)) {
    const a = previous.parts[common], b = parts[common];
    if (a.section !== b.section || a.index !== b.index || a.digest !== b.digest) break;
    common += 1;
  }
  const earliestChange = previous && (parts[common] || previous.parts[common]);
  if (sessionId) {
    previousRequests.delete(key);
    previousRequests.set(key, { startedAt, parts });
    if (previousRequests.size > MAX_SESSIONS) previousRequests.delete(previousRequests.keys().next().value);
  }
  return {
    channel: requestProfile || transport,
    strategyVersion,
    startIntervalMs: previous ? Math.max(0, startedAt - previous.startedAt) : null,
    earliestChange: earliestChange ? { section: earliestChange.section, index: earliestChange.index,
      previousDigest: previous.parts[common]?.digest || null, digest: parts[common]?.digest || null } : null,
    prefixDigest: digest(parts.map(part => `${part.section}:${part.digest}`).join("\n")),
    commonPrefixEstimatedTokens: previous ? parts.slice(0, common).reduce((sum, part) => sum + part.estimatedTokens, 0) : null,
  };
}

module.exports = { observeWireRequest };

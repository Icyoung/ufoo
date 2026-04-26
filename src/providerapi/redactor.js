"use strict";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /(^|_|-)(authorization|accesstoken|access_token|refreshtoken|refresh_token|apikey|api_key|tokenhash|token_hash)$/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const INLINE_SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})["']?/gi;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSensitiveKey(key = "") {
  const normalized = String(key || "").replace(/[\s-]+/g, "_");
  if (!normalized) return false;
  if (SENSITIVE_KEY_PATTERN.test(normalized)) return true;
  return /^token$/i.test(normalized);
}

function redactString(value) {
  return String(value || "")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(INLINE_SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]");
}

function redactSecrets(value, options = {}) {
  const seen = options._seen || new WeakMap();

  if (typeof value === "string") {
    return redactString(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (const item of value) {
      out.push(redactSecrets(item, { ...options, _seen: seen }));
    }
    return out;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out = {};
  seen.set(value, out);
  for (const [key, entryValue] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactSecrets(entryValue, { ...options, _seen: seen });
  }
  return out;
}

function redactJsonLine(value) {
  return JSON.stringify(redactSecrets(value));
}

function redactUfooEvent(event) {
  if (!event || typeof event !== "object") return event;
  return redactSecrets(event);
}

function redactToolCallPayload(payload = {}) {
  const input = payload && typeof payload === "object" ? payload : {};
  return {
    name: typeof input.name === "string" ? input.name : String(input.name || ""),
    args: redactSecrets(input.args || input.arguments || {}),
    tool_call_id: typeof input.tool_call_id === "string"
      ? input.tool_call_id
      : (typeof input.toolCallId === "string" ? input.toolCallId : ""),
    caller_tier: typeof input.caller_tier === "string" ? input.caller_tier : "",
  };
}

module.exports = {
  REDACTED,
  redactSecrets,
  redactJsonLine,
  redactString,
  isSensitiveKey,
  redactUfooEvent,
  redactToolCallPayload,
};

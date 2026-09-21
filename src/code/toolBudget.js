"use strict";

function parseMaxToolCalls(value) {
  if (value == null || String(value).trim().toLowerCase() === "none") return null;
  const text = String(value).trim();
  const count = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(count) || count <= 0) {
    throw new Error("max tool calls must be a positive integer or none");
  }
  return count;
}

function resolveMaxToolCalls(value, env = process.env) {
  if (value !== undefined) return parseMaxToolCalls(value);
  const configured = env.UFOO_UCODE_MAX_TOOL_CALLS;
  return configured == null || String(configured).trim() === ""
    ? null
    : parseMaxToolCalls(configured);
}

module.exports = { parseMaxToolCalls, resolveMaxToolCalls };

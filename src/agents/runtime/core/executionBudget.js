"use strict";

const DEFAULT_TASK_TIMEOUT_MS = 43200000;
const DEFAULT_MAX_TOOL_ERRORS = 20;

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
  return configured == null || String(configured).trim() === "" ? null : parseMaxToolCalls(configured);
}

function resolveToolBudget(maxToolCalls, env = process.env) {
  const errors = Number.parseInt(String(env.UFOO_UCODE_MAX_TOOL_ERRORS || ""), 10);
  return {
    maxToolCalls: resolveMaxToolCalls(maxToolCalls, env),
    maxToolErrors: Number.isFinite(errors) && errors > 0 ? errors : DEFAULT_MAX_TOOL_ERRORS,
  };
}

function resolveTaskTimeoutMs(value, env = process.env) {
  if (Number.isFinite(value) && value > 0) return Math.max(1000, Math.floor(value));
  const configured = Number(env.UFOO_UCODE_TASK_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1000, Math.floor(configured)) : DEFAULT_TASK_TIMEOUT_MS;
}

module.exports = { DEFAULT_TASK_TIMEOUT_MS, DEFAULT_MAX_TOOL_ERRORS, parseMaxToolCalls, resolveMaxToolCalls, resolveToolBudget, resolveTaskTimeoutMs };

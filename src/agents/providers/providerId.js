"use strict";

function normalizeProvider(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text === "custom") return "openai";
  if (text === "codex" || text === "codex-cli" || text === "codex-code") return "codex";
  if (text === "claude" || text === "claude-cli" || text === "claude-code") return "anthropic";
  if (text === "agy" || text === "agy-cli" || text === "antigravity") return "agy";
  if (text === "kimi" || text === "kimi-code" || text === "moonshot") return "kimi";
  if (text === "grok" || text === "grok-build" || text === "grok-shell" || text === "grok-api") return "grok-build";
  if (text === "xai") return "xai";
  if (text === "openai" || text === "anthropic") return text;
  return text;
}

module.exports = { normalizeProvider };

"use strict";

/**
 * Context-window helpers for the ucode TUI meter (used / limit in K).
 *
 * usedTokens comes from the latest model request's prompt occupancy.
 * limitTokens is resolved from the model id (provider catalogs rarely
 * expose a reliable context_window field).
 */

function toTokenCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * Prompt-side tokens currently occupying the context window.
 * Anthropic splits input / cache_read / cache_creation; OpenAI folds
 * cache hits into prompt_tokens (cached_tokens is a subset).
 */
function contextTokensFromUsage(usage = null) {
  if (!usage || typeof usage !== "object") return 0;
  const input = toTokenCount(usage.input);
  const cacheRead = toTokenCount(usage.cacheRead);
  const cacheCreation = toTokenCount(usage.cacheCreation);
  if (cacheCreation > 0) return input + cacheRead + cacheCreation;
  // Anthropic exclusive split: input can be smaller than cache_read alone.
  if (cacheRead > 0 && input < cacheRead) return input + cacheRead + cacheCreation;
  // OpenAI-compatible: prompt_tokens already includes cached tokens.
  return input;
}

function resolveModelContextLimit(model = "", options = {}) {
  const override = toTokenCount(options.limit || options.contextLimit);
  if (override > 0) return override;

  const id = String(model || "").trim().toLowerCase();
  if (!id) return 200000;

  if (/\b1m\b|1000000|million|1\.0m/.test(id)) return 1000000;
  if (/256k/.test(id)) return 256000;
  if (/128k/.test(id)) return 128000;
  if (/64k/.test(id)) return 64000;
  if (/32k/.test(id)) return 32000;

  if (/claude|anthropic|opus|sonnet|haiku/.test(id)) return 200000;
  if (/gemini|gemma/.test(id)) return 1000000;
  if (/kimi|moonshot|k2\.|k2-|k3/.test(id)) return 256000;
  if (/gpt-5|o3|o4|codex/.test(id)) return 200000;
  if (/gpt-4\.1|gpt-4o|gpt-4-turbo|o1/.test(id)) return 128000;
  if (/gpt-4|gpt-3\.5/.test(id)) return 128000;

  return 200000;
}

function formatTokensK(tokens = 0) {
  const n = Math.max(0, Math.floor(Number(tokens) || 0));
  if (n < 1000) return String(n);
  const k = n / 1000;
  if (k >= 100) return `${Math.round(k)}K`;
  const tenths = Math.round(k * 10) / 10;
  if (Number.isInteger(tenths)) return `${tenths}K`;
  return `${tenths.toFixed(1)}K`;
}

function formatContextMeter({ usedTokens = 0, limitTokens = 0 } = {}) {
  const used = Math.max(0, Math.floor(Number(usedTokens) || 0));
  const limit = Math.max(0, Math.floor(Number(limitTokens) || 0));
  if (limit > 0) return `${formatTokensK(used)} / ${formatTokensK(limit)}`;
  return formatTokensK(used);
}

function buildContextMeter({
  usage = null,
  usedTokens = null,
  model = "",
  limitTokens = null,
} = {}) {
  const used = usedTokens != null
    ? toTokenCount(usedTokens)
    : contextTokensFromUsage(usage);
  const limit = resolveModelContextLimit(model, { limit: limitTokens });
  return {
    usedTokens: used,
    limitTokens: limit,
    model: String(model || "").trim(),
    label: formatContextMeter({ usedTokens: used, limitTokens: limit }),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeContextMeter(value = null, model = "") {
  const source = value && typeof value === "object" ? value : {};
  const used = toTokenCount(source.usedTokens);
  const limit = resolveModelContextLimit(
    String(source.model || model || "").trim(),
    { limit: source.limitTokens },
  );
  return {
    usedTokens: used,
    limitTokens: limit,
    model: String(source.model || model || "").trim(),
    label: formatContextMeter({ usedTokens: used, limitTokens: limit }),
    updatedAt: String(source.updatedAt || "").trim(),
  };
}

module.exports = {
  toTokenCount,
  contextTokensFromUsage,
  resolveModelContextLimit,
  formatTokensK,
  formatContextMeter,
  buildContextMeter,
  normalizeContextMeter,
};

"use strict";

const { saveGlobalUcodeConfig, loadGlobalUcodeConfig } = require("../config");
const {
  listProviderModels,
  confirmModelSupported,
} = require("./providers/modelsCatalog");
const {
  normalizeThinkingLevel,
  suggestThinkingLevels,
  applyThinkingLevelToEnv,
  resolveThinkingFromEnvAndConfig,
  DEFAULT_THINKING_LEVEL,
} = require("./thinkingLevels");

function fallbackModelSuggestions(provider = "") {
  const text = String(provider || "").trim().toLowerCase();
  if (text.includes("anthropic") || text.includes("claude")) {
    return ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"];
  }
  if (text.includes("kimi") || text.includes("moonshot")) {
    return ["k3", "kimi-k2.5", "moonshot-v1-128k"];
  }
  return ["gpt-5.4", "gpt-5.3", "o3", "o4-mini"];
}

function resolveModelRuntime(state = {}, options = {}) {
  // Lazy require: nativeRunner pulls agent/repl paths that can load modelCommand.
  const { resolveRuntimeConfig } = require("./nativeRunner");
  return resolveRuntimeConfig({
    workspaceRoot: options.workspaceRoot || process.cwd(),
    provider: options.provider || (state && state.provider) || "",
    model: options.model || (state && state.model) || "",
  });
}

function currentThinkingLevel(state = {}) {
  let configLevel = "";
  try {
    configLevel = String((loadGlobalUcodeConfig() || {}).ucodeThinking || "").trim();
  } catch {
    configLevel = "";
  }
  const fromState = normalizeThinkingLevel(state && state.thinking);
  const resolved = resolveThinkingFromEnvAndConfig({
    env: process.env,
    configLevel: fromState || configLevel,
  });
  if (resolved.level) return resolved.level;
  if (resolved.source === "env-budget") {
    // Approximate a named level for the secondary menu highlight.
    const budget = Number(resolved.budgetTokens) || 0;
    if (budget <= 0) return "off";
    if (budget <= 3000) return "low";
    if (budget <= 16000) return "medium";
    if (budget <= 40000) return "high";
    return "max";
  }
  return DEFAULT_THINKING_LEVEL;
}

function persistThinkingLevel(state = {}, level = "") {
  const normalized = normalizeThinkingLevel(level);
  if (!normalized) return "";
  if (state && typeof state === "object") state.thinking = normalized;
  try {
    saveGlobalUcodeConfig({ ucodeThinking: normalized });
  } catch {
    // best-effort
  }
  applyThinkingLevelToEnv(normalized, process.env);
  return normalized;
}

/**
 * Fetch models from the configured provider's /models route.
 */
async function listUcodeModels(state = {}, options = {}) {
  const runtime = resolveModelRuntime(state, options);
  const listed = await listProviderModels({
    ...runtime,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    skipCache: options.skipCache === true,
  });
  return {
    ...listed,
    provider: runtime.provider,
    transport: runtime.transport,
    baseUrl: runtime.baseUrl,
  };
}

/**
 * Apply /model show|set against the live session state.
 * Persists ucodeModel / ucodeThinking so the next launch keeps them.
 * Set validates against the provider models route when available.
 *
 * result.shape:
 *   { action: "show" }
 *   { action: "set", model, thinking? }
 */
async function applyUcodeModelCommand(state = {}, result = {}, options = {}) {
  const action = String((result && result.action) || "").trim().toLowerCase();
  if (action === "show") {
    const model = String((state && state.model) || "").trim() || "(unset)";
    const provider = String((state && state.provider) || "").trim() || "(unset)";
    const thinking = currentThinkingLevel(state);
    const lines = [
      `model: ${model}`,
      `provider: ${provider}`,
      `thinking: ${thinking}`,
      "usage: /model <model-id> [off|low|medium|high|max]",
    ];
    try {
      const listed = await listUcodeModels(state, options);
      if (listed.ok && listed.models.length > 0) {
        const sample = listed.models.slice(0, 12);
        lines.push(`models route: ${listed.url}`);
        lines.push(`available (${listed.models.length}): ${sample.join(", ")}${listed.models.length > 12 ? "…" : ""}`);
      } else if (listed.error) {
        lines.push(`models route: ${listed.error}`);
      }
    } catch (err) {
      lines.push(`models route: ${err && err.message ? err.message : "unavailable"}`);
    }
    return {
      ok: true,
      error: "",
      output: lines.join("\n"),
      model: String((state && state.model) || "").trim(),
      thinking,
    };
  }
  if (action === "set") {
    const next = String((result && result.model) || "").trim();
    const thinkingRaw = String((result && result.thinking) || "").trim();
    const thinkingNext = normalizeThinkingLevel(thinkingRaw);
    if (!next) {
      return {
        ok: false,
        error: "usage: /model [model-id] [off|low|medium|high|max]",
        output: "usage: /model [model-id] [off|low|medium|high|max]",
      };
    }
    if (thinkingRaw && !thinkingNext) {
      return {
        ok: false,
        error: `unknown thinking level "${thinkingRaw}" (use off|low|medium|high|max)`,
        output: `unknown thinking level "${thinkingRaw}" (use off|low|medium|high|max)`,
      };
    }

    const runtime = resolveModelRuntime(state, { ...options, model: next });
    const confirmation = await confirmModelSupported({
      ...runtime,
      model: next,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      skipCache: options.skipCache === true,
      strict: options.strict === true,
    });
    if (!confirmation.allowed) {
      return {
        ok: false,
        error: confirmation.error || `model "${next}" is not supported`,
        output: confirmation.error || `model "${next}" is not supported`,
        models: confirmation.models,
      };
    }

    const previous = String((state && state.model) || "").trim();
    const previousThinking = currentThinkingLevel(state);
    if (state && typeof state === "object") state.model = next;
    try {
      saveGlobalUcodeConfig({ ucodeModel: next });
    } catch {
      // best-effort persistence
    }
    try {
      process.env.UFOO_UCODE_MODEL = next;
    } catch {
      // ignore env write failures
    }

    const lines = [];
    const modelOutput = previous && previous !== next
      ? `model switched: ${previous} → ${next}`
      : `model set: ${next}`;
    lines.push(modelOutput);

    let appliedThinking = "";
    if (thinkingNext) {
      appliedThinking = persistThinkingLevel(state, thinkingNext);
      if (previousThinking && previousThinking !== appliedThinking) {
        lines.push(`thinking: ${previousThinking} → ${appliedThinking}`);
      } else {
        lines.push(`thinking: ${appliedThinking}`);
      }
    }

    if (confirmation.warning) lines.push(`note: ${confirmation.warning}`);
    if (confirmation.ok && confirmation.models.length > 0) {
      lines.push(`confirmed via models route (${confirmation.models.length} available)`);
    }
    return {
      ok: true,
      error: "",
      output: lines.join("\n"),
      model: next,
      previous,
      thinking: appliedThinking || previousThinking,
      warning: confirmation.warning || "",
      models: confirmation.models,
    };
  }
  return {
    ok: false,
    error: "usage: /model [model-id] [off|low|medium|high|max]",
    output: "usage: /model [model-id] [off|low|medium|high|max]",
  };
}

/**
 * Build /model completion rows. Prefer a live models-route catalog when
 * provided; otherwise fall back to a small hardcoded list.
 * Models are marked hasChildren so the TUI opens a thinking-intensity
 * secondary menu after the id is chosen.
 */
function suggestUcodeModels(state = {}, options = {}) {
  const current = String((state && state.model) || "").trim();
  const provider = String((state && state.provider) || "").trim().toLowerCase();
  const remote = Array.isArray(options.models)
    ? options.models.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const defaults = remote.length > 0 ? remote : fallbackModelSuggestions(provider);
  const ids = [];
  if (current) ids.push(current);
  for (const id of defaults) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 40).map((id) => ({
    id,
    desc: id === current
      ? "current · pick thinking next"
      : (remote.length > 0 ? "models route · pick thinking next" : "pick thinking next"),
    hasChildren: true,
  }));
}

function suggestUcodeThinkingLevels(state = {}) {
  return suggestThinkingLevels({ current: currentThinkingLevel(state) });
}

module.exports = {
  applyUcodeModelCommand,
  suggestUcodeModels,
  suggestUcodeThinkingLevels,
  listUcodeModels,
  fallbackModelSuggestions,
  currentThinkingLevel,
  persistThinkingLevel,
};

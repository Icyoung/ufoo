"use strict";

/**
 * Ucode thinking-intensity levels.
 *
 * Used as the secondary `/model <id> <level>` menu after picking a model.
 * Maps to Anthropic extended-thinking budget_tokens and OpenAI-compatible
 * reasoning_effort where the transport supports it.
 */

const THINKING_LEVELS = Object.freeze([
  {
    id: "off",
    desc: "disable extended thinking",
    budgetTokens: 0,
    reasoningEffort: "",
  },
  {
    id: "low",
    desc: "light thinking",
    budgetTokens: 2048,
    reasoningEffort: "low",
  },
  {
    id: "medium",
    desc: "default thinking",
    budgetTokens: 10000,
    reasoningEffort: "medium",
  },
  {
    id: "high",
    desc: "deeper thinking",
    budgetTokens: 32000,
    reasoningEffort: "high",
  },
  {
    id: "max",
    desc: "maximum thinking budget",
    budgetTokens: 48000,
    reasoningEffort: "high",
  },
]);

const DEFAULT_THINKING_LEVEL = "medium";
const THINKING_LEVEL_IDS = new Set(THINKING_LEVELS.map((item) => item.id));

function normalizeThinkingLevel(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "none" || raw === "disable" || raw === "disabled" || raw === "0") return "off";
  if (raw === "med" || raw === "default") return "medium";
  if (raw === "maximum" || raw === "xhigh" || raw === "ultra") return "max";
  if (THINKING_LEVEL_IDS.has(raw)) return raw;
  return "";
}

function getThinkingLevel(id = "") {
  const normalized = normalizeThinkingLevel(id) || DEFAULT_THINKING_LEVEL;
  return THINKING_LEVELS.find((item) => item.id === normalized) || THINKING_LEVELS[2];
}

function suggestThinkingLevels(options = {}) {
  const current = normalizeThinkingLevel(options.current || "") || DEFAULT_THINKING_LEVEL;
  return THINKING_LEVELS.map((item) => ({
    id: item.id,
    desc: item.id === current ? `${item.desc} · current` : item.desc,
  }));
}

function resolveThinkingFromEnvAndConfig({
  env = process.env,
  configLevel = "",
} = {}) {
  // Explicit numeric budget still wins (advanced override).
  const rawBudget = env && env.UFOO_UCODE_THINKING_BUDGET_TOKENS;
  if (rawBudget !== undefined && rawBudget !== null && String(rawBudget).trim() !== "") {
    const parsed = Number.parseInt(String(rawBudget), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return {
        level: "off",
        budgetTokens: 0,
        reasoningEffort: "",
        source: "env-budget",
      };
    }
    return {
      level: "",
      budgetTokens: Math.floor(parsed),
      reasoningEffort: "",
      source: "env-budget",
    };
  }

  const fromEnv = normalizeThinkingLevel(env && env.UFOO_UCODE_THINKING);
  const fromConfig = normalizeThinkingLevel(configLevel);
  const level = fromEnv || fromConfig || DEFAULT_THINKING_LEVEL;
  const spec = getThinkingLevel(level);
  return {
    level: spec.id,
    budgetTokens: spec.budgetTokens,
    reasoningEffort: spec.reasoningEffort,
    source: fromEnv ? "env" : (fromConfig ? "config" : "default"),
  };
}

function applyThinkingLevelToEnv(level = "", env = process.env) {
  const normalized = normalizeThinkingLevel(level);
  if (!normalized) return "";
  const spec = getThinkingLevel(normalized);
  try {
    env.UFOO_UCODE_THINKING = spec.id;
    if (spec.budgetTokens > 0) {
      env.UFOO_UCODE_THINKING_BUDGET_TOKENS = String(spec.budgetTokens);
    } else {
      env.UFOO_UCODE_THINKING_BUDGET_TOKENS = "0";
    }
  } catch {
    // ignore env write failures
  }
  return spec.id;
}

module.exports = {
  THINKING_LEVELS,
  THINKING_LEVEL_IDS,
  DEFAULT_THINKING_LEVEL,
  normalizeThinkingLevel,
  getThinkingLevel,
  suggestThinkingLevels,
  resolveThinkingFromEnvAndConfig,
  applyThinkingLevelToEnv,
};

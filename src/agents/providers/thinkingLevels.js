"use strict";

/**
 * Ucode thinking-intensity levels.
 *
 * Used as the secondary `/model <id> <level>` menu after picking a model.
 * Maps to Anthropic effort and OpenAI-compatible reasoning_effort where
 * the transport supports it.
 */

const THINKING_LEVELS = Object.freeze([
  {
    id: "off",
    desc: "disable extended thinking",
    reasoningEffort: "",
  },
  {
    id: "low",
    desc: "light thinking",
    reasoningEffort: "low",
  },
  {
    id: "medium",
    desc: "default thinking",
    reasoningEffort: "medium",
  },
  {
    id: "high",
    desc: "deeper thinking",
    reasoningEffort: "high",
  },
  {
    id: "xhigh",
    desc: "extra high thinking",
    reasoningEffort: "xhigh",
  },
  {
    id: "max",
    desc: "maximum thinking",
    reasoningEffort: "max",
  },
]);

const DEFAULT_THINKING_LEVEL = "medium";
const THINKING_LEVEL_IDS = new Set(THINKING_LEVELS.map((item) => item.id));

function normalizeThinkingLevel(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "none" || raw === "disable" || raw === "disabled" || raw === "0") return "off";
  if (raw === "med" || raw === "default") return "medium";
  if (raw === "maximum" || raw === "ultra") return "max";
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
  const fromEnv = normalizeThinkingLevel(env && env.UFOO_UCODE_THINKING);
  const fromConfig = normalizeThinkingLevel(configLevel);
  const level = fromEnv || fromConfig || DEFAULT_THINKING_LEVEL;
  const spec = getThinkingLevel(level);
  return {
    level: spec.id,
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

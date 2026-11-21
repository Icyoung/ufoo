"use strict";

// Published Standard text-token rates in USD per million tokens.
// https://developers.openai.com/api/docs/pricing
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
const OPENAI_RATES = Object.freeze({
  "gpt-6.2-astra": [8, 0.4],
  "gpt-6.2-sol": [2, 0.1],
  "gpt-6-astra": [10, 1],
  "gpt-6.1-sol": [2, 0.1],
  "gpt-6.1-terra": [1, 0.05],
  "gpt-6-luna": [0.1, 0.01],
});
const CLAUDE_RATES = Object.freeze({
  "claude-opus-5-5": [4, 0.2],
  "claude-opus-5": [5, 0.5],
  "claude-opus-4-8": [5, 0.5],
  "claude-opus-4-7": [5, 0.5],
  "claude-opus-4-6": [5, 0.5],
  "claude-opus-4-5": [5, 0.5],
  "claude-sonnet-5-5": [2, 0.1],
  "claude-sonnet-5": [2, 0.2],
  "claude-sonnet-4-6": [3, 0.3],
  "claude-haiku-5-5": [0.1, 0.01],
  "claude-haiku-4-5": [1, 0.1],
});

function estimateModelInputCost({ channel, model, usage }) {
  const openAI = channel === "openai-responses";
  if (!usage || (!openAI && channel !== "anthropic-messages")) return null;
  const modelName = String(model || "").toLowerCase().replace(/-(?:\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  const rates = (openAI ? OPENAI_RATES : CLAUDE_RATES)[openAI ? modelName : modelName.replace(/\./g, "-")];
  if (!Array.isArray(rates)) return null;
  const { input, cacheRead, cacheCreation, cacheWriteByTtl } = usage;
  if ([input, cacheRead, cacheCreation].some(value => value === null)) return null;
  const shortTtl = openAI ? "30m" : "5m";
  const longTtl = openAI ? "12h" : "1h";
  const shortWrite = cacheWriteByTtl[shortTtl];
  const longWrite = cacheWriteByTtl[longTtl];
  if (cacheCreation > 0 && (shortWrite === null || longWrite === null)) return null;
  if ((shortWrite ?? 0) + (longWrite ?? 0) !== cacheCreation) return null;
  const totalInput = openAI ? input : input + cacheRead + cacheCreation;
  const uncachedInput = openAI ? input - cacheRead - cacheCreation : input;
  if (uncachedInput < 0) return null;
  // Input and cache prices apply this tier to the entire request.
  const multiplier = openAI && totalInput > 272_000 ? 2 : modelName === "claude-haiku-5-5" && totalInput > 100_000 ? 5 : 1;
  const [inputRate, cacheReadRate] = rates;
  return multiplier * (uncachedInput * inputRate + cacheRead * cacheReadRate
    + (shortWrite ?? 0) * inputRate * 1.25 + (longWrite ?? 0) * inputRate * (openAI ? 2.5 : 2)) / 1_000_000;
}

module.exports = { estimateModelInputCost };

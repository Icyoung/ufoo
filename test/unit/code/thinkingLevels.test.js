"use strict";

const {
  normalizeThinkingLevel,
  getThinkingLevel,
  resolveThinkingFromEnvAndConfig,
  suggestThinkingLevels,
  applyThinkingLevelToEnv,
} = require("../../../src/code/thinkingLevels");

describe("thinkingLevels", () => {
  test("normalizes aliases", () => {
    expect(normalizeThinkingLevel("NONE")).toBe("off");
    expect(normalizeThinkingLevel("med")).toBe("medium");
    expect(normalizeThinkingLevel("maximum")).toBe("max");
    expect(normalizeThinkingLevel("nope")).toBe("");
  });

  test("maps levels to budget and reasoning effort", () => {
    expect(getThinkingLevel("off")).toMatchObject({ budgetTokens: 0, reasoningEffort: "" });
    expect(getThinkingLevel("medium")).toMatchObject({ budgetTokens: 10000, reasoningEffort: "medium" });
    expect(getThinkingLevel("high")).toMatchObject({ budgetTokens: 32000, reasoningEffort: "high" });
  });

  test("resolveThinkingFromEnvAndConfig prefers numeric budget override", () => {
    const resolved = resolveThinkingFromEnvAndConfig({
      env: { UFOO_UCODE_THINKING_BUDGET_TOKENS: "4096" },
      configLevel: "high",
    });
    expect(resolved).toMatchObject({
      budgetTokens: 4096,
      source: "env-budget",
    });
  });

  test("resolveThinkingFromEnvAndConfig uses named levels", () => {
    expect(resolveThinkingFromEnvAndConfig({
      env: {},
      configLevel: "low",
    })).toMatchObject({
      level: "low",
      budgetTokens: 2048,
      source: "config",
    });
  });

  test("suggestThinkingLevels marks current", () => {
    const rows = suggestThinkingLevels({ current: "high" });
    expect(rows.find((row) => row.id === "high").desc).toContain("current");
  });

  test("applyThinkingLevelToEnv writes level and budget", () => {
    const env = {};
    expect(applyThinkingLevelToEnv("off", env)).toBe("off");
    expect(env.UFOO_UCODE_THINKING).toBe("off");
    expect(env.UFOO_UCODE_THINKING_BUDGET_TOKENS).toBe("0");
    applyThinkingLevelToEnv("high", env);
    expect(env.UFOO_UCODE_THINKING).toBe("high");
    expect(env.UFOO_UCODE_THINKING_BUDGET_TOKENS).toBe("32000");
  });
});

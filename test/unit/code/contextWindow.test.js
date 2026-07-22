"use strict";

const {
  contextTokensFromUsage,
  resolveModelContextLimit,
  formatTokensK,
  formatContextMeter,
  buildContextMeter,
} = require("../../../src/code/contextWindow");

describe("contextWindow", () => {
  test("sums Anthropic-style exclusive cache fields", () => {
    expect(contextTokensFromUsage({
      input: 1200,
      cacheRead: 800,
      cacheCreation: 300,
    })).toBe(2300);
  });

  test("does not double-count OpenAI cached subset of prompt_tokens", () => {
    expect(contextTokensFromUsage({
      input: 5000,
      cacheRead: 2000,
      cacheCreation: 0,
    })).toBe(5000);
  });

  test("resolves model context limits from id heuristics", () => {
    expect(resolveModelContextLimit("claude-opus-4-6")).toBe(200000);
    expect(resolveModelContextLimit("gpt-4o")).toBe(128000);
    expect(resolveModelContextLimit("gemini-2.5-pro")).toBe(1000000);
    expect(resolveModelContextLimit("kimi-k2.5")).toBe(256000);
    expect(resolveModelContextLimit("moonshot-v1-128k")).toBe(128000);
  });

  test("formats token counts in K", () => {
    expect(formatTokensK(0)).toBe("0");
    expect(formatTokensK(850)).toBe("850");
    expect(formatTokensK(12300)).toBe("12.3K");
    expect(formatTokensK(200000)).toBe("200K");
    expect(formatContextMeter({ usedTokens: 12300, limitTokens: 200000 })).toBe("12.3K / 200K");
  });

  test("buildContextMeter uses last usage occupancy and model limit", () => {
    const meter = buildContextMeter({
      usage: { input: 1500, cacheRead: 500, cacheCreation: 200 },
      model: "claude-sonnet-4-5",
    });
    expect(meter.usedTokens).toBe(2200);
    expect(meter.limitTokens).toBe(200000);
    expect(meter.label).toBe("2.2K / 200K");
  });
});

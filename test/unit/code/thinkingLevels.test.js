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
    expect(normalizeThinkingLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkingLevel("nope")).toBe("");
  });

  test("maps levels to reasoning effort", () => {
    expect(getThinkingLevel("off")).toMatchObject({ reasoningEffort: "" });
    expect(getThinkingLevel("medium")).toMatchObject({ reasoningEffort: "medium" });
    expect(getThinkingLevel("high")).toMatchObject({ reasoningEffort: "high" });
    expect(getThinkingLevel("xhigh")).toMatchObject({ reasoningEffort: "xhigh" });
    expect(getThinkingLevel("max")).toMatchObject({ reasoningEffort: "max" });
  });

  test("obsolete numeric budgets do not override the selected effort", () => {
    const resolved = resolveThinkingFromEnvAndConfig({
      env: { UFOO_UCODE_THINKING_BUDGET_TOKENS: "4096" },
      configLevel: "high",
    });
    expect(resolved).toMatchObject({
      level: "high",
      reasoningEffort: "high",
      source: "config",
    });
  });

  test("resolveThinkingFromEnvAndConfig uses named levels", () => {
    expect(resolveThinkingFromEnvAndConfig({
      env: {},
      configLevel: "low",
    })).toMatchObject({
      level: "low",
      source: "config",
    });
  });

  test("suggestThinkingLevels marks current", () => {
    const rows = suggestThinkingLevels({ current: "high" });
    expect(rows.find((row) => row.id === "high").desc).toContain("current");
    expect(rows.map(row => row.id)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });

  test("persisted named efforts retain xhigh and max", () => {
    for (const level of ["xhigh", "max"]) {
      const env = {};
      applyThinkingLevelToEnv(level, env);
      expect(resolveThinkingFromEnvAndConfig({ env })).toMatchObject({
        level, reasoningEffort: level,
      });
    }
  });

  test.each(["xhigh", "max"])("Responses requests preserve %s on the wire", async (effort) => {
    const { getNativeTransport } = require("../../../src/agents/providers/nativeTransport");
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue(new Response(
      'data: {"type":"response.completed","response":{"output":[]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    ));
    try {
      await getNativeTransport("openai-responses").runTurn({
        url: "https://fixture.test/v1/responses", apiKey: "fixture-key", provider: "codex",
        model: "gpt-6.1-sol", thinkingLevel: effort, messages: [{ role: "user", content: "hello" }], tools: [],
      });
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).reasoning.effort).toBe(effort);
    } finally { mockFetch.mockRestore(); }
  });

  test.each(["medium", "xhigh", "max"])("Opus 5.5 streams thought summaries with %s effort and no manual budget", async (effort) => {
    const { getNativeTransport } = require("../../../src/agents/providers/nativeTransport");
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Checking the code" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture-signature" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "Done" } },
      { type: "message_stop" },
    ];
    const mockFetch = jest.spyOn(global, "fetch").mockResolvedValue(new Response(
      events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    ));
    const thoughtDeltas = [];
    try {
      const result = await getNativeTransport("anthropic-messages").runTurn({
        url: "https://fixture.test/v1/messages", apiKey: "fixture-key",
        model: "claude-opus-5-5", thinkingLevel: effort, messages: [{ role: "user", content: "hello" }], tools: [],
        onThinkingDelta: delta => thoughtDeltas.push(delta),
      });
      const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(payload.output_config).toEqual({ effort });
      expect(JSON.stringify(payload)).not.toContain("budget_tokens");
      expect(thoughtDeltas).toEqual(["Checking the code"]);
      expect(result.text).toBe("Done");
      expect(result.assistantContent[0]).toEqual({ type: "thinking", thinking: "Checking the code", signature: "fixture-signature" });
    } finally { mockFetch.mockRestore(); }
  });

  test("applyThinkingLevelToEnv writes only the named level", () => {
    const env = {};
    expect(applyThinkingLevelToEnv("off", env)).toBe("off");
    expect(env.UFOO_UCODE_THINKING).toBe("off");
    expect(env).toEqual({ UFOO_UCODE_THINKING: "off" });
    applyThinkingLevelToEnv("high", env);
    expect(env.UFOO_UCODE_THINKING).toBe("high");
    expect(env).toEqual({ UFOO_UCODE_THINKING: "high" });
  });
});

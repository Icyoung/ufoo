"use strict";

const { summarizeAgentPerformance } = require("../../../src/coordination/history/agentPerformance");

const time = second => new Date(Date.UTC(2026, 9, 11) + second * 1000).toISOString();
const event = (type, second, extra = {}) => ({ type, time: time(second), taskRunId: "main", taskId: "main", agentId: "ufoo-agent", ...extra });

describe("observed agent performance", () => {
  test("calculates both cache writes at each request's rate before summing the task", () => {
    const completedModel = (id, second, input, cacheWriteByTtl, channel = "openai-responses", model = "gpt-6.2-sol") => [
      event("model.started", second, { modelRequestId: id, model, channel }),
      event("model.completed", second + 1, { modelRequestId: id, model, channel, usage: {
        input, output: 10, cacheRead: 1000, cacheCreation: 1500, cacheWriteByTtl, inputIncludesCache: channel === "openai-responses",
      } }),
    ];
    const report = summarizeAgentPerformance([event("task.started", 0),
      ...completedModel("at-boundary", 1, 272_000, { "30m": 1000, "12h": 500 }),
      ...completedModel("above-boundary", 2, 272_001, { "30m": 1000, "12h": 500 }),
      ...completedModel("claude", 3, 1000, { "5m": 1500, "1h": 0 }, "anthropic-messages", "claude-opus-5-5"),
      event("task.completed", 5)]);
    const [short, long, claude] = report.runs[0].modelRequests;
    expect(short.inputCostUsd).toBeCloseTo(0.5441, 8);
    expect(long.inputCostUsd).toBeCloseTo(1.088204, 8);
    expect(claude.inputCostUsd).toBeCloseTo(0.0117, 8);
    expect(report.summary.completedTaskInputCost.inputCostUsd).toBeCloseTo(1.644004, 8);
    expect(report.runs[0].modelCost.cacheWriteByTtl).toEqual({ "5m": 1500, "1h": 0, "30m": 2000, "12h": 1000 });

    const missing = (details, total = 1500) => {
      const events = completedModel("partial", 1, 5000, details);
      events[1].usage.cacheCreation = total;
      return summarizeAgentPerformance([event("task.started", 0), ...events, event("task.completed", 3)]);
    };
    expect(missing({ "30m": 1000 }).runs[0].modelCost).toMatchObject({ inputCostUsd: null, cacheCreation: 1500 });
    expect(missing({ "30m": 1000, "12h": 400 }).runs[0].modelCost).toMatchObject({ inputCostUsd: null, cacheCreation: 1500 });
    expect(missing({ "30m": 1500, "12h": 0 }).runs[0].modelCost.inputCostUsd).toBeGreaterThan(0);
    expect(missing(undefined, 0).runs[0].modelCost.inputCostUsd).toBeGreaterThan(0);
  });

  test("weights cache hits by prompt tokens and respects OpenAI, Claude and Codex SDK input semantics", () => {
    const model = (run, provider, usage) => [event("task.started", 0, { taskRunId: run }),
      event("run.config", 0, { taskRunId: run, configuration: { provider } }),
      event("model.started", 0, { taskRunId: run, modelScope: provider === "codex" ? "sdk-turn" : "api-call" }),
      event("model.completed", 1, { taskRunId: run, usage }), event("task.completed", 1, { taskRunId: run })];
    const report = summarizeAgentPerformance([
      ...model("openai-small", "openai", { input: 100, cacheRead: 80, cacheCreation: 20, inputIncludesCache: true }),
      ...model("openai-large", "openai", { input: 900, cacheRead: 90, inputIncludesCache: true }),
      ...model("claude", "claude", { input_tokens: 20, cache_read_input_tokens: 70, cache_creation_input_tokens: 10 }),
      ...model("codex", "codex", { input_tokens: 100, cached_input_tokens: 50 }),
    ]);
    expect(report.summary.cache).toMatchObject({ samples: 4, usageSamples: 4, cachedTokens: 290, promptTokens: 1200, hitRate: 290 / 1200 });
    expect(report.cohorts.find(c => c.provider === "openai").cache.hitRate).toBe(0.17);
    expect(report.runs.find(r => r.taskRunId === "claude").cache).toMatchObject({ promptTokens: 100, hitRate: 0.7 });
    expect(report.coverage.runsWithCompleteCache).toBe(4);
  });
  test("cache rate excludes missing, ambiguous and inconsistent fields while preserving partial coverage", () => {
    const report = summarizeAgentPerformance([event("task.started", 0),
      event("model.started", 0), event("model.completed", 1, { usage: { input: 100, output: 10, cacheRead: null, inputIncludesCache: true } }),
      event("model.started", 1), event("model.completed", 2, { usage: { input: 100, cacheRead: 40, inputIncludesCache: true } }),
      event("context.select.completed", 2, { latencyMs: 12, mode: "tier1_local" }), event("task.completed", 3)]);
    expect(report.summary.cache).toEqual({ samples: 1, usageSamples: 2, cachedTokens: 40, promptTokens: 100, hitRate: 0.4 });
    expect(report.summary.counts.contextSelections).toBe(1);
    expect(report.coverage).toMatchObject({ runsWithCompleteUsage: 1, runsWithCache: 1, runsWithCompleteCache: 0 });
    const observe = usage => summarizeAgentPerformance([event("task.started", 0), event("model.completed", 1, { usage })]).summary.cache.hitRate;
    expect(observe({ input: 100, cacheRead: 0, inputIncludesCache: true })).toBe(0);
    expect(observe({ input: 100, cacheRead: 0 })).toBeNull();
    expect(observe({ input: 100, cacheRead: 101, inputIncludesCache: true })).toBeNull();
  });
  test("counts actual executions and SDK turns separately; completion never implies acceptance", () => {
    const worker = (type, second, extra = {}) => event(type, second, { taskRunId: "worker", taskId: "child", agentId: "codex:worker", ...extra });
    const report = summarizeAgentPerformance([
      event("request.accepted", 0), event("task.started", 1),
      event("run.config", 1, { configuration: { provider: "kimi", model: "test", thinkingLevel: "high", executionKind: "native", runtimeVersion: "4" } }),
      event("model.started", 1, { turnId: "a", modelScope: "api-call" }),
      event("thinking.delta", 2, { textCharacters: 2 }), event("message.delta", 3, { textCharacters: 8 }),
      event("model.completed", 4, { turnId: "a", durationMs: 3000, usage: { input: 10, output: 2 } }),
      event("tool.started", 4, { toolCallId: "first", toolName: "read", argumentFingerprint: "same" }),
      event("tool.completed", 5, { toolCallId: "first", ok: false, resultCode: "invalid_arguments" }),
      event("model.retry", 5, { code: "empty_response" }), event("model.started", 5, { turnId: "b", modelScope: "api-call" }),
      event("tool.started", 6, { toolCallId: "second", toolName: "read", argumentFingerprint: "same" }),
      event("tool.completed", 7, { toolCallId: "second", ok: true }),
      event("model.completed", 8, { turnId: "b", durationMs: 3000, usage: { input: 20, output: 3 } }),
      event("task.completed", 9, { usage: { input: 30, output: 5 }, finalTextCharacters: 4 }),
      worker("task.started", 3), worker("run.config", 3, { configuration: { provider: "codex-cli", model: "sdk", executionKind: "sdk" } }),
      worker("model.started", 3, { modelScope: "sdk-turn" }),
      worker("model.completed", 10, { modelScope: "sdk-turn", usage: { input_tokens: 40, output_tokens: 4 } }),
      worker("task.completed", 10, { usage: { input_tokens: 40, output_tokens: 4 }, finalTextCharacters: 10 }),
      worker("report.done", 11, { reportCharacters: 750 }),
    ], [{ taskId: "child", workerId: "codex:worker", status: "reported", report: { phase: "done" } }], [], { now: Date.parse(time(12)), limit: 1 });
    expect(report.summary).toMatchObject({ runs: 2, outcomes: { completed: 2 }, counts: { modelCalls: 2, sdkTurns: 1, toolCalls: 2, toolErrors: 1, repeatedToolCalls: 1, modelRetries: 1 } });
    expect(report.summary.usage.input).toEqual({ samples: 2, sum: 70 });
    expect(report.summary.latency.firstTextMs).toMatchObject({ samples: 1, p50: 2000 });
    expect(report.summary.latency.queueMs.p50).toBe(1000);
    expect(report.delegations).toMatchObject({ accepted: 0, reported: 1, awaitingAcceptance: 1, acceptedOfReviewed: null });
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({ agentId: "codex:worker", signals: ["long_report"], timings: { modelMs: 7000 } });
    expect(report.cohorts).toHaveLength(2);
  });

  test("resumption and duplicate presentation lifecycles preserve one run and separate user waiting", () => {
    const report = summarizeAgentPerformance([
      event("task.started", 0, { attemptId: "first" }), event("task.started", 0, { attemptId: "first" }),
      event("task.paused", 2), event("interaction.answered", 6), event("task.started", 7, { attemptId: "second" }),
      event("task.completed", 10),
    ], [], [], { now: Date.parse(time(11)) });
    expect(report.summary.runs).toBe(1);
    expect(report.runs[0]).toMatchObject({ attempts: 2, status: "completed", timings: { elapsedMs: 10000, activeMs: 5000, waitingUserMs: 5000, firstTextMs: null, queueMs: null } });
  });

  test("time filters select starts without clipping the end or accepting missing history as zero latency", () => {
    const events = [event("task.started", 1), event("task.completed", 10), event("task.completed", 11, { taskRunId: "partial" })];
    const selected = summarizeAgentPerformance(events, [], [], { since: time(1), until: time(2) });
    expect(selected.summary.runs).toBe(1);
    expect(selected.runs[0].timings.elapsedMs).toBe(9000);
    const all = summarizeAgentPerformance(events);
    expect(all.incomplete).toBe(true);
    expect(all.runs.find(r => r.taskRunId === "partial").timings.elapsedMs).toBeNull();
    expect(all.summary.latency.elapsedMs.samples).toBe(1);
    expect(all.coverage.runsWithConfiguration).toBe(0);
    expect(() => summarizeAgentPerformance(events, [], [], { since: "bad" })).toThrow("ISO timestamp");
    expect(() => summarizeAgentPerformance(events, [], [], { since: time(2), until: time(1) })).toThrow("after until");
  });

  test("tracks context selection and window projection metrics, exposes queue age, and identifies idle execution without grading it", () => {
    const report = summarizeAgentPerformance([
      event("task.started", 0), event("model.completed", 1, { usage: { input: 50, output: 1 } }),
      event("context.select.completed", 2, { latencyMs: 15, mode: "tier1_local" }),
      event("context.window.projected", 2, { evictionLevel: 2 }),
      event("tool.rejected", 3, { toolCallId: "invalid", toolName: "ask_user", code: "invalid_batch" }),
      event("loop.warning", 4), event("loop.stopped", 5),
    ], [], [{ state: "pending", enqueuedAt: time(1) }], { now: Date.parse(time(1000)) });
    expect(report.summary.usage.input.sum).toBe(50);
    expect(report.summary.counts).toMatchObject({ contextSelections: 1, windowProjections: 1, maxEvictionLevel: 2 });
    expect(report.runs[0]).toMatchObject({ counts: { toolCalls: 0, toolRejections: 1, unresolvedTools: 0, loopStops: 1, maxEvictionLevel: 2 }, errorCodes: { invalid_batch: 1 } });
    expect(report.runs[0].signals).toContain("running_without_recent_events");
    expect(report.runs[0].timings.contextSelectMs).toBe(15);
    expect(report.queues[0].ageMs).toBe(999000);
  });

  test("empty observations and uncorrelated historical events remain unknown", () => {
    const empty = summarizeAgentPerformance([]);
    expect(empty.summary.completedOfFinished).toBeNull();
    expect(empty.summary.usage.input.sum).toBeNull();
    expect(empty.summary.latency.elapsedMs.p50).toBeNull();
    const incomplete = summarizeAgentPerformance([{ type: "tool.started", time: time(1) }], [], [], { warnings: [{ code: "source_tail_truncated" }] });
    expect(incomplete.incomplete).toBe(true);
    expect(incomplete.coverage.uncorrelatedEvents).toBe(1);
    expect(incomplete.warnings).toHaveLength(2);
  });
  test("a native zero-filled terminal accumulator cannot make missing model usage look observed", () => {
    const report = summarizeAgentPerformance([event("task.started", 1), event("model.started", 1),
      event("model.completed", 2, { usage: {} }), event("task.completed", 2, { usage: { input: 0, output: 0 } })]);
    expect(report.summary.usage.input.sum).toBeNull();
    expect(report.coverage).toMatchObject({ runsWithUsage: 0, runsWithCompleteUsage: 0 });
  });
  test("partial usage stays partial and an exception preserves uncertainty about a tool's side effects", () => {
    const report = summarizeAgentPerformance([event("task.started", 0), event("model.started", 0), event("model.completed", 1, { usage: {} }),
      event("model.started", 1), event("model.completed", 2, { usage: { input: 10, output: 1 } }),
      event("tool.started", 2, { toolCallId: "broken", toolName: "bash" }), event("tool.failed", 3, { toolCallId: "broken", outcome: "unknown" }), event("task.failed", 3)]);
    expect(report.summary.usage.input.sum).toBe(10);
    expect(report.coverage).toMatchObject({ runsWithUsage: 1, runsWithCompleteUsage: 0 });
    expect(report.runs[0].counts).toMatchObject({ toolExceptions: 1, toolErrors: 0, unresolvedTools: 1 });
  });
});

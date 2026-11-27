"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createTurnIndexStore } = require("../../../src/agents/runtime/context/turnIndexStore");
const { createSlidingWindowManager } = require("../../../src/agents/runtime/context/slidingWindowManager");
const { backfillMissingTurns } = require("../../../src/agents/runtime/context/turnAnalyzer");
const { replayHistory } = require("../../../src/agents/runtime/context/replayHistory");
const { historyUnits } = require("../../../src/agents/runtime/context/contextBudget");

const pair = (text) => [{ role: "user", content: text }, { role: "assistant", content: `reply ${text}` }];
const batch = (provider, content, id = "call1") => provider === "openai" ? [
  { role: "assistant", tool_calls: [{ id, type: "function", function: { name: "read", arguments: '{"path":"large.txt"}' } }] },
  { role: "tool", tool_call_id: id, content },
] : [
  { role: "assistant", content: [
    { type: "thinking", thinking: "reasoning", signature: "signed" },
    { type: "tool_use", id, name: "read", input: { path: "large.txt" } },
  ] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: content }] }] },
];

describe("context eviction regressions", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-context-regression-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const makeStore = () => createTurnIndexStore({ workspaceRoot: root, namespace: "ucode", sessionId: "regression" });

  test("keeps an existing unversioned strategy on legacy even in an isolated call", async () => {
    const store = makeStore();
    store.saveWindowState({ anchorTurnId: "old" });
    const manager = createSlidingWindowManager({ turnIndexStore: store, policy: { cacheStrategy: "stable-prefix" } });
    const messages = [{ role: "user", content: "continue" }];
    expect(manager.strategyVersion()).toBe(1);
    for (const isolated of [true, false]) {
      const result = await manager.prepare({ messages, historyOffset: 0, turnSupplement: "new evidence", isolated });
      expect(result.meta.strategyVersion).toBe(1);
      expect(result.messages).toEqual(messages);
    }
    expect(store.loadWindowState().supplements).toEqual([]);
  });

  test("keeps the latest tool output intact between the stable-prefix soft and hard limits", async () => {
    const manager = createSlidingWindowManager({ policy: { cacheStrategy: "stable-prefix", contextWindowTokens: 8000, outputReserveTokens: 1000 } });
    const messages = [{ role: "user", content: "inspect" }, ...batch("openai", "x".repeat(18000))];
    const result = await manager.prepare({ messages, historyOffset: 0 });
    expect(result.messages).toEqual(messages);
    expect(result.estimatedTokens).toBeGreaterThan(5950);
    expect(result.estimatedTokens).toBeLessThanOrEqual(7000);
  });

  test("preserves authored context tags, replays generated context and pins the stable-prefix strategy across reload", async () => {
    const store = makeStore();
    const manager = createSlidingWindowManager({ turnIndexStore: store, policy: { cacheStrategy: "stable-prefix", contextWindowTokens: 8000, outputReserveTokens: 1000 } });
    const unmodified = "Preserve <turn_context>only staging</turn_context> exactly.";
    const messages = [{ role: "user", content: unmodified }];
    const first = await manager.prepare({ messages, turnId: "authored", historyOffset: 0, turnSupplement: "generated historical context" });
    expect(first.messages[0].content).toBe(`generated historical context\n\n${unmodified}`);
    expect(messages[0].content).toBe(unmodified);
    store.upsertTurn({ turnId: "authored", historyOffset: 0, historyEnd: 2, rawUserText: unmodified });
    const reloaded = createSlidingWindowManager({ turnIndexStore: store });
    const next = await reloaded.prepare({ messages: [...messages, { role: "assistant", content: "reply" }, { role: "user", content: "Next" }],
      turnId: "next", historyOffset: 2, turnSupplement: "New evidence" });
    expect(next.meta.strategyVersion).toBe(2);
    expect(next.messages[0].content).toBe(first.messages[0].content);
    expect(next.messages.at(-1).content).toBe("New evidence\n\nNext");
  });

  test("counts Chat system instructions once and only uses official limits at the official endpoint", async () => {
    const manager = createSlidingWindowManager({ policy: { outputReserveTokens: 1000 } });
    const systemPrompt = "long system message".repeat(300);
    const chat = await manager.prepare({ systemPrompt, historyOffset: 1, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: "go" }], transport: { name: "openai-chat" } });
    expect(chat.estimatedTokens).toBeLessThan(2500);
    const limits = url => manager.prepare({ model: "gpt-6.2-sol", transport: { name: "openai-responses" }, request: { url } });
    expect((await limits("https://api.openai.com/v1/responses")).meta).toMatchObject({ contextWindow: 1_050_000, hardInputLimit: 922_000 });
    expect((await limits("https://proxy.invalid/v1/responses")).meta).toMatchObject({ contextWindow: 200_000, hardInputLimit: 199_000 });
  });

  test("stable-prefix compacts complete turns toward 60% and retains the new boundary on the next turn", async () => {
    const store = makeStore();
    const policy = { cacheStrategy: "stable-prefix", contextWindowTokens: 8000, outputReserveTokens: 1000 };
    const history = [];
    for (let index = 0; index < 4; index++) {
      const offset = history.length;
      history.push({ role: "user", content: `retained-source-${index}` }, ...batch("openai", "z".repeat(3300), `call-${index}`));
      store.upsertTurn({ turnId: `turn-${index}`, historyOffset: offset, historyEnd: history.length,
        rawUserText: history[offset].content, userSummary: history[offset].content });
    }
    const rawHistory = JSON.stringify(history);
    const manager = createSlidingWindowManager({ turnIndexStore: store, policy });
    const current = { role: "user", content: "checks ".repeat(620) };
    const projected = await manager.prepare({ messages: [...history, current], historyOffset: history.length, turnId: "compacting" });
    expect(projected.meta.compressionReason).toBe("input_budget");
    expect(projected.estimatedTokens).toBeLessThan(4700);
    expect(historyUnits(projected.messages).every(unit => unit.complete)).toBe(true);
    expect(store.loadWindowState().firstRetainedOffset).toBeGreaterThan(0);
    const anchor = store.loadWindowState().firstRetainedOffset;
    expect(JSON.stringify(history)).toBe(rawHistory);
    const next = await manager.prepare({ messages: [...history, { role: "user", content: "next short task" }], historyOffset: history.length, turnId: "next" });
    expect(store.loadWindowState().firstRetainedOffset).toBe(anchor);
    expect(next.messages[0]).toEqual(history[anchor]);
  });

  test("keeps required input above the compaction watermark until the hard input limit", async () => {
    const manager = createSlidingWindowManager({ policy: { contextWindowTokens: 8000, outputReserveTokens: 1000 } });
    const prepare = content => manager.prepare({ messages: [{ role: "user", content }], historyOffset: 0 });
    const prompt = "x".repeat(18000);
    const accepted = await prepare(prompt);
    expect(accepted.estimatedTokens).toBeGreaterThan(5950);
    expect(accepted.estimatedTokens).toBeLessThanOrEqual(7000);
    expect(accepted.messages).toEqual([{ role: "user", content: prompt }]);
    await expect(prepare("x".repeat(21000))).rejects.toMatchObject({ code: "context_budget_exceeded" });
  });

  test.each(["openai", "anthropic"])("bounds the latest %s tool result and preserves its compressed prefix in later rounds", async (provider) => {
    const store = makeStore();
    const manager = createSlidingWindowManager({ turnIndexStore: store, policy: { contextWindowTokens: 8000 } });
    const messages = [{ role: "user", content: "read large file" }, ...batch(provider, "X".repeat(30000))];
    const original = JSON.stringify(messages);
    const prepared = await manager.prepare({ messages, historyOffset: 0, turnId: "active" });
    expect(prepared.meta.evictionLevel).toBe(3);
    expect(prepared.estimatedTokens).toBeLessThanOrEqual(5440);
    expect(JSON.stringify(prepared.messages)).toContain("truncated");
    expect(historyUnits(prepared.messages).every((unit) => unit.complete)).toBe(true);
    expect(prepared.messages[1]).toEqual(messages[1]); // tool arguments and thinking signature intact
    expect(JSON.stringify(messages)).toBe(original);

    // Read persisted projection with a new manager, as after rehydrating a paused runner.
    const next = await createSlidingWindowManager({ turnIndexStore: store, policy: { contextWindowTokens: 8000 } }).prepare({
      messages: [...messages, ...batch(provider, "small next result", "call2")], historyOffset: 0, turnId: "active",
    });
    expect(next.messages.slice(0, prepared.messages.length)).toEqual(prepared.messages);
    expect(JSON.stringify(next.messages)).toContain("small next result");
  });

  test("rejects irreducible oversized input before calling the provider and retains the original transcript", async () => {
    const { createAgentRuntime } = require("../../../src/agents/runtime");
    const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports");
    const runTurn = jest.fn();
    const runtime = createAgentRuntime({
      transport: createOpenAiChatTransport({ resolveUrl: () => "https://isolated.invalid", runTurn }),
      profile: { capabilities: [] }, capabilities: [],
    });
    const prompt = "Y".repeat(30000);
    try {
      const result = await runtime.run({ model: "gpt-4o", prompt,
        contextManager: createSlidingWindowManager({ policy: { contextWindowTokens: 8000 } }) });
      expect(runTurn).not.toHaveBeenCalled();
      expect(result.stopReason).toBe("context_budget_exceeded");
      expect(result.messages).toEqual([{ role: "user", content: prompt }]);
    } finally { await runtime.close(); }
  });

  test.each([false, true])("refreshes evicted summaries and freezes the resulting prefix (forced=%s)", async (force) => {
    const store = makeStore();
    const history = [];
    for (let i = 0; i < 5; i += 1) {
      history.push({ role: "user", content: `constraint_${i}` }, { role: "assistant", content: "A".repeat(6000) });
      store.upsertTurn({ turnId: `t${i}`, turnIndex: i, historyOffset: i * 2, historyEnd: i * 2 + 2,
        topic: `topic${i}`, userSummary: `constraint_${i}` });
    }
    const manager = createSlidingWindowManager({ turnIndexStore: store, policy: { contextWindowTokens: 8000 } });
    const messages = [...history, { role: "user", content: "continue" }];
    const first = await manager.prepare({ messages, historyOffset: 10, turnId: "active", force });
    expect(first.meta.evictionLevel).toBeGreaterThanOrEqual(1);
    expect(first.meta.rawTurnCount).toBeLessThanOrEqual(2);
    expect(first.messages.at(-1).content).toContain("constraint_0");
    expect(first.messages.at(-1).content).toContain(`off_window_turns="${5 - first.meta.rawTurnCount}"`);
    const state = store.loadWindowState();
    expect(state.anchorTurnId).toBe(state.keptTurnIds[0] || "");
    const next = await manager.prepare({ messages: [...messages, ...batch("openai", "small")], historyOffset: 10, turnId: "active" });
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages);
    expect(next.meta.rawTurnCount).toBe(first.meta.rawTurnCount);
    expect(store.loadWindowState().cachedTurnContext.xml).toBe(state.cachedTurnContext.xml);
  });

  test("rebuilds paused/resumed and failed tasks in exactly the same order and offsets as replay", () => {
    const store = makeStore();
    const events = [
      { type: "request.accepted", taskRunId: "a", request: { text: "a" } },
      { type: "task.completed", taskRunId: "a", result: { messages: pair("a"), historyOffset: 0 } },
      { type: "request.accepted", taskRunId: "b", request: { text: "b" } },
      { type: "task.paused", taskRunId: "b", result: { messages: [...pair("a"), ...pair("b")], historyOffset: 2 } },
      { type: "request.accepted", taskRunId: "c", request: { text: "c" } },
      { type: "task.completed", taskRunId: "c", result: { text: "reply c" } },
      { type: "task.paused", taskRunId: "b", result: { messages: [...pair("a"), ...pair("b")], historyOffset: 2 } },
      { type: "task.completed", taskRunId: "b", result: { messages: [{ role: "system", content: "system" }, ...pair("a"), ...pair("b")], historyOffset: 2 } },
      { type: "request.accepted", taskRunId: "d", request: { text: "d" } },
      { type: "task.failed", taskRunId: "d", error: "connection failed" },
      { type: "request.accepted", taskRunId: "pending", request: { text: "pending" } },
      { type: "task.paused", taskRunId: "pending", result: { messages: pair("pending"), historyOffset: 0 } },
    ];
    store.upsertTurn({ turnId: "b", turnIndex: 1, historyOffset: 6, historyEnd: 8, outcome: "paused" });
    backfillMissingTurns({ store, runtimeEvents: events });
    const replayed = replayHistory(events);
    expect(replayed).toHaveLength(8);
    for (const [index, id] of ["a", "b", "c", "d"].entries()) {
      const turn = store.getTurn(id);
      expect([turn.historyOffset, turn.historyEnd]).toEqual([index * 2, index * 2 + 2]);
      expect(replayed.slice(turn.historyOffset, turn.historyEnd)[0].content).toBe(id);
      expect(turn.rawUserText).toBe(id);
    }
    expect(store.listTurns().map((turn) => turn.turnId)).toEqual(["a", "b", "c", "d"]);
    expect(store.getTurn("b").outcome).toBe("completed");
    expect(store.getTurn("pending")).toBeNull();
    expect(backfillMissingTurns({ store, runtimeEvents: events })).toEqual([]);
  });

  test("recovers the paused turn boundary on interaction resume instead of falling back to offset 0", async () => {
    const { resolveResumedTurnBoundary } = require("../../../src/code/nativeRunner");
    const store = makeStore();
    const history = [];
    for (let i = 0; i < 6; i += 1) {
      const start = history.length;
      history.push({ role: "user", content: `turn_${i}` }, { role: "assistant", content: "B".repeat(5000) });
      store.upsertTurn({
        turnId: `segment-${i}`,
        turnIndex: i,
        historyOffset: start,
        historyEnd: history.length,
        outcome: "completed",
      });
    }
    const pausedStart = history.length;
    history.push(
      { role: "user", content: "run device check" },
      { role: "assistant", tool_calls: [{ id: "ask1", type: "function", function: { name: "ask_user", arguments: "{\"prompt\":\"unlock?\"}" } }] },
    );
    store.upsertTurn({
      turnId: "segment-paused",
      turnIndex: 6,
      historyOffset: pausedStart,
      historyEnd: history.length,
      outcome: "paused",
    });
    const resumedMessages = [
      ...history,
      { role: "tool", tool_call_id: "ask1", content: "{\"text\":\"use simulator\"}" },
    ];

    // Mismatched turnId (e.g. legacy snapshot or decomposed segment pause) must recover the paused turn boundary, not 0.
    const recovered = resolveResumedTurnBoundary({
      turnIndexStore: store,
      effectiveTurnId: "turn_fresh_mismatched",
      nonSystemBase: resumedMessages,
    });
    expect(recovered).toEqual({ offset: pausedStart, turnId: "segment-paused" });

    // With the recovered boundary, slidingWindowManager evicts old turns cleanly instead of throwing context_budget_exceeded.
    const manager = createSlidingWindowManager({ turnIndexStore: store, policy: { contextWindowTokens: 8000 } });
    const projected = await manager.prepare({
      messages: resumedMessages,
      historyOffset: recovered.offset,
      turnId: recovered.turnId,
      resume: true,
    });
    expect(projected.meta.evictionLevel).toBeGreaterThanOrEqual(1);
    expect(projected.estimatedTokens).toBeLessThanOrEqual(8000);

    // Without turnIndexStore, fallback locates the last real user instruction (ignoring tool_result), not offset 0.
    const fallback = resolveResumedTurnBoundary({
      turnIndexStore: null,
      effectiveTurnId: "turn_fresh_mismatched",
      nonSystemBase: resumedMessages,
    });
    expect(fallback).toEqual({ offset: pausedStart, turnId: "turn_fresh_mismatched" });
  });
});

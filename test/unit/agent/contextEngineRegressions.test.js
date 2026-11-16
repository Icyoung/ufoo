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
});

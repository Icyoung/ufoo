"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createContextManager } = require("../../../src/agents/runtime/context/compaction");
const { createCheckpointStore } = require("../../../src/agents/runtime/context/checkpointStore");
const { historyUnits, estimateTextTokens, estimateMessagesTokens, summaryMessage, historyDigest } = require("../../../src/agents/runtime/context/contextBudget");
const { retireMessageImages } = require("../../../src/agents/providers/transports/visionBlocks");
const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports");
const { createOpenAiResponsesTransport, createAnthropicMessagesTransport } = require("../../../src/agents/providers/transports");
const { createAgentRuntime } = require("../../../src/agents/runtime");

const policy = { limitTokens: 1000000, maxMessages: 6, keepRecentUnits: 2, batchTokens: 1800 };
function fixture(options = {}) {
  let checkpoint = null;
  const batches = [];
  const store = options.store || { load: () => checkpoint, commit: jest.fn((next, batch, version) => {
    if ((checkpoint?.version || 0) !== version) return false;
    checkpoint = next; batches.push(batch); return true;
  }) };
  const runTurn = options.runTurn || jest.fn(async () => ({ text: "决定：保留原始证据。待办：继续验证。", toolCalls: [] }));
  const transport = createOpenAiChatTransport({ resolveUrl: () => "https://isolated.invalid", runTurn,
    normalizeToolName: name => name, normalizeToolCallArgs: JSON.parse, toJsonString: JSON.stringify, clipText: value => value });
  const manager = createContextManager({ store, policy: { ...policy, ...options.policy }, now: options.now });
  const input = messages => ({ messages, model: "isolated", transport, request: { url: "https://isolated.invalid" } });
  return { manager, input, store, batches, runTurn, transport, checkpoint: () => checkpoint };
}
const history = (count = 24) => Array.from({ length: count }, (_, i) => ({ role: "assistant", content: `证据 ${i}: ` + "x".repeat(900) }));

describe("shared context checkpointing", () => {
  test("commits only complete source batches actually supplied to the summarizer", async () => {
    const f = fixture();
    const source = history();
    const result = await f.manager.prepare(f.input(source));
    expect(f.batches.length).toBeGreaterThan(1);
    let covered = 0;
    for (let i = 0; i < f.batches.length; i++) {
      const request = f.runTurn.mock.calls[i][0];
      const prompt = JSON.parse(request.messages.at(-1).content);
      expect(prompt.messages).toEqual(f.batches[i]);
      expect(prompt.sourceStart).toBe(covered + 1);
      expect(prompt.sourceEnd).toBe(covered + f.batches[i].length);
      expect(request).toMatchObject({ tools: [], maxOutputTokens: 2048, thinkingLevel: "low", systemBlocks: null });
      covered = prompt.sourceEnd;
    }
    expect(result.coveredCount).toBe(covered);
    expect(result.messages.slice(1)).toEqual(source.slice(covered));
    expect(source).toHaveLength(24);
    expect(f.batches.flat()).toEqual(source.slice(0, covered));
  });

  test("preserves multiline user requirements verbatim independently of model summary", async () => {
    const f = fixture();
    const goal = "修复登录界面\n接口字段保持原样：session_nonce 保留现有命名。\n验收：移动端和桌面端都能登录。";
    const source = [{ role: "user", content: goal }, ...history(19)];
    const result = await f.manager.prepare(f.input(source));
    expect(result.checkpoint.instructions).toContain(goal);
    expect(JSON.parse(result.messages[0].content.split("\n").slice(1).join("\n")).userInstructionsChronological).toContain(goal);
    expect(result.messages[0].content).toContain("session_nonce");
  });

  test("tool-call batches stay atomic, including multi-call and Anthropic formats", () => {
    const openai = [{ role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
      { role: "tool", tool_call_id: "a", content: "one" }, { role: "tool", tool_call_id: "b", content: "two" }];
    const anthropic = [{ role: "assistant", content: [{ type: "tool_use", id: "c" }, { type: "tool_use", id: "d" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "three" }, { type: "tool_result", tool_use_id: "d", content: "four" }] }];
    expect(historyUnits([...openai, ...anthropic]).map(unit => [unit.messages.length, unit.complete])).toEqual([[3, true], [2, true]]);
    expect(historyUnits(openai.slice(0, 2))[0].complete).toBe(false);
  });

  test("cannot advance across an unresolved tool call or cut an oversized unit", async () => {
    const f = fixture({ policy: { maxMessages: 2, batchTokens: 1200 } });
    const pending = [{ role: "assistant", tool_calls: [{ id: "pending" }] }, ...history(10)];
    expect((await f.manager.prepare(f.input(pending))).coveredCount).toBe(0);
    expect(f.runTurn).not.toHaveBeenCalled();
    const big = [{ role: "assistant", content: "中".repeat(10000) }, ...history(10)];
    expect((await f.manager.prepare(f.input(big))).messages).toBe(big);
    expect(f.runTurn).not.toHaveBeenCalled();
  });

  test("failed provider or save retains the window and retries the same source after backoff", async () => {
    let clock = 0;
    const runTurn = jest.fn().mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValue({ text: "保留已验证的证据；下一步继续检查。", toolCalls: [] });
    const f = fixture({ runTurn, now: () => clock });
    const source = history(12);
    expect((await f.manager.prepare(f.input(source))).messages).toBe(source);
    expect(f.checkpoint()).toBeNull();
    await f.manager.prepare(f.input(source));
    expect(runTurn).toHaveBeenCalledTimes(1);
    clock = 3000;
    const retried = await f.manager.prepare(f.input(source));
    expect(retried.coveredCount).toBeGreaterThan(0);
    expect(runTurn.mock.calls[0][0].messages).toEqual(runTurn.mock.calls[1][0].messages);
    const saving = fixture({ store: { load: () => null, commit: () => { throw new Error("disk full"); } } });
    expect((await saving.manager.prepare(saving.input(source))).coveredCount).toBe(0);
  });

  test("empty, oversized or tool-calling summaries do not commit", async () => {
    for (const result of [{ text: "" }, { text: "中".repeat(6001) }, { text: "work", toolCalls: [{ function: { name: "bash" } }] }]) {
      const f = fixture({ runTurn: jest.fn(async () => result) });
      const source = history();
      expect((await f.manager.prepare(f.input(source))).messages).toBe(source);
      expect(f.store.commit).not.toHaveBeenCalled();
    }
  });

  test("cancel and timeout reject late provider results without committing", async () => {
    const f = fixture({ runTurn: jest.fn(() => new Promise(() => {})), policy: { timeoutMs: 10 } });
    expect((await f.manager.prepare(f.input(history()))).coveredCount).toBe(0);
    expect(f.store.commit).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    await expect(f.manager.prepare({ ...f.input(history()), signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
  });

  test("single ownership and durable CAS reject an outdated compactor", async () => {
    const f = fixture();
    const source = history();
    await Promise.all([f.manager.prepare(f.input(source)), f.manager.prepare(f.input(source))]);
    const version = f.checkpoint().version;
    await f.manager.prepare(f.input(source));
    expect(f.checkpoint().version).toBe(version);
    expect(f.store.commit({ version: 1 }, [], 0)).toBe(false);
  });

  test("Unicode estimates do not cut characters and hard pressure fails without discarding history", async () => {
    expect(estimateTextTokens("中文😀")).toBeGreaterThan(3);
    const f = fixture({ policy: { limitTokens: 1000, batchTokens: 100, maxMessages: 100 } });
    const source = history();
    await expect(f.manager.prepare(f.input(source))).rejects.toMatchObject({ code: "context_budget_exceeded" });
    expect(source).toHaveLength(24);
    expect(f.store.commit).not.toHaveBeenCalled();
  });

  test("measured token pressure triggers compression below the message threshold", async () => {
    const f = fixture({ policy: { limitTokens: 16000, maxMessages: 100, batchTokens: 4000 } });
    const source = history(12);
    const estimated = estimateMessagesTokens(source) + estimateTextTokens("[]");
    const result = await f.manager.prepare({ ...f.input(source), lastEstimate: estimated, lastUsage: 12000 });
    expect(result.coveredCount).toBeGreaterThan(0);
    expect(result.maxOutputTokens).toBe(3200);
    expect(f.runTurn).toHaveBeenCalled();
  });

  test("summary input excludes image bytes while preserving tool linkage and mixed user text", async () => {
    const bytes = "a".repeat(100000);
    const source = [
      { role: "user", content: [{ type: "text", text: "图中的 session_nonce 不可重命名" }, { type: "image_url", image_url: { url: `data:image/png;base64,${bytes}` } }] },
      { role: "assistant", content: [{ type: "tool_use", id: "vision", name: "read_image", input: { path: "screen.png" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "vision", content: [{ type: "text", text: "path=screen.png" }, { type: "image", source: { type: "base64", media_type: "image/png", data: bytes } }] }] },
      ...history(12),
    ];
    const normalized = source.map(summaryMessage);
    expect(JSON.stringify(normalized)).not.toContain(bytes);
    expect(normalized[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "vision" });
    expect(estimateMessagesTokens(source) - estimateMessagesTokens(normalized)).toBe(4000);
    const retired = JSON.parse(JSON.stringify(source));
    retireMessageImages(retired);
    expect(historyDigest(source)).toBe(historyDigest(retired));
    const f = fixture();
    const result = await f.manager.prepare(f.input(source));
    expect(result.checkpoint.instructions).toContain("图中的 session_nonce 不可重命名");
    expect(JSON.stringify(f.batches)).not.toContain(bytes);
    expect(source[0].content[1].image_url.url).toContain(bytes);
  });

  test("prefix identity accepts restored artifact previews but rejects changed evidence", () => {
    const message = content => [{ role: "tool", tool_call_id: "read-1", content }];
    expect(historyDigest(message(JSON.stringify({ artifactId: "evidence-1", content: "complete body" }))))
      .toBe(historyDigest(message(JSON.stringify({ artifactId: "evidence-1", preview: "preview" }))));
    expect(historyDigest(message(JSON.stringify({ artifactId: "evidence-1" }))))
      .not.toBe(historyDigest(message(JSON.stringify({ artifactId: "evidence-2" }))));
    expect(historyDigest(message("old evidence"))).not.toBe(historyDigest(message("changed evidence")));
  });

  test.each([false, true])("provider overflow gets one compression retry (persistent=%s)", async persistent => {
    let calls = 0;
    const runTurn = jest.fn(async options => {
      if (options.systemPrompt.includes("factual continuity checkpoint")) return { text: "证据已记录，继续当前任务。", toolCalls: [] };
      if (++calls === 1 || persistent) throw Object.assign(new Error("input exceeds the context window"), { code: "context_length_exceeded" });
      return { text: "已完成", toolCalls: [] };
    });
    const f = fixture({ runTurn, policy: { maxMessages: 100 } });
    const runtime = createAgentRuntime({ transport: f.transport, profile: { capabilities: [] }, capabilities: [] });
    try {
      const result = await runtime.run({ model: "isolated", prompt: "继续任务", systemPrompt: "原始规则", historyMessages: history(12), contextManager: f.manager });
      expect(calls).toBe(2);
      expect(f.batches.length).toBe(1);
      expect(result.messages.filter(message => message.role !== "system")).toHaveLength(persistent ? 13 : 14);
      expect(result.messages.at(-1).content).toBe(persistent ? "继续任务" : "已完成");
      expect(result.stopReason || "").toBe(persistent ? "context_budget_exceeded" : "");
    } finally { await runtime.close(); }
  });

  test("overflow with too little compressible history stops without repeating the request", async () => {
    const runTurn = jest.fn().mockRejectedValue(Object.assign(new Error("prompt is too long"), { code: "context_length_exceeded" }));
    const f = fixture({ runTurn });
    const runtime = createAgentRuntime({ transport: f.transport, profile: { capabilities: [] }, capabilities: [] });
    try {
      const result = await runtime.run({ model: "isolated", prompt: "保留这条请求", contextManager: f.manager });
      expect(result.stopReason).toBe("context_budget_exceeded");
      expect(result.messages).toEqual([{ role: "user", content: "保留这条请求" }]);
      expect(runTurn).toHaveBeenCalledTimes(1);
    } finally { await runtime.close(); }
  });

  test("cancelling compression retains already executed tool results for the host to persist", async () => {
    const controller = new AbortController();
    let steps = 0;
    const runTurn = jest.fn(async options => {
      if (options.systemPrompt.includes("factual continuity checkpoint")) {
        controller.abort();
        return { text: "late checkpoint", toolCalls: [] };
      }
      return { text: "", toolCalls: [{ id: `inspect-${++steps}`, type: "function",
        function: { name: "inspect", arguments: JSON.stringify({ step: steps }) } }] };
    });
    const f = fixture({ runTurn, policy: { maxMessages: 3, keepRecentUnits: 1 } });
    const handler = jest.fn(() => ({ ok: true, content: "已验证的证据" }));
    const cap = { id: "inspect", version: "1", tools: [{ name: "inspect", description: "Inspect evidence",
      inputSchema: { type: "object" }, permissions: ["inspect"], handler }] };
    const runtime = createAgentRuntime({ transport: f.transport, profile: { capabilities: ["inspect"] }, capabilities: [cap],
      host: { grantedPermissions: ["inspect"] } });
    try {
      const result = await runtime.run({ model: "isolated", prompt: "验证任务", contextManager: f.manager, signal: controller.signal });
      expect(result.stopReason).toBe("cancelled");
      expect(handler).toHaveBeenCalledTimes(2);
      expect(result.turnItems).toHaveLength(4);
      expect(historyUnits(result.messages).every(unit => unit.complete)).toBe(true);
      expect(f.store.commit).not.toHaveBeenCalled();
    } finally { await runtime.close(); }
  });

  test("checkpoint/source archive survives reload and never applies to a changed prefix", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-checkpoint-"));
    try {
      const store = createCheckpointStore({ workspaceRoot: root, sessionId: "resume-test" });
      const f = fixture({ store });
      const source = history();
      const first = await f.manager.prepare(f.input(source));
      expect(store.archive()).toEqual(source.slice(0, first.coveredCount));
      const restored = fixture({ store });
      const next = await restored.manager.prepare(restored.input([...source, { role: "user", content: "继续" }]));
      expect(next.messages[0].content).toContain(first.checkpoint.summary);
      expect(restored.runTurn).not.toHaveBeenCalled();
      const changed = [{ role: "user", content: "新会话目标" }, ...history(3)];
      expect((await restored.manager.prepare(restored.input(changed))).messages).toBe(changed);
      const before = store.load();
      fs.appendFileSync(store.file, '{"interrupted":');
      expect(store.load()).toEqual(before);
      expect(store.commit({ ...before, version: before.version + 1 }, [], before.version)).toBe(true);
      expect(store.load().version).toBe(before.version + 1);
      store.remove();
      expect(fs.existsSync(store.file)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test.each(["chat", "responses", "anthropic"])("%s compresses during a live task without losing tools or the canonical transcript", async kind => {
    let turns = 0;
    const runTurn = jest.fn(async options => {
      if (!options.tools.length) return { text: "已读取证据，保留 task_key 字段；继续完成任务。", toolCalls: [] };
      turns++;
      if (turns > 10) return { text: "已完成", toolCalls: [] };
      const id = `step-${turns}`;
      const args = { step: turns };
      return kind === "anthropic"
        ? { text: "", assistantContent: [{ type: "tool_use", id, name: "inspect", input: args }], toolCalls: [{ id, name: "inspect", args }], usage: { input: 100 } }
        : { text: "", toolCalls: [{ id, type: "function", function: { name: "inspect", arguments: JSON.stringify(args) } }], usage: { input: 100 } };
    });
    const deps = { resolveUrl: () => "https://isolated.invalid", runTurn, toJsonString: JSON.stringify,
      clipText: value => value, normalizeToolName: value => value, normalizeToolCallArgs: JSON.parse };
    const transport = kind === "anthropic" ? createAnthropicMessagesTransport(deps)
      : kind === "responses" ? createOpenAiResponsesTransport(deps) : createOpenAiChatTransport(deps);
    const handler = jest.fn(() => ({ ok: true, content: "证据：" + "x".repeat(1200) }));
    const cap = { id: "inspect", version: "1", tools: [{ name: "inspect", description: "Inspect evidence",
      inputSchema: { type: "object", properties: { step: { type: "number" } } }, permissions: ["inspect"], handler }] };
    const events = [];
    const runtime = createAgentRuntime({ transport, profile: { capabilities: ["inspect"] }, capabilities: [cap], host: { grantedPermissions: ["inspect"] } });
    const result = await runtime.run({ model: "test", baseUrl: "https://isolated.invalid", prompt: "处理任务\ntask_key 保持原样", systemPrompt: "原始系统规则",
      contextManager: createContextManager({ policy: { ...policy, maxMessages: 10, batchTokens: 2500 } }), onEvent: event => events.push(event) });
    expect(result.finalText).toBe("已完成");
    expect(handler).toHaveBeenCalledTimes(10);
    expect(result.toolCallsExecuted).toBe(10);
    expect(result.usage.turns).toBe(11);
    expect(result.messages.filter(message => message.role !== "system")).toHaveLength(22);
    expect(historyUnits(result.messages.filter(message => message.role !== "system")).every(unit => unit.complete)).toBe(true);
    expect(events.some(event => event.type === "context.compaction.completed")).toBe(true);
    const businessCalls = runTurn.mock.calls.filter(([request]) => request.tools.length);
    expect(JSON.stringify(businessCalls.at(-1)[0].messages)).toContain("task_key");
    expect(JSON.stringify(result.turnItems)).not.toContain("Session continuity");
    expect(result.turnItems).toHaveLength(21);
  });
});

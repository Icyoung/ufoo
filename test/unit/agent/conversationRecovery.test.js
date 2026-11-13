"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAgentRuntime } = require("../../../src/agents/runtime");
const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports");
const { createSessionJournal } = require("../../../src/agents/runtime/context/sessionJournal");

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-conversation-recovery-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fixture(runTurn, handler, transportOverrides = {}) {
  const journal = createSessionJournal({ namespace: "recovery-test" });
  const commit = update => {
    const saved = journal.appendTurnMessages(root, "session", "invocation", update.turnItems, { scope: "output" });
    if (!saved.ok) throw new Error(saved.error);
  };
  const transport = { ...createOpenAiChatTransport({ resolveUrl: () => "https://isolated.invalid", runTurn,
    normalizeToolName: name => name, normalizeToolCallArgs: JSON.parse, toJsonString: JSON.stringify, clipText: value => value }), ...transportOverrides };
  const execute = jest.fn(handler || (args => { fs.writeFileSync(path.join(root, args.path), args.content); return { ok: true }; }));
  const runtime = createAgentRuntime({ transport, capabilities: [{ id: "files", version: "1", tools: [{ name: "write",
    inputSchema: { type: "object", required: ["path", "content"] }, handler: execute }] }] });
  const run = options => runtime.run({ model: "isolated", prompt: "写入文件后确认", onConversationUpdate: commit, ...options });
  return { journal, runtime, run, commit, execute };
}
const toolTurn = (id = "write-once") => ({ text: "", toolCalls: [{ id, function: { name: "write", arguments: '{"path":"done.txt","content":"saved"}' } }] });

test("completed tools are committed before a later request fails and continuation uses those results", async () => {
  let f;
  const provider = jest.fn().mockResolvedValueOnce(toolTurn()).mockImplementationOnce(async () => {
    expect(f.journal.loadJournal(root, "session").events).toHaveLength(2);
    throw Object.assign(new Error("network disconnected"), { code: "ECONNRESET" });
  }).mockResolvedValueOnce({ text: "已完成", toolCalls: [] });
  f = fixture(provider);
  let failure;
  try { await f.run(); } catch (error) { failure = error; }
  expect(failure.result.turnItems).toHaveLength(2);
  expect(failure.result.turnItems[1]).toMatchObject({ role: "tool", tool_call_id: "write-once" });
  expect(fs.readFileSync(path.join(root, "done.txt"), "utf8")).toBe("saved");
  const result = await f.run({ prompt: "继续", historyMessages: failure.result.messages, onConversationUpdate: null });
  expect(result.finalText).toBe("已完成");
  expect(provider.mock.calls[2][0].messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: "tool", tool_call_id: "write-once" }),
  ]));
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test("cancellation after a complete batch retains its committed history", async () => {
  const controller = new AbortController();
  const provider = jest.fn().mockResolvedValue(toolTurn());
  const f = fixture(provider);
  await expect(f.run({ signal: controller.signal, onConversationUpdate: update => { f.commit(update); controller.abort(); } }))
    .rejects.toMatchObject({ code: "cancelled", result: { turnItems: expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "write-once" }),
    ]) } });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.journal.loadJournal(root, "session").events).toHaveLength(2);
});

test("persistence failure stops before another model request", async () => {
  const provider = jest.fn().mockResolvedValue(toolTurn());
  const f = fixture(provider);
  await expect(f.run({ onConversationUpdate: () => { throw new Error("disk full"); } })).rejects.toThrow("disk full");
  expect(provider).toHaveBeenCalledTimes(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

test("cancellation immediately after the final tool result commits that completed batch", async () => {
  const controller = new AbortController();
  const provider = jest.fn().mockResolvedValue(toolTurn());
  const f = fixture(provider);
  await expect(f.run({ signal: controller.signal, onEvent: event => {
    if (event.type === "tool.completed") controller.abort();
  } })).rejects.toMatchObject({ code: "cancelled", result: { turnItems: expect.arrayContaining([
    expect.objectContaining({ role: "tool", tool_call_id: "write-once" }),
  ]) } });
  expect(f.journal.loadJournal(root, "session").events).toHaveLength(2);
  expect(provider).toHaveBeenCalledTimes(1);
});

test("an interrupted batch exposes its ledger without adding unpaired calls to completed history", async () => {
  const provider = jest.fn().mockResolvedValueOnce(toolTurn("completed")).mockResolvedValueOnce(toolTurn("uncertain"));
  const f = fixture(provider, args => {
    if (f.execute.mock.calls.length === 2) throw new Error("lost tool response");
    return { ok: true };
  });
  let failure;
  try { await f.run(); } catch (error) { failure = error; }
  expect(failure.result.turnItems).toHaveLength(2);
  expect(failure.result.protocolLedger.calls.uncertain.state).toBe("executing");
  expect(f.journal.loadJournal(root, "session").events).toHaveLength(2);
  expect(f.execute).toHaveBeenCalledTimes(2);
});

test("final writes do not duplicate already committed tool batches", async () => {
  const provider = jest.fn().mockResolvedValueOnce(toolTurn()).mockResolvedValueOnce({ text: "确认成功", toolCalls: [] });
  const f = fixture(provider);
  const result = await f.run();
  f.commit(result);
  expect(f.journal.loadJournal(root, "session").events.map(event => event.type)).toEqual([
    "assistant.tool_calls", "tool.result", "assistant.message",
  ]);
});

test("a failed materialization is not attempted again by the exception handler", async () => {
  const appendToolResult = jest.fn(() => { throw new Error("materialization failed"); });
  const f = fixture(jest.fn().mockResolvedValue(toolTurn()), undefined, { appendToolResult });
  let failure;
  try { await f.run(); } catch (error) { failure = error; }
  expect(failure.message).toBe("materialization failed");
  expect(failure.result.protocolLedger.calls["write-once"].state).toBe("resolved");
  expect(failure.result.turnItems).toEqual([]);
  expect(appendToolResult).toHaveBeenCalledTimes(1);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

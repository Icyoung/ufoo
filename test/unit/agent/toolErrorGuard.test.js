"use strict";

const { ToolErrorGuard } = require("../../../src/agents/runtime/core/toolErrorGuard");
const { runAgentLoop } = require("../../../src/agents/runtime/core/agentLoop");
const { createOpenAiChatTransport, createOpenAiResponsesTransport, createAnthropicMessagesTransport } = require("../../../src/agents/providers/transports");
const { historyUnits } = require("../../../src/agents/runtime/context/contextBudget");

function setup({ protocol = "openai", outcomes = [], batchSize = 1, policies = [], summary = "Stopped; inspect the failing command.", toolBudget, signal } = {}) {
  let rounds = 0;
  const requests = [];
  const events = [];
  const execute = jest.fn(async () => ({ ok: outcomes.length ? outcomes.shift() : false, error: "test failure" }));
  const runTurn = jest.fn(async (request) => {
    requests.push(JSON.parse(JSON.stringify({ tools: request.tools, messages: request.messages })));
    if (!request.tools.length) {
      if (summary instanceof Error) throw summary;
      return typeof summary === "object" ? summary : { text: summary, toolCalls: [] };
    }
    rounds++;
    if (rounds > 60) return { text: "done", toolCalls: [] };
    const calls = Array.from({ length: batchSize }, (_, n) => protocol === "anthropic"
      ? { id: `c${rounds}_${n}`, name: "probe", args: { round: rounds, n } }
      : { id: `c${rounds}_${n}`, type: "function", function: { name: "probe", arguments: JSON.stringify({ round: rounds, n }) } });
    return { text: "", toolCalls: calls, ...(protocol === "anthropic" ? { assistantContent: calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.args })) } : {}) };
  });
  const make = protocol === "anthropic" ? createAnthropicMessagesTransport : protocol === "responses" ? createOpenAiResponsesTransport : createOpenAiChatTransport;
  const transport = make({ resolveUrl: () => "https://test.invalid", runTurn, normalizeToolName: n => n, normalizeToolCallArgs: JSON.parse, toJsonString: JSON.stringify, clipText: x => x });
  return { execute, requests, events, runTurn, run: () => runAgentLoop({ model: "test", prompt: "test", transport,
    tools: { execute, tightTools: () => [], deferableTools: () => [], toOpenAiTools: () => [{ type: "function", function: { name: "probe" } }] },
    policies, toolBudget, signal, maxRounds: 100, onEvent: e => events.push(e) }) };
}

describe("recoverable tool failure protection", () => {
  test("warns on three consecutive failures and stops on five", () => {
    const guard = new ToolErrorGuard();
    expect([1, 2, 3, 4, 5].map(() => guard.observe(true)?.kind)).toEqual([undefined, undefined, "warn", undefined, "stop"]);
  });

  test("success resets the streak but not rolling failures, and old failures age out", () => {
    const guard = new ToolErrorGuard();
    for (let i = 0; i < 100; i++) expect(guard.observe(i % 2 === 0)?.kind).not.toBe("stop");
    expect(guard.consecutive).toBe(0);
    for (let i = 0; i < 20; i++) guard.observe(false);
    expect(guard.recent.filter(Boolean)).toHaveLength(0);
    expect(guard.observe(true)).toBeNull();
  });

  test("a high configured streak cannot disable the rolling limit", () => {
    const guard = new ToolErrorGuard({ maxToolErrors: 30 });
    let action;
    for (let i = 0; i < 20; i++) action = guard.observe(i % 5 < 3);
    expect(action).toMatchObject({ kind: "stop", consecutiveErrors: 0, recentErrors: 12 });
  });

  test("healthy long runs with more than 20 total errors complete", async () => {
    const fixture = setup({ outcomes: Array.from({ length: 60 }, (_, i) => i % 2 === 1) });
    const result = await fixture.run();
    expect(result.finalText).toBe("done");
    expect(result.error).toBeUndefined();
    expect(fixture.execute).toHaveBeenCalledTimes(60);
    expect(fixture.requests.every((r) => r.tools.length)).toBe(true);
  });

  test("rolling protection stops failures interspersed with successes", async () => {
    const fixture = setup({ outcomes: Array.from({ length: 20 }, (_, i) => i % 5 >= 3) });
    const result = await fixture.run();
    expect(result.stopReason).toBe("tool_error_budget_exceeded");
    expect(result.error).toContain("last 20");
    expect(fixture.execute).toHaveBeenCalledTimes(20);
    expect(fixture.requests).toHaveLength(21);
  });

  test.each(["openai", "responses", "anthropic"])("%s pairs skipped calls and allows only one tool-free closing response", async (protocol) => {
    const continuation = jest.fn(() => true);
    const fixture = setup({ protocol, batchSize: 8, policies: [{ continueAfterFinal: continuation }] });
    const result = await fixture.run();
    expect(fixture.execute).toHaveBeenCalledTimes(5);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1].tools).toEqual([]);
    expect(result.finalText).toContain("Stopped");
    expect(result.stopReason).toBe("tool_error_budget_exceeded");
    expect(continuation).not.toHaveBeenCalled();
    expect(historyUnits(fixture.requests[1].messages).every((u) => u.complete)).toBe(true);
    expect(Object.values(result.protocolLedger.calls)).toHaveLength(8);
    expect(Object.values(result.protocolLedger.calls).every((c) => c.state === "resolved")).toBe(true);
    expect(JSON.stringify(result.messages)).toContain("not executed");
  });

  test.each(["validateBatch", "validateTool"])("%s rejections cannot bypass the error limit", async (hook) => {
    const fixture = setup({ policies: [{ [hook]: () => ({ ok: false, error: "rejected" }) }] });
    const result = await fixture.run();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("tool_error_budget_exceeded");
    expect(result.toolCallsExecuted).toBe(5);
    expect(fixture.requests).toHaveLength(6);
    expect(fixture.requests[3].messages.at(-1).content).toContain("change your approach");
  });

  test.each(["", new Error("summary unavailable"), { text: "", toolCalls: [{ id: "forbidden", function: { name: "probe", arguments: "{}" } }] }])("closing failure or extra tool request cannot resume execution (%j)", async (summary) => {
    const fixture = setup({ toolBudget: { maxToolErrors: 1 }, summary });
    const result = await fixture.run();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.requests).toHaveLength(2);
    expect(result.stopReason).toBe("tool_error_budget_exceeded");
    expect(historyUnits(result.messages).every((u) => u.complete)).toBe(true);
  });

  test("legacy tool commands obey the same limit and cannot execute in the closing response", async () => {
    const fixture = setup({ policies: [{ legacyCommand: () => ({ tool: "probe", args: {}, resultType: "probe_result" }) }] });
    fixture.runTurn.mockImplementation(async ({ tools }) => ({ text: tools.length ? "legacy command" : "stopped", toolCalls: [] }));
    const result = await fixture.run();
    expect(fixture.execute).toHaveBeenCalledTimes(5);
    expect(result.finalText).toBe("stopped");
    expect(result.stopReason).toBe("tool_error_budget_exceeded");
  });

  test("fatal tool exceptions remain fatal without executing a closing request", async () => {
    const fixture = setup();
    fixture.execute.mockRejectedValue(new Error("unknown side effects"));
    await expect(fixture.run()).rejects.toThrow("unknown side effects");
    expect(fixture.requests).toHaveLength(1);
  });
});

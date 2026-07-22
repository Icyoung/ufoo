"use strict";

/**
 * Materialize tests — resolved ledger → contiguous Provider tool results.
 */

const {
  createToolCallLedger,
  declareCalls,
  resolveCall,
  materializeResolvedToolResults,
  materializeAnswerToolResult,
} = require("../../../../src/code/protocol");

function makeOpenAiTransport() {
  return {
    appendToolResult({ messages, call, toolResult }) {
      messages.push({
        role: "tool",
        tool_call_id: call.source.id,
        content: JSON.stringify(toolResult),
      });
    },
  };
}

function makeAnthropicTransport() {
  return {
    appendToolResult({ collected, call, toolResult }) {
      collected.push({
        type: "tool_result",
        tool_use_id: call.source.id,
        content: JSON.stringify(toolResult),
        is_error: Boolean(!toolResult || toolResult.ok === false),
      });
    },
    flushToolResults({ messages, collected }) {
      messages.push({ role: "user", content: collected });
    },
  };
}

describe("materializeResolvedToolResults", () => {
  test("openai materializes one tool message per resolved call", () => {
    const ledger = createToolCallLedger({ provider: "openai" });
    declareCalls(ledger, [
      { callId: "c1", name: "read", args: {} },
      { callId: "c2", name: "bash", args: {} },
    ]);
    const rejected = { ok: false, code: "MIXED_PLAN_AND_DATA_TOOLS" };
    resolveCall(ledger, "c1", { result: rejected, isError: true });
    resolveCall(ledger, "c2", { result: rejected, isError: true });
    const messages = [];
    const pendingById = {
      c1: { source: { id: "c1" }, name: "read", args: {} },
      c2: { source: { id: "c2" }, name: "bash", args: {} },
    };
    const out = materializeResolvedToolResults(ledger, {
      transport: makeOpenAiTransport(),
      messages,
      pendingById,
    });
    expect(out.appended).toBe(2);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.role === "tool")).toBe(true);
  });

  test("anthropic flushes a single user tool_result array", () => {
    const ledger = createToolCallLedger({ provider: "anthropic" });
    declareCalls(ledger, [{ callId: "t1", name: "read", args: {} }]);
    resolveCall(ledger, "t1", { result: { ok: true }, isError: false });
    const messages = [];
    materializeResolvedToolResults(ledger, {
      transport: makeAnthropicTransport(),
      messages,
      pendingById: { t1: { source: { id: "t1" }, name: "read", args: {} } },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content[0].type).toBe("tool_result");
  });

  test("skips deferred calls (no empty flush)", () => {
    const ledger = createToolCallLedger();
    declareCalls(ledger, [{ callId: "ask", name: "ask_user", args: { prompt: "?" } }]);
    const { deferCall } = require("../../../../src/code/protocol");
    deferCall(ledger, "ask");
    const messages = [];
    const out = materializeResolvedToolResults(ledger, {
      transport: makeAnthropicTransport(),
      messages,
      pendingById: { ask: { source: { id: "ask" }, name: "ask_user", args: {} } },
    });
    expect(out.appended).toBe(0);
    expect(out.flushed).toBe(false);
    expect(messages).toHaveLength(0);
  });

  test("materializeAnswerToolResult writes openai tool role", () => {
    const messages = [];
    const out = materializeAnswerToolResult(messages, {
      transport: "openai-chat",
      toolCallId: "call_ask",
      call: { source: { id: "call_ask" } },
    }, { type: "user_answer", text: "yes" });
    expect(out.ok).toBe(true);
    expect(messages[0]).toMatchObject({
      role: "tool",
      tool_call_id: "call_ask",
    });
  });
});

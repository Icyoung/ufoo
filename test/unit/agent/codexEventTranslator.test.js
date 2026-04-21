const { normalizeCodexEvent } = require("../../../src/agent/codexEventTranslator");

describe("agent codexEventTranslator", () => {
  test("normalizes thread and turn lifecycle events", () => {
    expect(normalizeCodexEvent({ type: "thread.started", thread_id: "thread-1" })).toEqual({
      type: "thread_started",
      threadId: "thread-1",
    });

    expect(normalizeCodexEvent({ type: "turn.started", turn_id: "turn-1" })).toEqual({
      type: "turn_started",
      turnId: "turn-1",
    });

    expect(normalizeCodexEvent({
      type: "turn.completed",
      turn_id: "turn-1",
      usage: { input_tokens: 10 },
    })).toEqual({
      type: "turn_completed",
      turnId: "turn-1",
      usage: { input_tokens: 10 },
    });
  });

  test("normalizes item.completed text and tool events", () => {
    expect(normalizeCodexEvent({
      type: "item.completed",
      item: { type: "message", text: "hello" },
    })).toEqual({
      type: "text_delta",
      delta: "hello",
      itemType: "message",
    });

    expect(normalizeCodexEvent({
      type: "item.completed",
      item: { type: "tool_call", id: "call-1", name: "route_agent", arguments: { a: 1 } },
    })).toEqual({
      type: "tool_call",
      toolCallId: "call-1",
      name: "route_agent",
      args: { a: 1 },
    });

    expect(normalizeCodexEvent({
      type: "item.completed",
      item: { type: "tool_result", tool_call_id: "call-1", output: { ok: true } },
    })).toEqual({
      type: "tool_result",
      toolCallId: "call-1",
      output: { ok: true },
    });
  });

  test("returns null for unsupported events", () => {
    expect(normalizeCodexEvent({ type: "unknown" })).toBeNull();
    expect(normalizeCodexEvent({})).toBeNull();
  });
});

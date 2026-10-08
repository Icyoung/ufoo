const { normalizeCodexEvent } = require("../../../src/agents/providers/codexEventTranslator");

describe("agent codexEventTranslator", () => {
  test("native todo-list updates project live plan progress", () => {
    const items = [{ text: "Inspect", completed: true }, { text: "Fix", completed: false }];
    expect(normalizeCodexEvent({ type: "item.updated", item: { type: "todo_list", id: "plan", items } })).toEqual({ type: "plan", items });
  });
  test("reasoning and response item starts update status before their first text", () => {
    expect(normalizeCodexEvent({ type: "item.started", item: { type: "reasoning", id: "think", text: "" } }))
      .toEqual({ type: "phase", phase: { type: "thinking" } });
    expect(normalizeCodexEvent({ type: "item.started", item: { type: "agent_message", id: "reply", text: "" } }))
      .toEqual({ type: "phase", phase: { type: "text_delta" } });
  });
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

const { normalizeCodexEvent, createCodexEventState } = require("../../../src/agents/providers/codexEventTranslator");

describe("agent codexEventTranslator", () => {
  test.each(["file_change", "web_search"])("%s has exactly one start/result pair with incremental or completion-only SDK events", itemType => {
    const item = { id: "patch", type: itemType, status: "completed", changes: [{ path: "source.js", kind: "update" }], query: "docs" };
    const state = createCodexEventState();
    const start = normalizeCodexEvent({ type: "item.started", item }, state);
    expect(start.type).toBe("tool_call");
    expect(normalizeCodexEvent({ type: "item.updated", item }, state)).toBeNull();
    expect(normalizeCodexEvent({ type: "item.completed", item }, state)).toMatchObject({ type: "tool_result", toolCallId: start.toolCallId, is_error: false });
    expect(normalizeCodexEvent({ type: "item.completed", item }, state)).toBeNull();
    expect(normalizeCodexEvent({ type: "item.completed", item }, createCodexEventState()).map(e => e.type)).toEqual(["tool_call", "tool_result"]);
  });
  test("final text excludes progress and still captures a completed message already streamed in full", () => {
    const state = createCodexEventState();
    const event = (type, item) => normalizeCodexEvent({ type, item }, state);
    event("item.completed", { id: "progress", type: "agent_message", text: "I will inspect the code." });
    event("item.started", { id: "tool", type: "command_execution", command: "npm test" });
    expect(normalizeCodexEvent({ type: "turn.completed" }, state).finalText).toBe("");
    event("item.updated", { id: "final", type: "agent_message", text: "Fixed. Tests passed." });
    expect(event("item.completed", { id: "final", type: "agent_message", text: "Fixed. Tests passed." })).toBeNull();
    expect(normalizeCodexEvent({ type: "turn.completed" }, state).finalText).toBe("Fixed. Tests passed.");
    normalizeCodexEvent({ type: "turn.started" }, state);
    event("item.completed", { id: "comment", type: "agent_message", phase: "commentary", text: "Still working." });
    expect(normalizeCodexEvent({ type: "turn.completed" }, state).finalText).toBe("");
  });
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
      finalText: "",
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

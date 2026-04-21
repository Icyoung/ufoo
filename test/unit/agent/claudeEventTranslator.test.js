"use strict";

const {
  createClaudeEventState,
  normalizeClaudeContentBlock,
  normalizeClaudeEvent,
  normalizeClaudeMessage,
  normalizeClaudeUsage,
} = require("../../../src/agent/claudeEventTranslator");

describe("agent claudeEventTranslator", () => {
  test("normalizes Claude SSE lifecycle, text, tool use, and usage events", () => {
    const state = createClaudeEventState({ threadId: "claude-thread-1" });
    const events = [];

    events.push(...normalizeClaudeEvent({
      type: "message_start",
      message: { id: "msg-1", usage: { input_tokens: 12 } },
    }, state));
    events.push(...normalizeClaudeEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text" },
    }, state));
    events.push(...normalizeClaudeEvent({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello " },
    }, state));
    events.push(...normalizeClaudeEvent({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tool-1", name: "route_agent" },
    }, state));
    events.push(...normalizeClaudeEvent({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"target\":\"reviewer\",\"confidence\":0.9}" },
    }, state));
    events.push(...normalizeClaudeEvent({
      type: "content_block_stop",
      index: 1,
    }, state));
    events.push(...normalizeClaudeEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 12, output_tokens: 8 },
    }, state));
    events.push(...normalizeClaudeEvent({
      type: "message_stop",
    }, state));

    expect(events).toEqual([
      { type: "turn_started", turnId: "msg-1" },
      { type: "text_delta", delta: "hello ", itemType: "text" },
      {
        type: "tool_call",
        toolCallId: "tool-1",
        name: "route_agent",
        args: { target: "reviewer", confidence: 0.9 },
      },
      {
        type: "usage",
        turnId: "msg-1",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
        },
      },
      {
        type: "turn_completed",
        turnId: "msg-1",
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
        },
        stopReason: "end_turn",
      },
    ]);
  });

  test("normalizes structured Claude content blocks including tool_result", () => {
    expect(normalizeClaudeContentBlock({
      type: "tool_result",
      tool_use_id: "call-1",
      content: { ok: true },
      is_error: false,
    })).toEqual([{
      type: "tool_result",
      toolCallId: "call-1",
      output: { ok: true },
      is_error: false,
    }]);

    expect(normalizeClaudeMessage({
      id: "msg-2",
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
      content: [
        { type: "text", text: "Need a tool." },
        { type: "tool_use", id: "call-2", name: "dispatch_message", input: { target: "builder-3" } },
        { type: "tool_result", tool_use_id: "call-2", content: { delivered: true } },
      ],
    })).toEqual([
      { type: "turn_started", turnId: "msg-2" },
      { type: "text_delta", delta: "Need a tool.", itemType: "text" },
      {
        type: "tool_call",
        toolCallId: "call-2",
        name: "dispatch_message",
        args: { target: "builder-3" },
      },
      {
        type: "tool_result",
        toolCallId: "call-2",
        output: { delivered: true },
        is_error: false,
      },
      {
        type: "usage",
        turnId: "msg-2",
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
        },
      },
      {
        type: "turn_completed",
        turnId: "msg-2",
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
        },
        stopReason: "tool_use",
      },
    ]);
  });

  test("normalizes stream failures to turn_failed and ignores unsupported events", () => {
    const state = createClaudeEventState({ turnId: "msg-err" });
    expect(normalizeClaudeEvent({
      type: "error",
      error: { message: "network disconnect" },
    }, state)).toEqual([{
      type: "turn_failed",
      turnId: "msg-err",
      error: "network disconnect",
    }]);

    expect(normalizeClaudeEvent({ type: "ping" }, state)).toEqual([]);
  });

  test("normalizes Anthropic cache usage counters to generic observability fields", () => {
    expect(normalizeClaudeUsage({
      input_tokens: 12,
      output_tokens: 8,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 9,
    })).toEqual({
      input_tokens: 12,
      output_tokens: 8,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 9,
      cache_creation_tokens: 5,
      cache_read_tokens: 9,
    });
  });
});

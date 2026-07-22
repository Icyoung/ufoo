"use strict";

const {
  createOpenAiChatTransport,
  createAnthropicMessagesTransport,
  TRANSPORT_NAMES,
  assertTransport,
} = require("../../../../src/code/providers");

describe("providers transports", () => {
  test("TRANSPORT_NAMES lists openai and anthropic", () => {
    expect(TRANSPORT_NAMES).toEqual(["openai-chat", "anthropic-messages"]);
  });

  test("openai transport prepares tool_calls and appends tool results", () => {
    const transport = createOpenAiChatTransport({
      resolveUrl: () => "https://example.test/v1/chat/completions",
      runTurn: async () => ({ text: "", toolCalls: [] }),
      normalizeToolName: (n) => String(n || "").toLowerCase(),
      normalizeToolCallArgs: (raw) => (typeof raw === "string" ? JSON.parse(raw || "{}") : raw),
      toJsonString: (v) => JSON.stringify(v),
      clipText: (v) => String(v),
    });
    assertTransport(transport, "openai-chat");
    const messages = [];
    const pending = transport.prepareToolCalls({
      messages,
      toolCalls: [
        { id: "c1", function: { name: "read", arguments: '{"path":"a"}' } },
      ],
    });
    expect(messages[0].tool_calls).toHaveLength(1);
    transport.appendToolResult({
      messages,
      call: pending[0],
      toolResult: { ok: true },
    });
    expect(messages[1].role).toBe("tool");
  });

  test("anthropic transport flushes collected tool_results", () => {
    const transport = createAnthropicMessagesTransport({
      resolveUrl: () => "https://example.test/v1/messages",
      runTurn: async () => ({ text: "", toolCalls: [] }),
      toJsonString: (v) => JSON.stringify(v),
      clipText: (v) => String(v),
    });
    const messages = [];
    const pending = transport.prepareToolCalls({
      messages,
      turnResult: {
        assistantContent: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
      toolCalls: [{ id: "t1", name: "read", args: {} }],
    });
    const collected = [];
    transport.appendToolResult({
      collected,
      call: pending[0],
      toolResult: { ok: true },
    });
    transport.flushToolResults({ messages, collected });
    expect(messages[1].role).toBe("user");
    expect(messages[1].content[0].type).toBe("tool_result");
  });
});

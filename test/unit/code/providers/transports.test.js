"use strict";

const {
  createOpenAiChatTransport,
  createOpenAiResponsesTransport,
  createAnthropicMessagesTransport,
  TRANSPORT_NAMES,
  assertTransport,
} = require("../../../../src/code/providers");
const {
  getResponsesReasoningItems,
  messagesToResponsesInput,
} = require("../../../../src/code/providers/responsesProtocol");

describe("providers transports", () => {
  test("TRANSPORT_NAMES lists chat, responses, and anthropic", () => {
    expect(TRANSPORT_NAMES).toEqual(["openai-chat", "openai-responses", "anthropic-messages"]);
  });

  test("responses transport keeps tool continuation in the public message projection", () => {
    const transport = createOpenAiResponsesTransport({
      resolveUrl: () => "https://example.test/v1/responses",
      runTurn: async () => ({ text: "", toolCalls: [] }),
      normalizeToolName: (n) => String(n || "").toLowerCase(),
      normalizeToolCallArgs: (raw) => (typeof raw === "string" ? JSON.parse(raw || "{}") : raw),
      toJsonString: (v) => JSON.stringify(v),
      clipText: (v) => String(v),
    });
    assertTransport(transport, "openai-responses");
    const messages = [];
    const pending = transport.prepareToolCalls({
      messages,
      turnResult: {
        response: {
          output: [{
            id: "rs_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-reasoning-1",
          }],
        },
      },
      toolCalls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"README.md"}' } }],
    });
    transport.appendToolResult({ messages, call: pending[0], toolResult: { ok: true, content: "ok" } });
    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "read", arguments: '{"path":"README.md"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true,"content":"ok"}' },
    ]);
    expect(getResponsesReasoningItems(messages[0])).toEqual([{
      id: "rs_1",
      type: "reasoning",
      summary: [],
      encrypted_content: "encrypted-reasoning-1",
    }]);
    expect(messagesToResponsesInput(messages)).toEqual([
      {
        id: "rs_1",
        type: "reasoning",
        summary: [],
        encrypted_content: "encrypted-reasoning-1",
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "read",
        arguments: '{"path":"README.md"}',
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: '{"ok":true,"content":"ok"}',
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("encrypted-reasoning-1");
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

  test("openai transport attaches image_url companion after read_image", () => {
    const transport = createOpenAiChatTransport({
      resolveUrl: () => "https://example.test/v1/chat/completions",
      runTurn: async () => ({ text: "", toolCalls: [] }),
      normalizeToolName: (n) => String(n || "").toLowerCase(),
      normalizeToolCallArgs: (raw) => (typeof raw === "string" ? JSON.parse(raw || "{}") : raw),
      toJsonString: (v) => JSON.stringify(v),
      clipText: (v) => String(v),
    });
    const messages = [];
    const pending = transport.prepareToolCalls({
      messages,
      toolCalls: [
        { id: "c2", function: { name: "read_image", arguments: '{"path":"a.png"}' } },
      ],
    });
    transport.appendToolResult({
      messages,
      call: pending[0],
      toolResult: {
        ok: true,
        kind: "image",
        path: "/tmp/a.png",
        mediaType: "image/png",
        bytes: 4,
        base64: "AAAA",
      },
    });
    expect(messages[1].role).toBe("tool");
    expect(messages[1].content).not.toMatch(/AAAA/);
    expect(messages[2].role).toBe("user");
    expect(messages[2].content[0].type).toBe("text");
    expect(messages[2].content[1].type).toBe("image_url");
    expect(messages[2].content[1].image_url.url).toBe("data:image/png;base64,AAAA");
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

  test("anthropic transport expands read_image into tool_result image block", () => {
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
        assistantContent: [{ type: "tool_use", id: "t2", name: "read_image", input: { path: "a.png" } }],
      },
      toolCalls: [{ id: "t2", name: "read_image", args: { path: "a.png" } }],
    });
    const collected = [];
    transport.appendToolResult({
      collected,
      call: pending[0],
      toolResult: {
        ok: true,
        kind: "image",
        path: "/tmp/a.png",
        mediaType: "image/png",
        bytes: 4,
        base64: "BBBB",
      },
    });
    transport.flushToolResults({ messages, collected });
    const toolResult = messages[1].content[0];
    expect(toolResult.type).toBe("tool_result");
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content[0].type).toBe("text");
    expect(toolResult.content[0].text).not.toMatch(/BBBB/);
    expect(toolResult.content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "BBBB" },
    });
  });
});

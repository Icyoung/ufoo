"use strict";

const {
  buildClaudeRequest,
  buildClaudeSystemBlocks,
  ClaudeApiThread,
  ClaudeThreadProvider,
  defaultClaudeTransportStreamFactory,
  normalizeMessageInput,
  normalizeToolDefinition,
  withCacheControlOnLastBlock,
} = require("../../../src/agent/claudeThreadProvider");

describe("agent claudeThreadProvider", () => {
  test("builds cacheable static and semistatic system blocks", () => {
    expect(buildClaudeSystemBlocks({
      systemPrompt: "static rules",
      semistaticText: "session memory index",
      dynamicText: "dynamic addendum",
    })).toEqual([
      { type: "text", text: "static rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "session memory index", cache_control: { type: "ephemeral" } },
      { type: "text", text: "dynamic addendum" },
    ]);
  });

  test("marks prior message prefix blocks as cacheable but leaves current user prompt dynamic", () => {
    expect(withCacheControlOnLastBlock([{ type: "text", text: "hello" }])).toEqual([
      { type: "text", text: "hello", cache_control: { type: "ephemeral" } },
    ]);

    expect(buildClaudeRequest({
      model: "claude-sonnet",
      maxTokens: 1024,
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "previous answer" }],
      }],
      userMessage: normalizeMessageInput("current turn"),
      promptCache: { systemPrompt: "static rules" },
    })).toEqual({
      model: "claude-sonnet",
      max_tokens: 1024,
      system: [{ type: "text", text: "static rules", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "previous answer", cache_control: { type: "ephemeral" } }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "current turn" }],
        },
      ],
    });
  });

  test("normalizes messages and tool definitions for Anthropic requests", () => {
    expect(normalizeMessageInput("hello")).toEqual({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(normalizeToolDefinition({
      name: "route_agent",
      description: "Route",
      input_schema: { type: "object", properties: { target: { type: "string" } } },
    })).toEqual({
      name: "route_agent",
      description: "Route",
      input_schema: { type: "object", properties: { target: { type: "string" } } },
    });
  });

  test("runStreamed emits normalized events, preserves thread state, and forwards tools", async () => {
    const authProvider = jest.fn(async () => ({ apiKey: "test-key" }));
    const clientFactory = jest.fn(() => ({ messages: { create: jest.fn() } }));
    const streamFactory = jest.fn(async function* ({ request }) {
      expect(request.model).toBe("claude-sonnet");
      expect(request.max_tokens).toBe(2048);
      expect(request.system).toEqual([
        { type: "text", text: "system rules", cache_control: { type: "ephemeral" } },
        { type: "text", text: "session memory", cache_control: { type: "ephemeral" } },
      ]);
      expect(request.messages).toEqual([{
        role: "user",
        content: [{ type: "text", text: "route this" }],
      }]);
      expect(request.tools).toEqual([{
        name: "route_agent",
        description: "Route a request",
        input_schema: { type: "object", properties: {} },
      }]);

      yield { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 10 } } };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } };
      yield { type: "message_stop" };
    });

    const thread = new ClaudeApiThread({
      model: "claude-sonnet",
      authProvider,
      clientFactory,
      streamFactory,
      sdk: {},
      maxTokens: 2048,
    });

    const events = [];
    for await (const event of thread.runStreamed("route this", {
      tools: [{ name: "route_agent", description: "Route a request", input_schema: { type: "object", properties: {} } }],
      promptCache: {
        systemPrompt: "system rules",
        semistaticText: "session memory",
      },
    })) {
      events.push(event);
    }

    expect(authProvider).toHaveBeenCalledTimes(1);
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(streamFactory).toHaveBeenCalledTimes(1);
    expect(thread.id).toMatch(/^claude-thread-/);
    expect(thread.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "route this" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
    ]);
    expect(events).toEqual([
      { type: "thread_started", threadId: thread.id },
      { type: "turn_started", turnId: "msg-1" },
      { type: "text_delta", delta: "hello", itemType: "text" },
      {
        type: "turn_completed",
        turnId: "msg-1",
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
        },
        stopReason: "",
      },
    ]);
  });

  test("retries Claude stream once on reconnectable failure", async () => {
    const streamFactory = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error("stream disconnect"), { code: "ECONNRESET" }))
      .mockImplementationOnce(async function* () {
        yield { type: "message_start", message: { id: "msg-2" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "retry ok" } };
        yield { type: "message_stop" };
      });

    const thread = new ClaudeApiThread({
      model: "claude-sonnet",
      authProvider: async () => ({ apiKey: "test-key" }),
      clientFactory: () => ({ messages: { create: jest.fn() } }),
      streamFactory,
      sdk: {},
    });

    const events = [];
    for await (const event of thread.runStreamed("retry request")) {
      events.push(event);
    }

    expect(streamFactory).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      { type: "thread_started", threadId: thread.id },
      { type: "turn_started", turnId: "msg-2" },
      { type: "text_delta", delta: "retry ok", itemType: "text" },
      { type: "turn_completed", turnId: "msg-2", usage: null, stopReason: "" },
    ]);
  });

  test("redacts secrets in text_delta and tool_call args at translator boundary", async () => {
    const streamFactory = jest.fn(async function* () {
      yield { type: "message_start", message: { id: "msg-redact" } };
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "go Authorization: Bearer secret.xyz now" },
      };
      yield {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool-red", name: "dispatch_message" },
      };
      yield {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: JSON.stringify({ target: "agent:b", accessToken: "leak-me" }) },
      };
      yield { type: "content_block_stop", index: 1 };
      yield { type: "message_stop" };
    });

    const thread = new ClaudeApiThread({
      model: "claude-sonnet",
      authProvider: async () => ({ apiKey: "test-key" }),
      clientFactory: () => ({ messages: { create: jest.fn() } }),
      streamFactory,
      sdk: {},
    });

    const events = [];
    for await (const event of thread.runStreamed("go")) events.push(event);
    const textDelta = events.find((e) => e.type === "text_delta");
    expect(textDelta.delta).toBe("go Authorization: Bearer [REDACTED] now");
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall.args.accessToken).toBe("[REDACTED]");
    expect(toolCall.args.target).toBe("agent:b");
  });

  test("resumeThread seeds an existing thread id", () => {
    const provider = new ClaudeThreadProvider({
      model: "claude-sonnet",
      authProvider: async () => ({ apiKey: "test-key" }),
      clientFactory: () => ({ messages: { create: jest.fn() } }),
      streamFactory: async function* () {},
      sdk: {},
    });

    const thread = provider.resumeThread("thread-prev");
    expect(thread.id).toBe("thread-prev");
  });

  test("reuses prior turns as cacheable prefix and normalizes cache token usage", async () => {
    const requests = [];
    const streamFactory = jest.fn(async function* ({ request }) {
      requests.push(request);
      yield {
        type: "message_start",
        message: {
          id: `msg-${requests.length}`,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 7,
            cache_read_input_tokens: 11,
          },
        },
      };
      yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `reply-${requests.length}` } };
      yield { type: "message_stop" };
    });

    const thread = new ClaudeApiThread({
      model: "claude-sonnet",
      authProvider: async () => ({ apiKey: "test-key" }),
      clientFactory: () => ({ messages: { create: jest.fn() } }),
      streamFactory,
      sdk: {},
    });

    const firstEvents = [];
    for await (const event of thread.runStreamed("first turn")) firstEvents.push(event);
    const secondEvents = [];
    for await (const event of thread.runStreamed("second turn")) secondEvents.push(event);

    expect(requests).toHaveLength(2);
    expect(requests[1].messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "first turn", cache_control: { type: "ephemeral" } }],
    });
    expect(requests[1].messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "reply-1", cache_control: { type: "ephemeral" } }],
    });
    expect(requests[1].messages[2]).toEqual({
      role: "user",
      content: [{ type: "text", text: "second turn" }],
    });
    const completed = secondEvents.find((event) => event.type === "turn_completed");
    expect(completed.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 11,
      cache_creation_tokens: 7,
      cache_read_tokens: 11,
    });
    expect(firstEvents.find((event) => event.type === "turn_completed").usage.cache_creation_tokens).toBe(7);
  });

  test("transport stream factory can synthesize a Claude event stream from a unified upstream response", async () => {
    const streamFactory = jest.fn()
      .mockImplementationOnce(async function* ({ request }) {
        expect(request.messages).toEqual([
          { role: "user", content: [{ type: "text", text: "first turn" }] },
        ]);
        yield {
          type: "message_start",
          message: { id: "msg-1", usage: { input_tokens: 4, output_tokens: 2 } },
        };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first reply" } };
        yield { type: "message_stop" };
      })
      .mockImplementationOnce(async function* ({ request }) {
        expect(request.messages[0]).toEqual({
          role: "user",
          content: [{ type: "text", text: "first turn", cache_control: { type: "ephemeral" } }],
        });
        expect(request.messages[1]).toEqual({
          role: "assistant",
          content: [{ type: "text", text: "first reply", cache_control: { type: "ephemeral" } }],
        });
        expect(request.messages[2]).toEqual({
          role: "user",
          content: [{ type: "text", text: "second turn" }],
        });
        yield {
          type: "message_start",
          message: { id: "msg-2", usage: { input_tokens: 5, output_tokens: 3 } },
        };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second reply" } };
        yield { type: "message_stop" };
      });

    const thread = new ClaudeApiThread({
      model: "claude-sonnet",
      authProvider: async () => ({ apiKey: "test-key" }),
      clientFactory: () => ({}),
      streamFactory,
      sdk: {},
    });

    for await (const _event of thread.runStreamed("first turn")) {}
    const secondEvents = [];
    for await (const event of thread.runStreamed("second turn")) secondEvents.push(event);

    expect(streamFactory).toHaveBeenCalledTimes(2);
    expect(secondEvents.find((event) => event.type === "turn_completed").usage).toEqual({
      input_tokens: 5,
      output_tokens: 3,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    });
    expect(defaultClaudeTransportStreamFactory).toBeInstanceOf(Function);
  });
});

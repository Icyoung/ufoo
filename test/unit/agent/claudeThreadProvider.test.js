"use strict";

const {
  buildClaudeRequest,
  buildClaudeSystemBlocks,
  ClaudeApiThread,
  ClaudeThreadProvider,
  buildClaudeAgentOptions,
  defaultClaudeAgentStreamFactory,
  extraArgsToObject,
  normalizeMessageInput,
  normalizeToolDefinition,
  withCacheControlOnLastBlock,
} = require("../../../src/agents/providers/claudeThreadProvider");

describe("agent claudeThreadProvider", () => {
  function makeMessages(messages) {
    return (async function* messageStream() {
      for (const message of messages) yield message;
    })();
  }

  test("SDK operational events expose compaction, retries, tool progress, authentication and background tasks", async () => {
    const sdk = { query: () => makeMessages([
      { type: "system", subtype: "status", status: "compacting" },
      { type: "system", subtype: "api_retry", attempt: 2, max_retries: 3, retry_delay_ms: 1000 },
      { type: "tool_progress", tool_name: "Bash" },
      { type: "auth_status", isAuthenticating: true },
      { type: "system", subtype: "task_started", task_id: "bg", description: "Check" },
      { type: "system", subtype: "task_progress", task_id: "bg", description: "Reading" },
      { type: "system", subtype: "task_notification", task_id: "bg", status: "completed" },
      { type: "system", subtype: "compact_boundary" },
      { type: "result", result: "done" },
    ]) };
    const thread = new ClaudeApiThread({ sdk, streamFactory: defaultClaudeAgentStreamFactory });
    const events = [];
    for await (const event of thread.runStreamed("task")) events.push(event);
    const view = require("../../../src/ui/agentSurface").createAgentSurface();
    const states = [];
    for (const event of events) { view.accept(event); states.push(view.snapshot().status); }
    expect(states).toContain("Compacting context…");
    expect(states).toContain("Retrying request (2/3)…");
    expect(states).toContain("Running command…");
    expect(states).toContain("Authenticating…");
    expect(states.some(state => state.includes("BG 1 done"))).toBe(true);
  });

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

  test("default Agent SDK stream uses query, streams partials, and captures session id", async () => {
    const sdk = {
      query: jest.fn(() => makeMessages([
        {
          type: "system",
          subtype: "init",
          session_id: "11111111-1111-4111-8111-111111111111",
        },
        {
          type: "stream_event",
          session_id: "11111111-1111-4111-8111-111111111111",
          event: { type: "message_start", message: { id: "msg-1", usage: { input_tokens: 3 } } },
        },
        {
          type: "stream_event",
          session_id: "11111111-1111-4111-8111-111111111111",
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        },
        {
          type: "stream_event",
          session_id: "11111111-1111-4111-8111-111111111111",
          event: { type: "message_stop" },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "hello",
          usage: { input_tokens: 3, output_tokens: 2 },
          session_id: "11111111-1111-4111-8111-111111111111",
        },
      ])),
    };
    const thread = new ClaudeApiThread({
      model: "claude-sonnet",
      cwd: process.cwd(),
      extraArgs: ["--permission-mode", "acceptEdits"],
      sdk,
      streamFactory: defaultClaudeAgentStreamFactory,
    });

    const events = [];
    for await (const event of thread.runStreamed("hi")) events.push(event);

    expect(sdk.query).toHaveBeenCalledWith({
      prompt: "hi",
      options: expect.objectContaining({
        model: "claude-sonnet",
        cwd: process.cwd(),
        includePartialMessages: true,
        extraArgs: { "permission-mode": "acceptEdits" },
      }),
    });
    expect(thread.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(events).toEqual([
      { type: "thread_started", threadId: "11111111-1111-4111-8111-111111111111" },
      { type: "turn_started", turnId: "msg-1" },
      { type: "text_delta", delta: "hello", itemType: "text" },
      { type: "turn_completed", turnId: "msg-1", usage: { input_tokens: 3, output_tokens: 2, cache_creation_tokens: 0, cache_read_tokens: 0 }, stopReason: "" },
    ]);
  });

  test("keeps an SDK task working across assistant messages and exposes actual tool arguments and results", async () => {
    const sdk = { query: jest.fn(() => makeMessages([
      { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "Bash", input: {} } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"npm test"}' } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "tests passed" }] } },
      { type: "stream_event", event: { type: "message_start", message: { id: "m2" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } } },
      { type: "stream_event", event: { type: "message_stop" } },
      { type: "result", result: "done", usage: { input_tokens: 20, output_tokens: 10 } },
    ])) };
    const thread = new ClaudeApiThread({ sdk, streamFactory: defaultClaudeAgentStreamFactory });
    const events = [];
    for await (const event of thread.runStreamed("test")) events.push(event);
    expect(events.find(event => event.type === "tool_call")).toMatchObject({ name: "Bash", args: { command: "npm test" } });
    expect(events.find(event => event.type === "tool_result")).toMatchObject({ output: "tests passed" });
    expect(events.filter(event => event.type === "turn_completed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "turn_completed", usage: { output_tokens: 10 } });
  });

  test("Agent SDK resume passes prior session id", async () => {
    const sdk = {
      query: jest.fn(() => makeMessages([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "ok",
          session_id: "22222222-2222-4222-8222-222222222222",
        },
      ])),
    };
    const provider = new ClaudeThreadProvider({
      model: "claude-sonnet",
      cwd: process.cwd(),
      sdk,
    });

    const thread = provider.resumeThread("22222222-2222-4222-8222-222222222222");
    const events = [];
    for await (const event of thread.runStreamed("again")) events.push(event);

    expect(sdk.query).toHaveBeenCalledWith({
      prompt: "again",
      options: expect.objectContaining({
        resume: "22222222-2222-4222-8222-222222222222",
      }),
    });
    expect(events[0]).toEqual({
      type: "thread_started",
      threadId: "22222222-2222-4222-8222-222222222222",
    });
    expect(events.find((event) => event.type === "text_delta").delta).toBe("ok");
  });

  test("buildClaudeAgentOptions maps cwd, model, resume, and extra args", () => {
    expect(extraArgsToObject(["--permission-mode", "acceptEdits", "--debug"])).toEqual({
      "permission-mode": "acceptEdits",
      debug: null,
    });
    expect(buildClaudeAgentOptions({
      model: "claude-sonnet",
      cwd: "/tmp/project",
      threadId: "session-1",
      extraArgs: ["--debug"],
    })).toEqual(expect.objectContaining({
      model: "claude-sonnet",
      cwd: "/tmp/project",
      resume: "session-1",
      includePartialMessages: true,
      extraArgs: { debug: null },
    }));
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

  test("custom stream factory preserves Claude message history", async () => {
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
  });
});

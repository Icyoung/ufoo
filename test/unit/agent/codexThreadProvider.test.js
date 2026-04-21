const {
  CodexSdkThread,
  CodexThreadProvider,
  defaultCodexStreamFactory,
  defaultCodexTransportStreamFactory,
} = require("../../../src/agent/codexThreadProvider");

describe("agent codexThreadProvider", () => {
  test("default factory forwards input and opts into sdk.runStreamed", async () => {
    const sdk = {
      runStreamed: jest.fn(async function* () {
        yield { type: "thread.started", thread_id: "thread-42" };
        yield { type: "item.completed", item: { type: "message", text: "hello" } };
        yield { type: "turn.completed", turn_id: "turn-1" };
      }),
    };

    const thread = new CodexSdkThread({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      sdk,
      streamFactory: defaultCodexStreamFactory,
    });

    const events = [];
    for await (const event of thread.runStreamed("hi", { temperature: 0.2, metadata: { source: "test" } })) {
      events.push(event);
    }

    expect(sdk.runStreamed).toHaveBeenCalledWith({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      extraArgs: [],
      threadId: "",
      input: "hi",
      temperature: 0.2,
      metadata: { source: "test" },
    });
    expect(thread.id).toBe("thread-42");
    expect(events).toEqual([
      { type: "thread_started", threadId: "thread-42" },
      { type: "text_delta", delta: "hello", itemType: "message" },
      { type: "turn_completed", turnId: "turn-1", usage: null },
    ]);
  });

  test("redacts secrets in text_delta and tool_call args at translator boundary", async () => {
    const sdk = {
      runStreamed: jest.fn(async function* () {
        yield { type: "thread.started", thread_id: "thread-redact" };
        yield {
          type: "item.completed",
          item: { type: "message", text: "please call with Authorization: Bearer abc.def.ghi" },
        };
        yield {
          type: "item.completed",
          item: {
            type: "tool_call",
            id: "call-1",
            name: "dispatch_message",
            arguments: { target: "agent:b", apiKey: "leak" },
          },
        };
        yield { type: "turn.completed", turn_id: "turn-1" };
      }),
    };
    const thread = new CodexSdkThread({ sdk, streamFactory: defaultCodexStreamFactory });
    const events = [];
    for await (const event of thread.runStreamed("trigger")) events.push(event);

    const textDelta = events.find((e) => e.type === "text_delta");
    expect(textDelta.delta).toBe("please call with Authorization: Bearer [REDACTED]");
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall.args.apiKey).toBe("[REDACTED]");
    expect(toolCall.args.target).toBe("agent:b");
  });

  test("resumeThread seeds an existing thread id", () => {
    const provider = new CodexThreadProvider({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      sdk: {},
      streamFactory: async function* () {},
    });

    const thread = provider.resumeThread("thread-prev");
    expect(thread.id).toBe("thread-prev");
  });

  test("injects worker tools into sdk.runStreamed opts without local execution", async () => {
    const sdk = {
      runStreamed: jest.fn(async function* () {
        yield { type: "thread.started", thread_id: "thread-tools" };
        yield {
          type: "item.completed",
          item: {
            type: "tool_call",
            id: "call-1",
            name: "dispatch_message",
            arguments: { target: "codex:worker", message: "handle this" },
          },
        };
        yield { type: "turn.completed", turn_id: "turn-2" };
      }),
    };
    const tools = [{ name: "dispatch_message", description: "Dispatch", input_schema: { type: "object" } }];
    const thread = new CodexSdkThread({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      sdk,
      tools,
      streamFactory: defaultCodexStreamFactory,
    });

    const events = [];
    for await (const event of thread.runStreamed("hi")) {
      events.push(event);
    }

    expect(sdk.runStreamed).toHaveBeenCalledWith(expect.objectContaining({
      tools,
    }));
    expect(events).toEqual([
      { type: "thread_started", threadId: "thread-tools" },
      {
        type: "tool_call",
        toolCallId: "call-1",
        name: "dispatch_message",
        args: { target: "codex:worker", message: "handle this" },
      },
      { type: "turn_completed", turnId: "turn-2", usage: null },
    ]);
  });

  test("transport factory uses unified upstream transport and preserves local history", async () => {
    const streamFactory = jest.fn()
      .mockImplementationOnce(async function* ({ threadId }) {
        yield { type: "thread.started", thread_id: threadId || "thread-transport" };
        yield { type: "item.completed", item: { type: "message", text: "first reply" } };
        yield { type: "turn.completed", turn_id: "turn-a", usage: { total_tokens: 11 } };
      })
      .mockImplementationOnce(async function* ({ opts, threadId }) {
        expect(opts.history).toEqual([
          { role: "user", content: "first prompt" },
          { role: "assistant", content: "first reply" },
        ]);
        yield { type: "thread.started", thread_id: threadId || "thread-transport" };
        yield { type: "item.completed", item: { type: "message", text: "second reply" } };
        yield { type: "turn.completed", turn_id: "turn-b", usage: { total_tokens: 13 } };
      });

    const thread = new CodexSdkThread({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      streamFactory,
    });

    const first = [];
    for await (const event of thread.runStreamed("first prompt")) first.push(event);
    const second = [];
    for await (const event of thread.runStreamed("second prompt")) second.push(event);

    expect(streamFactory).toHaveBeenCalledTimes(2);
    expect(thread.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "first reply" },
      { role: "user", content: "second prompt" },
      { role: "assistant", content: "second reply" },
    ]);
    expect(first.find((event) => event.type === "turn_completed").usage).toEqual({ total_tokens: 11 });
    expect(second.find((event) => event.type === "turn_completed").usage).toEqual({ total_tokens: 13 });
    expect(defaultCodexTransportStreamFactory).toBeInstanceOf(Function);
  });
});

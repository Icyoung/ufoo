const {
  CodexSdkThread,
  CodexThreadProvider,
  defaultCodexStreamFactory,
} = require("../../../src/agents/providers/codexThreadProvider");

describe("agent codexThreadProvider", () => {
  function makeEvents(events) {
    return (async function* eventStream() {
      for (const event of events) yield event;
    })();
  }

  test("default factory runs a real SDK thread stream", async () => {
    const sdkThread = {
      id: null,
      runStreamed: jest.fn(async () => ({
        events: makeEvents([
          { type: "thread.started", thread_id: "thread-42" },
          { type: "item.completed", item: { type: "agent_message", text: "hello" } },
          { type: "turn.completed", turn_id: "turn-1" },
        ]),
      })),
    };
    const codexClient = {
      startThread: jest.fn(() => sdkThread),
    };
    const sdk = {
      Codex: jest.fn(() => codexClient),
    };

    const thread = new CodexSdkThread({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      sdk,
      streamFactory: defaultCodexStreamFactory,
    });

    const events = [];
    for await (const event of thread.runStreamed("hi", { outputSchema: { type: "object" } })) {
      events.push(event);
    }

    expect(sdk.Codex).toHaveBeenCalledWith({});
    expect(codexClient.startThread).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5-codex",
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
    }));
    expect(sdkThread.runStreamed).toHaveBeenCalledWith("hi", {
      outputSchema: { type: "object" },
    });
    expect(thread.id).toBe("thread-42");
    expect(events).toEqual([
      { type: "thread_started", threadId: "thread-42" },
      { type: "text_delta", delta: "hello", itemType: "agent_message" },
      { type: "turn_completed", turnId: "turn-1", usage: null },
    ]);
  });

  test("resumeThread creates a resumed SDK thread lazily", async () => {
    const sdkThread = {
      id: "thread-prev",
      runStreamed: jest.fn(async () => ({
        events: makeEvents([
          { type: "thread.started", thread_id: "thread-prev" },
          { type: "turn.completed", turn_id: "turn-resume" },
        ]),
      })),
    };
    const codexClient = {
      resumeThread: jest.fn(() => sdkThread),
    };
    const provider = new CodexThreadProvider({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      sdk: { Codex: jest.fn(() => codexClient) },
    });

    const thread = provider.resumeThread("thread-prev");
    expect(thread.id).toBe("thread-prev");

    const events = [];
    for await (const event of thread.runStreamed("again")) events.push(event);

    expect(codexClient.resumeThread).toHaveBeenCalledWith("thread-prev", expect.objectContaining({
      model: "gpt-5-codex",
      workingDirectory: process.cwd(),
    }));
    expect(events).toEqual([
      { type: "thread_started", threadId: "thread-prev" },
      { type: "turn_completed", turnId: "turn-resume", usage: null },
    ]);
  });

  test("custom stream provider does not require @openai/codex-sdk", async () => {
    const streamFactory = jest.fn(async function* () {
      yield { type: "thread.started", thread_id: "thread-direct" };
      yield { type: "turn.completed", turn_id: "turn-direct" };
    });
    const provider = new CodexThreadProvider({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      streamFactory,
    });

    const thread = provider.startThread();
    const events = [];
    for await (const event of thread.runStreamed("hi")) events.push(event);

    expect(streamFactory).toHaveBeenCalled();
    expect(events).toEqual([
      { type: "thread_started", threadId: "thread-direct" },
      { type: "turn_completed", turnId: "turn-direct", usage: null },
    ]);
  });

  test("redacts secrets in text_delta and tool_call args at translator boundary", async () => {
    const sdkThread = {
      runStreamed: jest.fn(async () => ({
        events: makeEvents([
          { type: "thread.started", thread_id: "thread-redact" },
          {
            type: "item.completed",
            item: { type: "agent_message", text: "please call with Authorization: Bearer abc.def.ghi" },
          },
          {
            type: "item.completed",
            item: {
              type: "tool_call",
              id: "call-1",
              name: "dispatch_message",
              arguments: { target: "agent:b", apiKey: "leak" },
            },
          },
          { type: "turn.completed", turn_id: "turn-1" },
        ]),
      })),
    };
    const sdk = { Codex: jest.fn(() => ({ startThread: jest.fn(() => sdkThread) })) };
    const thread = new CodexSdkThread({ sdk, streamFactory: defaultCodexStreamFactory });
    const events = [];
    for await (const event of thread.runStreamed("trigger")) events.push(event);

    const textDelta = events.find((e) => e.type === "text_delta");
    expect(textDelta.delta).toBe("please call with Authorization: Bearer [REDACTED]");
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall.args.apiKey).toBe("[REDACTED]");
    expect(toolCall.args.target).toBe("agent:b");
  });

  test("injects worker tools into stream opts without local execution", async () => {
    const streamFactory = jest.fn(async function* ({ opts }) {
      expect(opts.tools).toEqual([
        { name: "dispatch_message", description: "Dispatch", input_schema: { type: "object" } },
      ]);
      yield { type: "thread.started", thread_id: "thread-42" };
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
    });
    const tools = [{ name: "dispatch_message", description: "Dispatch", input_schema: { type: "object" } }];
    const thread = new CodexSdkThread({
      model: "gpt-5-codex",
      cwd: process.cwd(),
      tools,
      streamFactory,
    });

    const events = [];
    for await (const event of thread.runStreamed("hi")) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "thread_started", threadId: "thread-42" },
      {
        type: "tool_call",
        toolCallId: "call-1",
        name: "dispatch_message",
        args: { target: "codex:worker", message: "handle this" },
      },
      { type: "turn_completed", turnId: "turn-2", usage: null },
    ]);
  });

  test("custom stream factory preserves local history", async () => {
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
  });
});

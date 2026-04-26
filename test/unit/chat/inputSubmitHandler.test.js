const { createInputSubmitHandler } = require("../../../src/chat/inputSubmitHandler");
const { createTerminalAdapterRouter } = require("../../../src/terminal/adapterRouter");

function createHarness(stateOverrides = {}, optionOverrides = {}) {
  const state = {
    targetAgent: null,
    pending: null,
    activeAgentMetaMap: new Map(),
    ...stateOverrides,
  };

  const adapterRouter = createTerminalAdapterRouter();

  const options = {
    state,
    parseAtTarget: jest.fn(() => null),
    getAgentAdapter: jest.fn((agentId) => {
      const meta = state.activeAgentMetaMap.get(agentId) || {};
      const launchMode = meta.launch_mode || "";
      return adapterRouter.getAdapter({ launchMode, agentId });
    }),
    resolveAgentId: jest.fn(() => null),
    executeCommand: jest.fn(() => Promise.resolve(true)),
    queueStatusLine: jest.fn(),
    send: jest.fn(),
    logMessage: jest.fn(),
    getAgentLabel: jest.fn((id) => id),
    escapeBlessed: jest.fn((value) => `ESC(${value})`),
    markPendingDelivery: jest.fn(),
    clearTargetAgent: jest.fn(() => {
      state.targetAgent = null;
    }),
    enterAgentView: jest.fn(),
    activateAgent: jest.fn(() => Promise.resolve()),
    getInjectSockPath: jest.fn((id) => `/tmp/${id}.sock`),
    existsSync: jest.fn(() => false),
    commitInputHistory: jest.fn(),
    focusInput: jest.fn(),
    ...optionOverrides,
  };

  const handler = createInputSubmitHandler(options);
  return { state, options, handler };
}

describe("chat inputSubmitHandler", () => {
  test("requires mutable state object", () => {
    expect(() => createInputSubmitHandler({})).toThrow(/requires a mutable state object/);
  });

  test("empty submit with target agent enters PTY view when socket exists", async () => {
    const { state, options, handler } = createHarness(
      {
        targetAgent: "codex:1",
        activeAgentMetaMap: new Map([["codex:1", { launch_mode: "internal-pty" }]]),
      },
      {
        existsSync: jest.fn(() => true),
      }
    );

    await handler.handleSubmit("   ");

    expect(options.clearTargetAgent).toHaveBeenCalled();
    expect(options.enterAgentView).toHaveBeenCalledWith("codex:1");
    expect(options.focusInput).not.toHaveBeenCalled();
    expect(state.targetAgent).toBeNull();
  });

  test("targeted text sends bus message and clears target", async () => {
    const { state, options, handler } = createHarness({ targetAgent: "codex:1" });

    await handler.handleSubmit("hello");

    expect(options.commitInputHistory).toHaveBeenCalledWith("hello");
    expect(options.markPendingDelivery).toHaveBeenCalledWith("codex:1");
    expect(options.send).toHaveBeenCalledWith({
      type: "bus_send",
      target: "codex:1",
      message: "hello",
      injection_mode: "immediate",
      source: "chat-direct",
    });
    expect(options.clearTargetAgent).toHaveBeenCalled();
    expect(options.focusInput).toHaveBeenCalled();
    expect(state.targetAgent).toBeNull();
  });

  test("targeted text decodes escaped newlines before echo and send", async () => {
    const { options, handler } = createHarness({ targetAgent: "codex:1" });

    await handler.handleSubmit("hello\\nworld");

    expect(options.commitInputHistory).toHaveBeenCalledWith("hello\nworld");
    expect(options.logMessage).toHaveBeenCalledWith(
      "user",
      "{white-fg}you{/white-fg} {gray-fg}·{/gray-fg} {magenta-fg}@ESC(codex:1){/magenta-fg} ESC(hello\nworld)"
    );
    expect(options.send).toHaveBeenCalledWith({
      type: "bus_send",
      target: "codex:1",
      message: "hello\nworld",
      injection_mode: "immediate",
      source: "chat-direct",
    });
  });

  test("@target without message selects direct target when resolvable", async () => {
    const { state, options, handler } = createHarness({}, {
      parseAtTarget: jest.fn(() => ({ target: "a", message: "" })),
      resolveAgentId: jest.fn(() => "codex:1"),
      setTargetAgent: jest.fn((id) => {
        state.targetAgent = id;
      }),
    });

    await handler.handleSubmit("@a");

    expect(options.setTargetAgent).toHaveBeenCalledWith("codex:1");
    expect(options.queueStatusLine).toHaveBeenCalledWith("Target selected: @ESC(a)");
    expect(options.logMessage).not.toHaveBeenCalledWith("status", expect.anything());
    expect(options.send).not.toHaveBeenCalled();
    expect(options.focusInput).toHaveBeenCalled();
  });

  test("@target without message logs error when target is unknown", async () => {
    const { options, handler } = createHarness({}, {
      parseAtTarget: jest.fn(() => ({ target: "unknown", message: "" })),
      resolveAgentId: jest.fn(() => null),
    });

    await handler.handleSubmit("@unknown");

    expect(options.logMessage).toHaveBeenCalledWith(
      "error",
      "{white-fg}✗{/white-fg} Unknown @target"
    );
    expect(options.send).not.toHaveBeenCalled();
  });

  test("@target sends resolved target and message", async () => {
    const { options, handler } = createHarness({}, {
      parseAtTarget: jest.fn(() => ({ target: "alpha", message: "ping" })),
      resolveAgentId: jest.fn(() => "codex:1"),
    });

    await handler.handleSubmit("@alpha ping");

    expect(options.markPendingDelivery).toHaveBeenCalledWith("codex:1");
    expect(options.send).toHaveBeenCalledWith({
      type: "bus_send",
      target: "codex:1",
      message: "ping",
      injection_mode: "immediate",
      source: "chat-direct",
    });
    expect(options.focusInput).toHaveBeenCalled();
  });

  test("slash command branch executes command and handles errors", async () => {
    const execError = new Error("boom");
    const { options, handler } = createHarness({}, {
      executeCommand: jest.fn(() => Promise.reject(execError)),
    });

    await handler.handleSubmit("/status");

    expect(options.executeCommand).toHaveBeenCalledWith("/status");
    expect(options.escapeBlessed).toHaveBeenCalledWith("boom");
    expect(options.logMessage).toHaveBeenCalledWith(
      "error",
      "{white-fg}✗{/white-fg} Command error: ESC(boom)"
    );
    expect(options.focusInput).toHaveBeenCalled();
  });

  test("group run slash command executes without chat echo", async () => {
    const { options, handler } = createHarness();

    await handler.handleSubmit("/group run build-lane");

    expect(options.executeCommand).toHaveBeenCalledWith("/group run build-lane");
    expect(options.logMessage).not.toHaveBeenCalledWith(
      "user",
      "{white-fg}→{/white-fg} ESC(/group run build-lane)"
    );
    expect(options.focusInput).toHaveBeenCalled();
  });

  test("disambiguation selection sends prompt and clears pending", async () => {
    const { state, options, handler } = createHarness({
      pending: {
        original: "analyze this",
        disambiguate: {
          candidates: [{ agent_id: "codex:1" }],
        },
      },
    });

    await handler.handleSubmit("1");

    expect(options.queueStatusLine).toHaveBeenCalledWith("ufoo-agent processing (assigning codex:1)");
    expect(options.send).toHaveBeenCalledWith({
      type: "prompt",
      text: "Use agent codex:1 to handle: analyze this",
      request_meta: {
        source: "chat-dialog",
        dispatch_default_injection_mode: "immediate",
        allow_relevance_queue: true,
      },
    });
    expect(state.pending).toBeNull();
    expect(options.focusInput).toHaveBeenCalled();
  });

  test("disambiguation selection preserves routed project hint", async () => {
    const { state, options, handler } = createHarness({
      pending: {
        original: "analyze this",
        project_root: "/tmp/project-a",
        disambiguate: {
          candidates: [{ agent_id: "codex:1" }],
        },
      },
    });

    await handler.handleSubmit("1");

    expect(options.send).toHaveBeenCalledWith({
      type: "prompt",
      text: "Use agent codex:1 to handle: analyze this",
      request_meta: {
        source: "chat-dialog",
        dispatch_default_injection_mode: "immediate",
        allow_relevance_queue: true,
        force_project_root: "/tmp/project-a",
      },
    });
    expect(state.pending).toBeNull();
  });

  test("default prompt path sets pending and forwards text", async () => {
    const { state, options, handler } = createHarness();

    await handler.handleSubmit("run analysis");

    expect(options.queueStatusLine).toHaveBeenCalledWith("ufoo-agent processing");
    expect(options.send).toHaveBeenCalledWith({
      type: "prompt",
      text: "run analysis",
      request_meta: {
        source: "chat-dialog",
        dispatch_default_injection_mode: "immediate",
        allow_relevance_queue: true,
      },
    });
    expect(state.pending).toEqual({ original: "run analysis" });
    expect(options.logMessage).toHaveBeenCalledWith(
      "user",
      "{white-fg}you{/white-fg} {gray-fg}·{/gray-fg} ESC(run analysis)"
    );
    expect(options.logMessage).not.toHaveBeenCalledWith(
      "user",
      "{white-fg}→{/white-fg} ESC(run analysis)"
    );
    expect(options.focusInput).toHaveBeenCalled();
  });

  test("default prompt path decodes escaped newlines before send and echo", async () => {
    const { state, options, handler } = createHarness();

    await handler.handleSubmit("run\\nanalysis");

    expect(options.commitInputHistory).toHaveBeenCalledWith("run\nanalysis");
    expect(options.send).toHaveBeenCalledWith({
      type: "prompt",
      text: "run\nanalysis",
      request_meta: {
        source: "chat-dialog",
        dispatch_default_injection_mode: "immediate",
        allow_relevance_queue: true,
      },
    });
    expect(state.pending).toEqual({ original: "run\nanalysis" });
    expect(options.logMessage).toHaveBeenCalledWith(
      "user",
      "{white-fg}you{/white-fg} {gray-fg}·{/gray-fg} ESC(run\nanalysis)"
    );
  });
});

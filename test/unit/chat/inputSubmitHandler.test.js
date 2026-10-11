const { createInputSubmitHandler } = require("../../../src/app/chat/inputSubmitHandler");

function createHarness(stateOverrides = {}, optionOverrides = {}) {
  const state = {
    targetAgent: null,
    pending: null,
    activeAgentMetaMap: new Map(),
    ...stateOverrides,
  };

  const options = {
    state,
    parseAtTarget: jest.fn(() => null),
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
    activateInternalAgent: jest.fn(() => ({ ok: true })),
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

  test("empty submit focuses an existing internal pane before opening a side pane", async () => {
    const focusMultiPane = jest.fn(async () => true);
    const { options, handler } = createHarness(
      {
        targetAgent: "codex:1",
        activeAgentMetaMap: new Map([["codex:1", { launch_mode: "internal" }]]),
      },
      { focusMultiPane }
    );

    await handler.handleSubmit("");

    expect(focusMultiPane).toHaveBeenCalledWith("codex:1");
    expect(options.activateInternalAgent).not.toHaveBeenCalled();
    expect(options.clearTargetAgent).toHaveBeenCalled();
  });

  test("empty submit with internal target uses internal side pane when focusMultiPane declines", async () => {
    const focusMultiPane = jest.fn(async () => false);
    const { options, handler } = createHarness(
      {
        targetAgent: "ucode:1",
        activeAgentMetaMap: new Map([["ucode:1", { launch_mode: "internal" }]]),
      },
      { focusMultiPane }
    );

    await handler.handleSubmit("");

    expect(focusMultiPane).toHaveBeenCalledWith("ucode:1");
    expect(options.activateInternalAgent).toHaveBeenCalledWith("ucode:1");
  });
  test("a failed internal activation preserves the selected target", async () => {
    const { state, options, handler } = createHarness({ targetAgent: "codex:1" }, {
      focusMultiPane: async () => false,
      activateInternalAgent: jest.fn(() => ({ ok: false, error: "agent offline" })),
    });
    await handler.handleSubmit("");
    expect(state.targetAgent).toBe("codex:1");
    expect(options.clearTargetAgent).not.toHaveBeenCalled();
    expect(options.send).not.toHaveBeenCalled();
    expect(options.focusInput).toHaveBeenCalled();
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
      "› {magenta-fg}@ESC(codex:1){/magenta-fg} ESC(hello\nworld)"
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

  test("internal target selection leaves the main agent status unchanged", async () => {
    const { options, handler } = createHarness({}, {
      requireKnownTarget: true,
      parseAtTarget: jest.fn(() => ({ target: "coder", message: "" })),
      resolveAgentId: jest.fn(() => "codex:1"),
      setTargetAgent: jest.fn(),
    });
    await handler.handleSubmit("@coder");
    expect(options.setTargetAgent).toHaveBeenCalledWith("codex:1");
    expect(options.queueStatusLine).not.toHaveBeenCalled();
    expect(options.send).not.toHaveBeenCalled();
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

  test("slash command echoes friendly summary instead of raw command", async () => {
    const { options, handler } = createHarness();

    await handler.handleSubmit("/group run build-lane");

    expect(options.executeCommand).toHaveBeenCalledWith("/group run build-lane");
    expect(options.logMessage).toHaveBeenCalledWith(
      "user",
      "› ESC(Launching group build-lane)"
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
      "› ESC(run analysis)"
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
      "› ESC(run\nanalysis)"
    );
  });
});

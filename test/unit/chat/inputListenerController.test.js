const { createInputListenerController } = require("../../../src/chat/inputListenerController");

function createHarness(overrides = {}) {
  const completionController = {
    isActive: jest.fn(() => false),
    handleKey: jest.fn(() => false),
    show: jest.fn(),
    hide: jest.fn(),
    jumpToLast: jest.fn(),
  };

  const state = {
    cursorPos: 0,
    preferredCol: null,
  };

  const options = {
    getCurrentView: jest.fn(() => "main"),
    exitHandler: jest.fn(),
    getFocusMode: jest.fn(() => "input"),
    getDashboardView: jest.fn(() => "agents"),
    getSelectedAgentIndex: jest.fn(() => 0),
    getActiveAgents: jest.fn(() => ["codex:1"]),
    getTargetAgent: jest.fn(() => null),
    requestCloseAgent: jest.fn(),
    logMessage: jest.fn(),
    isSuppressKeypress: jest.fn(() => false),
    normalizeCommandPrefix: jest.fn(),
    handleDashboardKey: jest.fn(() => false),
    exitDashboardMode: jest.fn(),
    completionController,
    getLogHeight: jest.fn(() => 10),
    scrollLog: jest.fn(),
    insertTextAtCursor: jest.fn(),
    normalizePaste: jest.fn((text) => text),
    resetPreferredCol: jest.fn(),
    getCursorPos: jest.fn(() => state.cursorPos),
    setCursorPos: jest.fn((value) => {
      state.cursorPos = value;
    }),
    ensureInputCursorVisible: jest.fn(),
    getWrapWidth: jest.fn(() => 10),
    getCursorRowCol: jest.fn(() => ({ row: 0, col: 0 })),
    countLines: jest.fn(() => 3),
    getCursorPosForRowCol: jest.fn(() => 2),
    getPreferredCol: jest.fn(() => state.preferredCol),
    setPreferredCol: jest.fn((value) => {
      state.preferredCol = value;
    }),
    historyUp: jest.fn(() => false),
    historyDown: jest.fn(() => false),
    enterDashboardMode: jest.fn(),
    resizeInput: jest.fn(),
    updateDraftFromInput: jest.fn(),
    ...overrides,
  };

  const controller = createInputListenerController(options);

  const textarea = {
    value: "",
    _done: jest.fn(),
    _updateCursor: jest.fn(),
    screen: { render: jest.fn() },
  };

  return { controller, options, state, completionController, textarea };
}

describe("chat inputListenerController", () => {
  test("requires completionController", () => {
    expect(() => createInputListenerController({})).toThrow(/requires completionController/);
  });

  test("ctrl+c calls exit handler", () => {
    const { controller, options, textarea } = createHarness();
    controller.handleKey("", { name: "c", ctrl: true }, textarea);
    expect(options.exitHandler).toHaveBeenCalled();
  });

  test("ctrl+x closes selected dashboard agent", () => {
    const { controller, options, textarea } = createHarness({
      getFocusMode: jest.fn(() => "dashboard"),
      getDashboardView: jest.fn(() => "agents"),
      getSelectedAgentIndex: jest.fn(() => 0),
      getActiveAgents: jest.fn(() => ["codex:1"]),
    });

    controller.handleKey("", { name: "x", ctrl: true }, textarea);
    expect(options.requestCloseAgent).toHaveBeenCalledWith("codex:1");
  });

  test("ctrl+x in non-agents dashboard view delegates to dashboard handler", () => {
    const { controller, options, textarea } = createHarness({
      getFocusMode: jest.fn(() => "dashboard"),
      getDashboardView: jest.fn(() => "cron"),
    });

    controller.handleKey("", { name: "x", ctrl: true }, textarea);
    expect(options.handleDashboardKey).toHaveBeenCalledWith({ name: "x", ctrl: true });
    expect(options.requestCloseAgent).not.toHaveBeenCalled();
  });

  test("shift+enter inserts newline", () => {
    const { controller, options, textarea } = createHarness();
    controller.handleKey("", { name: "enter", shift: true }, textarea);
    expect(options.insertTextAtCursor).toHaveBeenCalledWith("\n");
    expect(textarea._done).not.toHaveBeenCalled();
  });

  test("enter submits current input", () => {
    const { controller, options, textarea } = createHarness();
    textarea.value = "hello";
    controller.handleKey("", { name: "enter" }, textarea);
    expect(options.resetPreferredCol).toHaveBeenCalled();
    expect(textarea._done).toHaveBeenCalledWith(null, "hello");
  });

  test("history up with active completion slash jumps to last", () => {
    const { controller, completionController, state, textarea } = createHarness();
    completionController.isActive.mockReturnValue(true);
    textarea.value = "/";
    state.cursorPos = 1;

    controller.handleKey("", { name: "up" }, textarea);
    expect(completionController.jumpToLast).toHaveBeenCalled();
  });

  test("history up/down delegates and hides completion", () => {
    const { controller, options, completionController, textarea } = createHarness({
      historyUp: jest.fn(() => true),
    });
    controller.handleKey("", { name: "up" }, textarea);
    expect(options.historyUp).toHaveBeenCalled();
    expect(completionController.hide).toHaveBeenCalled();

    const h2 = createHarness({ historyDown: jest.fn(() => true) });
    h2.controller.handleKey("", { name: "down" }, h2.textarea);
    expect(h2.options.historyDown).toHaveBeenCalled();
    expect(h2.completionController.hide).toHaveBeenCalled();
  });

  test("down at last row enters dashboard mode", () => {
    const { controller, options, textarea } = createHarness({
      getCursorRowCol: jest.fn(() => ({ row: 2, col: 4 })),
      countLines: jest.fn(() => 3),
      getPreferredCol: jest.fn(() => null),
      setPreferredCol: jest.fn(),
    });
    textarea.value = "abc";
    controller.handleKey("", { name: "down" }, textarea);
    expect(options.enterDashboardMode).toHaveBeenCalled();
  });

  test("down enters dashboard mode when wrap width is unavailable", () => {
    const { controller, options, textarea } = createHarness({
      getWrapWidth: jest.fn(() => 0),
    });
    textarea.value = "abc";
    controller.handleKey("", { name: "down" }, textarea);
    expect(options.enterDashboardMode).toHaveBeenCalled();
  });

  test("backspace mutates text and refreshes completion", () => {
    const { controller, options, completionController, state, textarea } = createHarness();
    textarea.value = "/ab";
    state.cursorPos = 3;

    controller.handleKey("", { name: "backspace" }, textarea);

    expect(textarea.value).toBe("/a");
    expect(options.setCursorPos).toHaveBeenCalledWith(2);
    expect(options.resizeInput).toHaveBeenCalled();
    expect(options.updateDraftFromInput).toHaveBeenCalled();
    expect(completionController.show).toHaveBeenCalledWith("/a");
  });

  test("backspace keeps @mention completion active", () => {
    const { controller, completionController, state, textarea } = createHarness();
    textarea.value = "@ab";
    state.cursorPos = 3;

    controller.handleKey("", { name: "backspace" }, textarea);

    expect(textarea.value).toBe("@a");
    expect(completionController.show).toHaveBeenCalledWith("@a");
  });

  test("printable char inserts and updates completion", () => {
    const { controller, options, completionController, state, textarea } = createHarness();
    textarea.value = "/a";
    state.cursorPos = 2;

    controller.handleKey("b", { name: "b" }, textarea);

    expect(textarea.value).toBe("/ab");
    expect(options.setCursorPos).toHaveBeenCalledWith(3);
    expect(options.normalizeCommandPrefix).toHaveBeenCalled();
    expect(options.resizeInput).toHaveBeenCalled();
    expect(options.updateDraftFromInput).toHaveBeenCalled();
    expect(completionController.show).toHaveBeenCalledWith("/ab");
  });

  test("printable char under @mention shows completion", () => {
    const { controller, completionController, state, textarea } = createHarness();
    textarea.value = "@a";
    state.cursorPos = 2;

    controller.handleKey("b", { name: "b" }, textarea);

    expect(textarea.value).toBe("@ab");
    expect(completionController.show).toHaveBeenCalledWith("@ab");
  });
});

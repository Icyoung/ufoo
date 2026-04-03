const { createCompletionController } = require("../../../src/chat/completionController");

function createHarness(overrides = {}) {
  let cursorPos = 0;
  const input = {
    value: "",
    _updateCursor: jest.fn(),
  };
  const screen = {
    height: 30,
    width: 100,
  };
  const completionPanel = {
    height: 0,
    bottom: 0,
    width: 90,
    hidden: true,
    setContent: jest.fn(),
  };
  const promptBox = { width: 2 };

  const options = {
    input,
    screen,
    completionPanel,
    promptBox,
    commandRegistry: [
      {
        cmd: "/bus",
        desc: "Event bus operations",
        subcommands: [
          { cmd: "send", desc: "Send message" },
          { cmd: "list", desc: "List agents" },
        ],
      },
      {
        cmd: "/launch",
        desc: "Launch agent",
        subcommands: [
          { cmd: "codex", desc: "Launch Codex" },
        ],
      },
      {
        cmd: "/group",
        desc: "Group ops",
        subcommands: [
          { cmd: "run", desc: "Launch a group template", order: 1 },
          { cmd: "status", desc: "Show group status", order: 2 },
        ],
      },
      {
        cmd: "/solo",
        desc: "Solo ops",
        subcommands: [
          { cmd: "run", desc: "Launch a solo role agent", order: 1 },
          { cmd: "list", desc: "List solo roles", order: 2 },
        ],
      },
      {
        cmd: "/status",
        desc: "Show status",
      },
    ],
    getGroupTemplateCandidates: jest.fn(() => [
      { alias: "product-discovery", name: "Product Discovery", source: "builtin" },
      { alias: "build-lane", name: "Build Lane", source: "builtin" },
    ]),
    getSoloProfileCandidates: jest.fn(() => [
      { cmd: "design-critic", desc: "Audit the interface · builtin" },
      { cmd: "implementation-lead", desc: "Turn plan into code · builtin" },
    ]),
    getMentionCandidates: jest.fn(() => [
      { id: "codex:1", label: "codex-1" },
      { id: "claude:2", label: "claude-2" },
    ]),
    normalizeCommandPrefix: jest.fn(),
    truncateText: jest.fn((value) => value),
    getCurrentInputHeight: jest.fn(() => 5),
    getCursorPos: jest.fn(() => cursorPos),
    setCursorPos: jest.fn((value) => {
      cursorPos = value;
    }),
    resetPreferredCol: jest.fn(),
    updateDraftFromInput: jest.fn(),
    renderScreen: jest.fn(),
    setImmediateFn: jest.fn((fn) => {
      fn();
      return 1;
    }),
    clearImmediateFn: jest.fn(),
    ...overrides,
  };

  const controller = createCompletionController(options);
  return { controller, options, input, completionPanel, screen, promptBox };
}

describe("chat completionController", () => {
  test("requires required widgets", () => {
    expect(() => createCompletionController({})).toThrow(
      /requires input\/screen\/completionPanel\/promptBox/
    );
  });

  test("show displays matching main commands", () => {
    const { controller, input, completionPanel } = createHarness();
    input.value = "/b";

    controller.show(input.value);

    expect(controller.isActive()).toBe(true);
    expect(controller.getCommandCount()).toBe(1);
    expect(completionPanel.hidden).toBe(false);
    expect(completionPanel.setContent).toHaveBeenCalledWith(expect.stringContaining("/bus"));
  });

  test("show supports @mention candidates", () => {
    const { controller, input, completionPanel } = createHarness();
    input.value = "@co";

    controller.show(input.value);

    expect(controller.isActive()).toBe(true);
    expect(controller.getCommandCount()).toBe(1);
    expect(completionPanel.hidden).toBe(false);
    expect(completionPanel.setContent).toHaveBeenLastCalledWith(expect.stringContaining("@codex-1"));
  });

  test("launch subcommand mode includes fallback launch targets", () => {
    const { controller, input, completionPanel } = createHarness();
    input.value = "/launch ";

    controller.show(input.value);

    expect(controller.isActive()).toBe(true);
    expect(controller.getCommandCount()).toBe(3);
    expect(completionPanel.setContent).toHaveBeenLastCalledWith(expect.stringContaining("claude"));
    expect(completionPanel.setContent).toHaveBeenLastCalledWith(expect.stringContaining("ucode"));
    expect(completionPanel.setContent).not.toHaveBeenLastCalledWith(expect.stringContaining("ufoo"));
  });

  test("group run shows template candidates after subcommand confirmation", () => {
    const { controller, input, completionPanel } = createHarness();
    input.value = "/group ";

    controller.show(input.value);
    const handled = controller.handleKey("", { name: "enter" });

    expect(handled).toBe(true);
    expect(input.value).toBe("/group run ");
    expect(controller.isActive()).toBe(true);
    expect(completionPanel.setContent).toHaveBeenLastCalledWith(expect.stringContaining("product-discovery"));
  });

  test("group run with trailing space lists group templates", () => {
    const { controller, input, completionPanel } = createHarness();
    input.value = "/group run ";

    controller.show(input.value);

    expect(controller.isActive()).toBe(true);
    expect(controller.getCommandCount()).toBe(2);
    expect(completionPanel.setContent).toHaveBeenLastCalledWith(expect.stringContaining("build-lane"));
  });

  test("solo run shows role candidates after subcommand confirmation", () => {
    const { controller, input, completionPanel } = createHarness();
    input.value = "/solo ";

    controller.show(input.value);
    const handled = controller.handleKey("", { name: "enter" });

    expect(handled).toBe(true);
    expect(input.value).toBe("/solo run ");
    expect(controller.isActive()).toBe(true);
    expect(completionPanel.setContent).toHaveBeenLastCalledWith(expect.stringContaining("design-critic"));
  });

  test("solo run with trailing space lists solo roles", () => {
    const { controller, input, completionPanel } = createHarness();
    input.value = "/solo run ";

    controller.show(input.value);

    expect(controller.isActive()).toBe(true);
    expect(controller.getCommandCount()).toBe(2);
    expect(completionPanel.setContent).toHaveBeenLastCalledWith(expect.stringContaining("implementation-lead"));
  });

  test("solo role candidate confirms profile with trailing space", () => {
    const { controller, input } = createHarness();
    input.value = "/solo run des";

    controller.show(input.value);
    const handled = controller.handleKey("", { name: "tab" });

    expect(handled).toBe(true);
    expect(input.value).toBe("/solo run design-critic ");
    expect(controller.isActive()).toBe(false);
  });

  test("group template candidate confirms alias with trailing space", () => {
    const { controller, input } = createHarness();
    input.value = "/group run pr";

    controller.show(input.value);
    const handled = controller.handleKey("", { name: "tab" });

    expect(handled).toBe(true);
    expect(input.value).toBe("/group run product-discovery ");
    expect(controller.isActive()).toBe(false);
  });

  test("tab confirms selected command", () => {
    const { controller, input } = createHarness();
    input.value = "/";

    controller.show(input.value);
    controller.jumpToLast();
    const handled = controller.handleKey("", { name: "tab" });

    expect(handled).toBe(true);
    expect(input.value).toBe("/status ");
    expect(controller.isActive()).toBe(false);
  });

  test("tab confirms selected @mention", () => {
    const { controller, input } = createHarness();
    input.value = "@";

    controller.show(input.value);
    controller.jumpToLast();
    const handled = controller.handleKey("", { name: "tab" });

    expect(handled).toBe(true);
    expect(input.value).toBe("@codex-1 ");
    expect(controller.isActive()).toBe(false);
  });

  test("enter on incomplete candidate applies preview and consumes key", () => {
    const { controller, input } = createHarness();
    input.value = "/sta";

    controller.show(input.value);
    const handled = controller.handleKey("", { name: "enter" });

    expect(handled).toBe(true);
    expect(input.value).toBe("/status ");
    expect(controller.isActive()).toBe(false);
  });

  test("enter on complete candidate returns false to allow submit", () => {
    const { controller, input } = createHarness();
    input.value = "/status ";

    controller.show(input.value);
    const handled = controller.handleKey("", { name: "enter" });

    expect(handled).toBe(false);
    expect(controller.isActive()).toBe(false);
  });

  test("space after bare slash command keeps completion active", () => {
    const { controller, input } = createHarness();
    input.value = "/bus";

    controller.show(input.value);
    const handled = controller.handleKey(" ", { name: "space" });

    expect(handled).toBe(false);
    expect(controller.isActive()).toBe(true);
  });

  test("space after command with argument hides completion", () => {
    const { controller, input } = createHarness();
    input.value = "/bus s";

    controller.show(input.value);
    const handled = controller.handleKey(" ", { name: "space" });

    expect(handled).toBe(false);
    expect(controller.isActive()).toBe(false);
  });

  test("reflow keeps completion visible after screen height change", () => {
    const { controller, input, screen, completionPanel } = createHarness();
    input.value = "/";

    controller.show(input.value);
    screen.height = 12;
    controller.reflow();

    expect(controller.isActive()).toBe(true);
    expect(completionPanel.bottom).toBe(4);
  });
});

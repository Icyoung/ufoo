const fs = require("fs");
const { createMultiWindowController } = require("../../../../src/app/chat/multiWindow");
const { calculatePaneLayout } = require("../../../../src/app/chat/multiWindow/paneLayout");

describe("multiWindow controller", () => {
  let existsSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    existsSpy.mockRestore();
  });

  test("renders agent pane labels with display names", () => {
    let output = "";
    const controller = createMultiWindowController({
      processStdout: { write: (data) => { output += data; return true; } },
      getRows: () => 24,
      getCols: () => 80,
      getActiveAgents: () => ["codex:abc"],
      getInjectSockPath: () => "/tmp/missing.sock",
      getAgentLabel: () => "builder",
    });

    expect(controller.enter()).toBe(true);
    expect(output).toContain(" builder ");
    expect(output).not.toContain(" codex:abc ");
  });

  test("renders internal pane content without socket waiting message", () => {
    let output = "";
    const controller = createMultiWindowController({
      processStdout: { write: (data) => { output += data; return true; } },
      getRows: () => 24,
      getCols: () => 80,
      getActiveAgents: () => ["codex:internal"],
      getInjectSockPath: () => "/tmp/missing.sock",
      getAgentLabel: () => "internal",
      getInternalPaneInfo: () => ({ status: "working", detail: "thinking", input: "" }),
      getAgentPaneOptions: () => ({
        mode: "internal",
        initialLines: ["internal log"],
      }),
    });

    expect(controller.enter()).toBe(true);
    expect(output).toContain("internal log");
    expect(output).toContain("ufoo · internal · working · thinking");
    expect(output).toContain("› ");
    expect(output).not.toContain("inject.sock not found");
    expect(output).not.toContain(" ufoo  agents");
  });

  test("clears stale completion popup rows when completions close", () => {
    let output = "";
    let completions = {
      items: [
        { label: "/agents", description: "list agents" },
        { label: "/bus", description: "bus tools" },
      ],
      index: 0,
      windowStart: 0,
      pageSize: 8,
    };
    const cols = 60;
    const rows = 24;
    const controller = createMultiWindowController({
      processStdout: { write: (data) => { output += data; return true; } },
      getRows: () => rows,
      getCols: () => cols,
      getActiveAgents: () => ["codex:abc"],
      getInjectSockPath: () => "/tmp/missing.sock",
      getCompletions: () => completions,
    });

    expect(controller.enter()).toBe(true);
    expect(output).toContain("/agents");

    const layout = calculatePaneLayout(cols, rows, 1);
    const popupTop = layout.inputPane.top - completions.items.length - 1;
    output = "";
    completions = { items: [], index: -1, windowStart: 0, pageSize: 8 };
    controller.renderAll();

    expect(output).toContain(`\x1b[${popupTop + 1};1H${" ".repeat(cols)}`);
  });

  test("renders typed internal pane input and submits it", () => {
    let output = "";
    const onInternalSubmit = jest.fn();
    const controller = createMultiWindowController({
      processStdout: { write: (data) => { output += data; return true; } },
      getRows: () => 24,
      getCols: () => 80,
      getActiveAgents: () => ["codex:internal"],
      getAgentLabel: () => "internal",
      getAgentPaneOptions: () => ({ mode: "internal" }),
      getTerminalFocused: () => true,
      onInternalSubmit,
    });

    expect(controller.enter()).toBe(true);
    output = "";
    controller.focusAgent("codex:internal");
    controller.sendInput("hello");
    expect(output).toContain("hello");

    controller.sendInput("\r");
    expect(onInternalSubmit).toHaveBeenCalledWith("codex:internal", "hello");
  });
});

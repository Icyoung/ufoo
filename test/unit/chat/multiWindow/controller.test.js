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

  test("clears stale completion popup rows when completions close", async () => {
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
    // renderAll is throttled right after enter(); wait for the trailing frame.
    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(output).toContain(`\x1b[${popupTop + 1};1H${" ".repeat(cols)}`);
    controller.exit();
  });

  test("renders typed internal pane input and submits it", async () => {
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
    // pane output is batched; wait for the batch to flush.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(output).toContain("hello");

    controller.sendInput("\r");
    expect(onInternalSubmit).toHaveBeenCalledWith("codex:internal", "hello");
    controller.exit();
  });

  test("renderAll coalesces bursts into one trailing frame", async () => {
    let output = "";
    let status = "initial";
    const controller = createMultiWindowController({
      processStdout: { write: (data) => { output += data; return true; } },
      getRows: () => 24,
      getCols: () => 80,
      getActiveAgents: () => ["codex:abc"],
      getInjectSockPath: () => "/tmp/missing.sock",
      getStatusText: () => status,
    });

    expect(controller.enter()).toBe(true);
    output = "";
    for (const s of ["s1", "s2", "s3", "s4", "s5"]) {
      status = s;
      controller.renderAll();
    }
    // enter() just rendered, so the burst must not repaint synchronously.
    expect(output).not.toContain("s1");
    expect(output).not.toContain("s5");

    await new Promise((resolve) => setTimeout(resolve, 180));
    // the trailing frame renders only the latest state.
    expect(output).toContain("s5");
    expect(output).not.toContain("s3");
    controller.exit();
  });

  test("renderAll repaints immediately once the throttle window has passed", async () => {
    let output = "";
    let status = "initial";
    const controller = createMultiWindowController({
      processStdout: { write: (data) => { output += data; return true; } },
      getRows: () => 24,
      getCols: () => 80,
      getActiveAgents: () => ["codex:abc"],
      getInjectSockPath: () => "/tmp/missing.sock",
      getStatusText: () => status,
    });

    expect(controller.enter()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    output = "";
    status = "next";
    controller.renderAll();
    expect(output).toContain("next");
    controller.exit();
  });

  test("batches focused pane output instead of repainting every chunk", async () => {
    let output = "";
    const controller = createMultiWindowController({
      processStdout: { write: (data) => { output += data; return true; } },
      getRows: () => 24,
      getCols: () => 80,
      getActiveAgents: () => ["codex:abc"],
      getInjectSockPath: () => "/tmp/missing.sock",
      getTerminalFocused: () => true,
    });

    expect(controller.enter()).toBe(true);
    output = "";
    controller.writeToPane("codex:abc", "chunk-one ");
    controller.writeToPane("codex:abc", "chunk-two");
    // focused panes no longer repaint per chunk; output flushes in one batch.
    expect(output).not.toContain("chunk-one");

    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(output).toContain("chunk-one");
    expect(output).toContain("chunk-two");
    controller.exit();
  });
});

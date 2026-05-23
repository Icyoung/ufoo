const fs = require("fs");
const { createPaneManager } = require("../../../../src/chat/multiWindow/paneManager");

describe("paneManager", () => {
  let existsSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    existsSpy.mockRestore();
  });

  test("missing inject socket writes status into the pane", () => {
    const onPaneOutput = jest.fn();
    const manager = createPaneManager({
      getInjectSockPath: () => "/tmp/missing-inject.sock",
      onPaneOutput,
    });

    manager.addAgent("codex:1", 40, 8);

    const pane = manager.getPane("codex:1");
    expect(pane.vt.getLine(0)).toContain("[waiting] inject.sock not found");
    expect(onPaneOutput).toHaveBeenCalledWith("codex:1");
  });

  test("internal panes use provided lines without probing inject socket", () => {
    const onPaneOutput = jest.fn();
    const manager = createPaneManager({
      getInjectSockPath: () => "/tmp/missing-inject.sock",
      onPaneOutput,
    });

    manager.addAgent("codex:1", 40, 8, {
      mode: "internal",
      initialLines: ["internal agent", "ready"],
    });

    const pane = manager.getPane("codex:1");
    expect(pane.mode).toBe("internal");
    expect(pane.vt.getLine(0)).toContain("internal agent");
    expect(pane.vt.getLine(1)).toContain("ready");
    expect(pane.vt.getLine(0)).not.toContain("inject.sock");
  });

  test("internal panes keep editable input and submit through callback", () => {
    const onPaneOutput = jest.fn();
    const onInternalSubmit = jest.fn();
    const manager = createPaneManager({
      getInjectSockPath: () => "/tmp/missing-inject.sock",
      onPaneOutput,
      onInternalSubmit,
    });

    manager.addAgent("codex:1", 40, 8, { mode: "internal" });
    manager.sendInput("h");
    manager.sendInput("i");

    let pane = manager.getPane("codex:1");
    expect(pane.internalInput).toBe("hi");
    expect(pane.internalCursor).toBe(2);

    manager.sendInput("\x7f");
    pane = manager.getPane("codex:1");
    expect(pane.internalInput).toBe("h");
    expect(pane.internalCursor).toBe(1);

    manager.sendInput("ey");
    manager.sendInput("\r");
    pane = manager.getPane("codex:1");
    expect(onInternalSubmit).toHaveBeenCalledWith("codex:1", "hey");
    expect(pane.internalInput).toBe("");
    expect(pane.vt.getLine(1)).toContain("> hey");
  });
});

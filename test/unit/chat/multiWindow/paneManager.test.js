const fs = require("fs");
const { createPaneManager } = require("../../../../src/app/chat/multiWindow/paneManager");

describe("paneManager", () => {
  let existsSpy;

  beforeEach(() => {
    existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    existsSpy.mockRestore();
  });

  test("external socket panes are rejected without opening a connection", () => {
    const onPaneOutput = jest.fn();
    const manager = createPaneManager({
      getInjectSockPath: () => "/tmp/missing-inject.sock",
      onPaneOutput,
    });

    const connect = jest.spyOn(require("net"), "createConnection");
    try {
      expect(() => manager.addAgent("codex:1", 40, 8, { mode: "socket" })).toThrow("internal agents only");
      expect(manager.getPane("codex:1")).toBeNull();
      expect(connect).not.toHaveBeenCalled();
      expect(onPaneOutput).not.toHaveBeenCalled();
    } finally { connect.mockRestore(); }
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
    expect(pane.surface.snapshot().entries[0].text).toBe("internal agent\r\nready");
    expect(pane.surface.snapshot().entries[0].text).not.toContain("inject.sock");
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
    expect(pane.surface.snapshot()).toMatchObject({ busy: true, status: "Waiting for agent…" });
    expect(pane.surface.snapshot().entries).toEqual([expect.objectContaining({ kind: "user", text: "hey" })]);
  });

  test("delivery failures stop loading and keep the draft available to retry", async () => {
    const manager = createPaneManager({ onInternalSubmit: () => Promise.reject(new Error("daemon offline")) });
    manager.addAgent("codex:1", 40, 8);
    manager.sendInput("hello"); manager.sendInput("\r");
    await Promise.resolve();
    expect(manager.getPane("codex:1").internalInput).toBe("hello");
    expect(manager.getPane("codex:1").surface.snapshot()).toMatchObject({ busy: false, status: "error" });
    expect(manager.getPane("codex:1").surface.snapshot().entries.at(-1).text).toContain("daemon offline");
  });

  test("layout commands do not leave a child spinner running", () => {
    const manager = createPaneManager();
    manager.addAgent("codex:1", 40, 8);
    manager.sendInput("/multi off"); manager.sendInput("\r");
    expect(manager.getPane("codex:1").surface.snapshot().busy).toBe(false);
  });

  test("shared multiline input navigation edits Unicode without submitting the draft", () => {
    const submit = jest.fn();
    const manager = createPaneManager({ onInternalSubmit: submit });
    manager.addAgent("native", 30, 10);
    manager.sendInput("你好🙂abc\nsecond line");
    manager.sendInput("\x1b[H");
    manager.sendInput("\x1b[C");
    manager.sendInput("\x1b[C");
    manager.sendInput("\x1b[3~");
    expect(manager.getPane("native").internalInput).toBe("你好abc\nsecond line");
    manager.sendInput("\x1b[F");
    manager.sendInput("\x17");
    expect(manager.getPane("native").internalInput).toBe("你好abc\nsecond");
    manager.sendInput("\x1b[A");
    expect(manager.getPane("native").internalCursor).toBeLessThan(6);
    expect(submit).not.toHaveBeenCalled();
  });

  test("the shared input supports ucode line shortcuts without changing other lines", () => {
    const manager = createPaneManager();
    manager.addAgent("native", 30, 10);
    manager.sendInput("first\n你好second");
    manager.sendInput("\x01");
    manager.sendInput("\x1b[C");
    manager.sendInput("\x1b[C");
    manager.sendInput("\x15");
    expect(manager.getPane("native").internalInput).toBe("first\nsecond");
    manager.sendInput("\x05");
    manager.sendInput("\x1b[D");
    manager.sendInput("\x0b");
    expect(manager.getPane("native").internalInput).toBe("first\nsecon");
  });
});

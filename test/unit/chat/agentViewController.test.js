const { createAgentViewController } = require("../../../src/chat/agentViewController");

function stripAnsi(value = "") {
  return String(value || "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function createHarness(overrides = {}) {
  let focusMode = "input";
  let selectedAgentIndex = -1;
  let dashboardView = "agents";
  let windowStart = 0;

  const childA = { id: "a" };
  const childB = { id: "b" };
  const children = [childA, childB];

  const screen = {
    children,
    render: jest.fn(),
    remove: jest.fn((child) => {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
    }),
    append: jest.fn((child) => {
      children.push(child);
    }),
    alloc: jest.fn(),
    realloc: jest.fn(),
    program: {
      showCursor: jest.fn(),
    },
    grabKeys: false,
  };
  const input = {
    _updateCursor: jest.fn(),
  };
  const processStdout = {
    rows: 30,
    columns: 100,
    write: jest.fn(),
  };
  const connectAgentOutput = jest.fn();
  const disconnectAgentOutput = jest.fn();
  const connectAgentInput = jest.fn();
  const disconnectAgentInput = jest.fn();
  const sendRaw = jest.fn();
  const sendBusMessage = jest.fn();
  const sendBusWatch = jest.fn();
  const sendResize = jest.fn();
  const requestScreenSnapshot = jest.fn();
  const setFocusMode = jest.fn((value) => { focusMode = value; });
  const setSelectedAgentIndex = jest.fn((value) => { selectedAgentIndex = value; });
  const setDashboardView = jest.fn((value) => { dashboardView = value; });
  const setAgentListWindowStart = jest.fn((value) => { windowStart = value; });
  const setScreenGrabKeys = jest.fn((value) => { screen.grabKeys = Boolean(value); });
  const clearTargetAgent = jest.fn();
  const renderDashboard = jest.fn();
  const focusInput = jest.fn();
  const resizeInput = jest.fn();
  const renderScreen = jest.fn();
  const now = jest.fn(() => 1000);
  const setTimeoutFn = jest.fn((fn) => {
    fn();
    return 1;
  });
  const computeAgentBar = jest.fn(() => ({ bar: "BAR", windowStart: 2 }));

  const controller = createAgentViewController({
    screen,
    input,
    processStdout,
    now,
    setTimeoutFn,
    computeAgentBar,
    agentBarHints: { normal: "n", dashboard: "d" },
    maxAgentWindow: 4,
    getFocusMode: () => focusMode,
    setFocusMode,
    getSelectedAgentIndex: () => selectedAgentIndex,
    setSelectedAgentIndex,
    getActiveAgents: () => ["codex:1", "claude:1"],
    getAgentListWindowStart: () => windowStart,
    setAgentListWindowStart,
    getAgentLabel: (id) => id,
    getProjectRoot: () => "/Users/icy/Code/ufoo",
    setDashboardView,
    setScreenGrabKeys,
    clearTargetAgent,
    renderDashboard,
    focusInput,
    resizeInput,
    renderScreen,
    getInjectSockPath: (id) => `/tmp/${id}.sock`,
    connectAgentOutput,
    disconnectAgentOutput,
    connectAgentInput,
    disconnectAgentInput,
    sendRaw,
    sendBusMessage,
    sendBusWatch,
    sendResize,
    requestScreenSnapshot,
    ...overrides,
  });

  return {
    controller,
    screen,
    input,
    processStdout,
    connectAgentOutput,
    disconnectAgentOutput,
    connectAgentInput,
    disconnectAgentInput,
    sendRaw,
    sendBusMessage,
    sendBusWatch,
    sendResize,
    requestScreenSnapshot,
    setFocusMode,
    setSelectedAgentIndex,
    setDashboardView,
    setAgentListWindowStart,
    setScreenGrabKeys,
    clearTargetAgent,
    renderDashboard,
    focusInput,
    resizeInput,
    renderScreen,
    computeAgentBar,
    getState: () => ({ focusMode, selectedAgentIndex, dashboardView, windowStart }),
  };
}

describe("chat agentViewController", () => {
  test("requires screen", () => {
    expect(() => createAgentViewController({})).toThrow(/requires screen\.render/);
  });

  test("enterAgentView switches to agent mode and connects sockets", () => {
    const {
      controller,
      connectAgentOutput,
      connectAgentInput,
      sendResize,
      requestScreenSnapshot,
      processStdout,
      getState,
    } = createHarness();

    controller.enterAgentView("codex:1");

    expect(controller.getCurrentView()).toBe("agent");
    expect(controller.getViewingAgent()).toBe("codex:1");
    expect(connectAgentOutput).toHaveBeenCalledWith("/tmp/codex:1.sock");
    expect(connectAgentInput).toHaveBeenCalledWith("/tmp/codex:1.sock");
    expect(sendResize).toHaveBeenCalledWith(100, 29);
    expect(requestScreenSnapshot).toHaveBeenCalled();
    expect(controller.getAgentInputSuppressUntil()).toBe(1300);
    expect(getState().focusMode).toBe("input");
    expect(processStdout.write).toHaveBeenCalled();
  });

  test("enterAgentView in internal bus mode renders plain log and horizontal input lines", () => {
    const {
      controller,
      connectAgentOutput,
      connectAgentInput,
      processStdout,
      sendBusWatch,
    } = createHarness();

    controller.enterAgentView("codex:1", { useBus: true });

    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(controller.isAgentViewUsesBus()).toBe(true);
    expect(connectAgentOutput).not.toHaveBeenCalled();
    expect(connectAgentInput).not.toHaveBeenCalled();
    expect(sendBusWatch).toHaveBeenCalledWith("codex:1", true);
    expect(output).toContain("╭");
    expect(output).toContain(">_ OpenAI Codex (ufoo v");
    expect(output).toContain("model:     codex:1 · managed headless");
    expect(output).toContain("directory: ~/Code/ufoo");
    expect(output).toContain("────────────────────");
    expect(output).toContain("> ");
    expect(output).not.toContain("Welcome to ufoo internal");
    expect(output).not.toContain("▐▛███▜▌");
    expect(output).not.toContain("Enter 发送 · Esc 返回 · ↓ agent bar");
    expect(output).not.toContain("┌ ufoo internal");
    expect(output).not.toContain("│> ");
  });

  test("internal bus mode renders activity status with elapsed timer", () => {
    let nowMs = 16000;
    const intervalHandle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => intervalHandle);
    const clearIntervalFn = jest.fn();
    const {
      controller,
      processStdout,
    } = createHarness({
      now: () => nowMs,
      setIntervalFn,
      clearIntervalFn,
      getAgentStates: () => ({ "codex:1": "working" }),
      getAgentActivityMeta: () => ({
        activity_state: "working",
        activity_since: new Date(10000).toISOString(),
        activity_detail: "tool dispatch_message",
      }),
    });

    controller.enterAgentView("codex:1", { useBus: true });

    let output = stripAnsi(processStdout.write.mock.calls.map((call) => call[0]).join(""));
    expect(output).toContain("working · 6 s · tool dispatch_message");
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(intervalHandle.unref).toHaveBeenCalled();

    processStdout.write.mockClear();
    nowMs = 17000;
    setIntervalFn.mock.calls[0][0]();
    output = stripAnsi(processStdout.write.mock.calls.map((call) => call[0]).join(""));
    expect(output).toContain("working · 7 s · tool dispatch_message");

    controller.exitAgentView();
    expect(clearIntervalFn).toHaveBeenCalledWith(intervalHandle);
  });

  test("exitAgentView unsubscribes internal bus watch", () => {
    const { controller, sendBusWatch } = createHarness();

    controller.enterAgentView("codex:1", { useBus: true });
    controller.exitAgentView();

    expect(sendBusWatch).toHaveBeenCalledWith("codex:1", true);
    expect(sendBusWatch).toHaveBeenCalledWith("codex:1", false);
  });

  test("enterAgentView in claude internal bus mode renders claude-style header", () => {
    const { controller, processStdout } = createHarness();

    controller.enterAgentView("claude-code:1", { useBus: true });

    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    const plain = stripAnsi(output);
    expect(output).toContain("\x1b[38;2;217;119;87m ▐▛███▜▌\x1b[0m");
    expect(output).toContain("\x1b[38;2;217;119;87m▝▜█████▛▘\x1b[0m");
    expect(output).toContain("\x1b[38;2;217;119;87m  ▘▘ ▝▝  \x1b[0m");
    expect(plain).toContain(" ▐▛███▜▌   ClaudeCodev");
    expect(plain).toContain("▝▜█████▛▘  claude-code:1 · managed headless");
    expect(plain).toContain("  ▘▘ ▝▝    ~/Code/ufoo");
    expect(output).not.toContain("Welcome to ufoo internal");
  });

  test("internal startup style uses subscriber id before display nickname", () => {
    const { controller, processStdout } = createHarness({
      getAgentLabel: () => "claude-ish nickname",
    });

    controller.enterAgentView("codex:1", { useBus: true });

    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain(">_ OpenAI Codex (ufoo v");
    expect(output).toContain("model:     claude-ish nickname · managed headless");
    expect(output).not.toContain("▐▛███▜▌Claude Code");
  });

  test("codex startup box fits long labels and paths within terminal width", () => {
    const narrowStdout = {
      rows: 30,
      columns: 48,
      write: jest.fn(),
    };
    const { controller } = createHarness({
      processStdout: narrowStdout,
      getAgentLabel: () => "codex-with-a-very-long-display-name-that-would-wrap",
      getProjectRoot: () => "/Users/icy/Code/some/really/long/project/path/that/would/wrap",
    });

    controller.enterAgentView("codex:1", { useBus: true });

    const lines = narrowStdout.write.mock.calls
      .map((call) => call[0])
      .filter((value) => value.includes("╭") || value.includes("│ ") || value.includes("╰"))
      .map((value) => value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.length <= narrowStdout.columns)).toBe(true);
    expect(lines.join("\n")).toContain("…");
  });

  test("internal bus startup header adapts after terminal resize", () => {
    const resizeStdout = {
      rows: 30,
      columns: 100,
      write: jest.fn(),
    };
    const { controller } = createHarness({
      processStdout: resizeStdout,
    });

    controller.enterAgentView("codex:1", { useBus: true });
    resizeStdout.columns = 42;
    resizeStdout.write.mockClear();

    expect(controller.handleResizeInAgentView()).toBe(true);

    const lines = resizeStdout.write.mock.calls
      .map((call) => call[0])
      .filter((value) => value.includes("╭") || value.includes("│ ") || value.includes("╰"))
      .map((value) => stripAnsi(value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.length <= resizeStdout.columns)).toBe(true);
    expect(lines.join("\n")).toContain("OpenAI Codex");
  });

  test("internal resize uses blessed screen dimensions when available", () => {
    const { controller, screen, processStdout, sendResize } = createHarness();
    screen.width = 44;
    screen.height = 18;
    processStdout.columns = 100;
    processStdout.rows = 30;

    controller.enterAgentView("codex:1", { useBus: true });
    sendResize.mockClear();
    processStdout.write.mockClear();

    expect(controller.handleResizeInAgentView()).toBe(true);
    expect(sendResize).toHaveBeenCalledWith(44, 17);

    const lines = processStdout.write.mock.calls
      .map((call) => call[0])
      .filter((value) => value.includes("╭") || value.includes("│ ") || value.includes("╰"))
      .map((value) => stripAnsi(value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.length <= 44)).toBe(true);
  });

  test("internal bus mode positions cursor by display width for wide input", () => {
    const { controller, processStdout } = createHarness();

    controller.enterAgentView("codex:1", { useBus: true });
    processStdout.write.mockClear();
    expect(controller.handleBusAgentKey("你", { name: "你" })).toBe(true);

    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("> 你");
    expect(output).toContain("\x1b[28;5H");
  });

  test("internal bus mode deletes a full grapheme before cursor", () => {
    const { controller, processStdout } = createHarness();

    controller.enterAgentView("codex:1", { useBus: true });
    processStdout.write.mockClear();
    expect(controller.handleBusAgentKey("你", { name: "你" })).toBe(true);
    processStdout.write.mockClear();
    expect(controller.handleBusAgentKey("", { name: "backspace" })).toBe(true);

    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("> ");
    expect(output).not.toContain("> 你");
    expect(output).toContain("\x1b[28;3H");
  });

  test("internal bus mode edits local input and submits direct bus message", () => {
    const {
      controller,
      sendBusMessage,
      processStdout,
    } = createHarness();

    controller.enterAgentView("codex:1", { useBus: true });
    processStdout.write.mockClear();

    expect(controller.handleBusAgentKey("h", { name: "h" })).toBe(true);
    expect(controller.handleBusAgentKey("i", { name: "i" })).toBe(true);
    expect(controller.handleBusAgentKey("", { name: "backspace" })).toBe(true);
    expect(controller.handleBusAgentKey("!", { name: "!" })).toBe(true);
    expect(controller.handleBusAgentKey("", { name: "enter" })).toBe(true);

    expect(sendBusMessage).toHaveBeenCalledWith("codex:1", "h!");
    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("> h!");
    expect(output).not.toContain("│> h!");
  });

  test("internal bus mode separates submitted prompt from following reply", () => {
    const { controller, processStdout } = createHarness();

    controller.enterAgentView("codex:1", { useBus: true });
    controller.handleBusAgentKey("q", { name: "q" });
    controller.handleBusAgentKey("", { name: "enter" });
    processStdout.write.mockClear();

    controller.writeToAgentTerm("answer");

    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("> q");
    expect(output).toContain("• answer");
    expect(output).not.toContain("> qanswer");
  });

  test("internal bus mode renders streamed output with reply marker", () => {
    const { controller, processStdout } = createHarness();

    controller.enterAgentView("codex:1", { useBus: true });
    processStdout.write.mockClear();
    controller.writeToAgentTerm("hello\r\nworld");

    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("• hello");
    expect(output).toContain("  world");
  });

  test("internal bus mode wraps long output instead of truncating", () => {
    const narrowStdout = {
      rows: 12,
      columns: 20,
      write: jest.fn(),
    };
    const { controller } = createHarness({
      processStdout: narrowStdout,
    });

    controller.enterAgentView("codex:1", { useBus: true });
    narrowStdout.write.mockClear();
    controller.writeToAgentTerm("abcdefghijklmnopqrstuvwxyz");

    const output = narrowStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).toContain("• abcdefghijklmnopqr");
    expect(output).toContain("uvwxyz");
    expect(output).not.toContain("…");
  });

  test("exitAgentView restores blessed mode and focus", () => {
    const {
      controller,
      disconnectAgentOutput,
      disconnectAgentInput,
      setDashboardView,
      setSelectedAgentIndex,
      setScreenGrabKeys,
      clearTargetAgent,
      renderDashboard,
      focusInput,
      resizeInput,
      renderScreen,
      screen,
      processStdout,
    } = createHarness();

    controller.enterAgentView("codex:1");
    processStdout.write.mockClear();
    controller.exitAgentView();

    expect(controller.getCurrentView()).toBe("main");
    expect(controller.getViewingAgent()).toBe("");
    expect(disconnectAgentOutput).toHaveBeenCalled();
    expect(disconnectAgentInput).toHaveBeenCalled();
    expect(setDashboardView).toHaveBeenCalledWith("agents");
    expect(setSelectedAgentIndex).toHaveBeenCalledWith(-1);
    expect(setScreenGrabKeys).toHaveBeenCalledWith(false);
    expect(screen.realloc).toHaveBeenCalled();
    expect(clearTargetAgent).toHaveBeenCalled();
    expect(renderDashboard).toHaveBeenCalled();
    expect(focusInput).toHaveBeenCalled();
    expect(resizeInput).toHaveBeenCalled();
    expect(renderScreen).toHaveBeenCalled();
    const output = processStdout.write.mock.calls.map((call) => call[0]).join("");
    expect(output).not.toContain("\x1b[2J\x1b[H");
  });

  test("enterAgentDashboardMode enables dashboard focus and output suppression", () => {
    const { controller, getState } = createHarness();

    controller.enterAgentView("codex:1");
    controller.enterAgentDashboardMode();

    expect(getState().focusMode).toBe("dashboard");
    expect(getState().selectedAgentIndex).toBe(0);
    expect(controller.getAgentOutputSuppressed()).toBe(true);
  });

  test("writeToAgentTerm sanitizes terminal queries", () => {
    const { controller, processStdout } = createHarness();

    controller.enterAgentView("codex:1");
    processStdout.write.mockClear();
    controller.writeToAgentTerm("hello\x1b[6n");

    expect(processStdout.write).toHaveBeenCalledWith("hello");
  });

  test("resize handler only acts in agent view", () => {
    const { controller, sendResize } = createHarness();

    expect(controller.handleResizeInAgentView()).toBe(false);

    controller.enterAgentView("codex:1");
    sendResize.mockClear();
    expect(controller.handleResizeInAgentView()).toBe(true);
    expect(sendResize).toHaveBeenCalledWith(100, 29);
  });
});

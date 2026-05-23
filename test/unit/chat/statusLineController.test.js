const { createStatusLineController } = require("../../../src/chat/statusLineController");

function createHarness(overrides = {}) {
  const statusLine = {
    setContent: jest.fn(),
  };
  const renderScreen = jest.fn();
  const setIntervalFn = jest.fn(() => ({ id: "timer" }));
  const clearIntervalFn = jest.fn();
  const now = jest.fn(() => 0);

  const controller = createStatusLineController({
    statusLine,
    bannerText: "banner",
    renderScreen,
    setIntervalFn,
    clearIntervalFn,
    now,
    ...overrides,
  });

  return { controller, statusLine, renderScreen, setIntervalFn, clearIntervalFn };
}

describe("chat statusLineController", () => {
  test("requires statusLine", () => {
    expect(() => createStatusLineController({})).toThrow(/requires statusLine/);
  });

  test("queue and resolve pending status toggles animation", () => {
    const { controller, statusLine, renderScreen, setIntervalFn, clearIntervalFn } = createHarness();

    controller.queueStatusLine("processing task");
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(renderScreen).toHaveBeenCalled();
    expect(statusLine.setContent).toHaveBeenCalled();

    controller.resolveStatusLine("done");
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(statusLine.setContent).toHaveBeenLastCalledWith("done");
  });

  test("multiple pending statuses resolve in FIFO order", () => {
    const { controller, statusLine, clearIntervalFn } = createHarness();

    controller.queueStatusLine("first");
    controller.queueStatusLine("second");

    controller.resolveStatusLine("ignored");
    const firstResolveContent = statusLine.setContent.mock.calls.at(-1)[0];
    const firstResolvePlain = firstResolveContent.replace(/\{[^}]+\}/g, "");
    expect(firstResolvePlain).toContain("second");
    expect(clearIntervalFn).toHaveBeenCalledTimes(0);

    controller.resolveStatusLine("final");
    expect(statusLine.setContent).toHaveBeenLastCalledWith("final");
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  test("keyed resolve removes only matching pending status", () => {
    const { controller, statusLine } = createHarness();

    controller.queueStatusLine("first", { key: "one" });
    controller.queueStatusLine("second", { key: "two" });

    controller.resolveStatusLine("ignored", { key: "two" });
    const stillFirstContent = statusLine.setContent.mock.calls.at(-1)[0];
    const stillFirstPlain = stillFirstContent.replace(/\{[^}]+\}/g, "");
    expect(stillFirstPlain).toContain("first");
    expect(stillFirstPlain).not.toContain("second");

    controller.resolveStatusLine("done", { key: "one" });
    expect(statusLine.setContent).toHaveBeenLastCalledWith("done");
  });

  test("keyed resolve clears a single unkeyed generic pending status", () => {
    const { controller, statusLine, clearIntervalFn } = createHarness();

    controller.queueStatusLine("ufoo-agent processing");
    controller.resolveStatusLine("done", { key: "ufoo-agent" });

    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(statusLine.setContent).toHaveBeenLastCalledWith("done");
  });

  test("keyed resolve does not clear unrelated keyed pending statuses", () => {
    const { controller, statusLine, clearIntervalFn } = createHarness();

    controller.queueStatusLine("first", { key: "one" });
    controller.resolveStatusLine("done", { key: "missing" });

    expect(clearIntervalFn).toHaveBeenCalledTimes(0);
    const content = statusLine.setContent.mock.calls.at(-1)[0];
    const plain = content.replace(/\{[^}]+\}/g, "");
    expect(plain).toContain("first");
  });

  test("terminal status resolve clears stale pending animation", () => {
    const { controller, statusLine, clearIntervalFn } = createHarness();

    controller.queueStatusLine("first");
    controller.queueStatusLine("second");
    controller.resolveStatusLine("{gray-fg}✓{/gray-fg} Daemon restarted");

    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(statusLine.setContent).toHaveBeenLastCalledWith("{gray-fg}✓{/gray-fg} Daemon restarted");
  });

  test("bus queue appends and resolves status indicators", () => {
    const { controller, statusLine } = createHarness();

    controller.enqueueBusStatus({ key: "a", text: "processing a" });
    controller.enqueueBusStatus({ key: "b", text: "processing b" });
    const withExtra = statusLine.setContent.mock.calls.at(-1)[0];
    expect(withExtra).toContain("(+1)");

    controller.resolveBusStatus({ key: "a", text: "processing a" });
    const afterResolve = statusLine.setContent.mock.calls.at(-1)[0];
    expect(afterResolve).toContain("processing b");
    expect(afterResolve).not.toContain("(+1)");
  });

  test("destroy clears active animation timer", () => {
    const { controller, clearIntervalFn } = createHarness();

    controller.queueStatusLine("processing");
    controller.destroy();

    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });
});

const {
  createDaemonCronController,
  normalizeCronTargets,
  resolveCronOperation,
  resolveCronIntervalMs,
  resolveCronOnceAtMs,
  parseCronAtMs,
} = require("../../../src/daemon/cronOps");
const os = require("os");
const fs = require("fs");
const path = require("path");

describe("daemon cronOps", () => {
  test("starts task and dispatches on tick", async () => {
    const timers = [];
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const setIntervalFn = jest.fn((fn, ms) => {
      const timer = { fn, ms, id: `t${timers.length + 1}` };
      timers.push(timer);
      return timer;
    });
    const clearIntervalFn = jest.fn();

    const controller = createDaemonCronController({
      dispatch,
      setIntervalFn,
      clearIntervalFn,
      nowFn: () => 1000,
      log: jest.fn(),
    });

    const started = controller.handleCronOp({
      action: "cron",
      operation: "start",
      every: "30m",
      target: "codex-3",
      prompt: "follow up",
    });

    expect(started.ok).toBe(true);
    expect(started.task.id).toBe("c1");
    expect(started.task.interval).toBe("30m");
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1800000);

    timers[0].fn();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledWith({
      taskId: "c1",
      target: "codex-3",
      message: "follow up",
    });

    const listed = controller.handleCronOp({ action: "cron", operation: "list" });
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(1);
    expect(listed.tasks[0].id).toBe("c1");

    const stopped = controller.handleCronOp({ action: "cron", operation: "stop", id: "c1" });
    expect(stopped.ok).toBe(true);
    expect(clearIntervalFn).toHaveBeenCalledWith(timers[0]);
  });

  test("supports stop all", () => {
    const timers = [];
    const setIntervalFn = jest.fn((fn, ms) => {
      const timer = { fn, ms, id: `t${timers.length + 1}` };
      timers.push(timer);
      return timer;
    });
    const clearIntervalFn = jest.fn();

    const controller = createDaemonCronController({
      dispatch: jest.fn(),
      setIntervalFn,
      clearIntervalFn,
      nowFn: () => 1000,
      log: jest.fn(),
    });

    controller.handleCronOp({ operation: "start", every: "10s", target: "codex:1", prompt: "ping" });
    controller.handleCronOp({ operation: "start", every: "20s", target: "codex:2", prompt: "pong" });

    const stopped = controller.handleCronOp({ operation: "stop", id: "all" });
    expect(stopped.ok).toBe(true);
    expect(stopped.stopped).toBe(2);
    expect(clearIntervalFn).toHaveBeenCalledTimes(2);
  });

  test("validates start payload", () => {
    const controller = createDaemonCronController({ dispatch: jest.fn(), log: jest.fn() });

    expect(controller.handleCronOp({ operation: "start", every: "500ms", target: "codex:1", prompt: "x" })).toEqual(
      expect.objectContaining({ ok: false, error: "invalid cron interval (min 1s)" })
    );
    expect(controller.handleCronOp({ operation: "start", every: "10s", prompt: "x" })).toEqual(
      expect.objectContaining({ ok: false, error: "cron start requires at least one target" })
    );
    expect(controller.handleCronOp({ operation: "start", every: "10s", target: "codex:1" })).toEqual(
      expect.objectContaining({ ok: false, error: "cron start requires prompt" })
    );
  });

  test("normalizes cron helpers", () => {
    expect(resolveCronOperation({ operation: "ls" })).toBe("ls");
    expect(resolveCronOperation({ list: true })).toBe("list");
    expect(resolveCronOperation({ id: "c1" })).toBe("stop");

    expect(resolveCronIntervalMs({ interval_ms: 10000 })).toBe(10000);
    expect(resolveCronIntervalMs({ every: "5m" })).toBe(300000);
    expect(resolveCronOnceAtMs({ once_at_ms: 1700000000000 })).toBe(1700000000000);
    expect(parseCronAtMs("2026-02-23 22:15")).toBe(Date.parse("2026-02-23T22:15:00"));

    expect(normalizeCronTargets({ targets: ["codex:1", " codex:1 ", "claude:2"] })).toEqual([
      "codex:1",
      "claude:2",
    ]);
    expect(normalizeCronTargets({ target: "codex:1, codex:2" })).toEqual(["codex:1", "codex:2"]);
  });

  test("supports one-time task and auto-cleans after trigger", async () => {
    const dispatch = jest.fn().mockResolvedValue(undefined);
    let timeoutHandler = null;
    const setTimeoutFn = jest.fn((fn) => {
      timeoutHandler = fn;
      return { id: "timeout-1" };
    });
    const clearTimeoutFn = jest.fn();

    const controller = createDaemonCronController({
      dispatch,
      setTimeoutFn,
      clearTimeoutFn,
      nowFn: () => 1000,
      log: jest.fn(),
    });

    const started = controller.handleCronOp({
      operation: "start",
      at: "2026-02-23 22:15",
      target: "codex:1",
      prompt: "run once",
    });

    expect(started.ok).toBe(true);
    expect(started.task.mode).toBe("once");
    expect(controller.handleCronOp({ operation: "list" }).count).toBe(1);

    timeoutHandler();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledWith({
      taskId: started.task.id,
      target: "codex:1",
      message: "run once",
    });
    expect(controller.handleCronOp({ operation: "list" }).count).toBe(0);
    expect(clearTimeoutFn).toHaveBeenCalled();
  });

  test("persists and restores cron tasks from storage file", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cron-"));
    const storageFile = path.join(tempDir, "cron.tasks.json");

    const controller1 = createDaemonCronController({
      dispatch: jest.fn(),
      storageFile,
      nowFn: () => 1000,
      log: jest.fn(),
    });

    const started = controller1.handleCronOp({
      operation: "start",
      every: "10s",
      target: "codex:1",
      prompt: "persist me",
    });
    expect(started.ok).toBe(true);
    expect(fs.existsSync(storageFile)).toBe(true);

    const controller2 = createDaemonCronController({
      dispatch: jest.fn(),
      storageFile,
      nowFn: () => 2000,
      log: jest.fn(),
    });

    const listed = controller2.handleCronOp({ operation: "list" });
    expect(listed.ok).toBe(true);
    expect(listed.count).toBe(1);
    expect(listed.tasks[0].id).toBe(started.task.id);
  });
});

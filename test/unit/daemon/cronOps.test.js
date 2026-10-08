const {
  createDaemonCronController,
  normalizeCronTargets,
  resolveCronOperation,
  resolveCronIntervalMs,
  resolveCronOnceAtMs,
  resolveCronTitle,
  parseCronAtMs,
} = require("../../../src/runtime/daemon/cronOps");
const os = require("os");
const fs = require("fs");
const path = require("path");

describe("daemon cronOps", () => {
  test("starts task and dispatches on tick", async () => {
    const timers = [];
    const dispatch = jest.fn().mockResolvedValue(undefined);
    const setIntervalFn = jest.fn((fn, ms) => {
      const timer = { fn, ms, id: `t${timers.length + 1}`, unref: jest.fn() };
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
    expect(started.task.title).toBe("follow up");
    expect(started.task.label).toBe("codex-3:follow up:30m");
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1800000);
    expect(timers[0].unref).toHaveBeenCalledTimes(1);

    timers[0].fn();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledWith({
      taskId: "c1",
      occurrenceId: expect.any(String),
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
    expect(resolveCronTitle({ title: "Nightly Smoke" })).toBe("Nightly Smoke");
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
      return { id: "timeout-1", unref: jest.fn() };
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
    expect(setTimeoutFn.mock.results[0].value.unref).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();

    timeoutHandler();
    await Promise.resolve();

    expect(dispatch).toHaveBeenCalledWith({
      taskId: started.task.id,
      occurrenceId: expect.any(String),
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
    expect(listed.tasks[0].title).toBe("persist me");
    expect(listed.tasks[0].label).toBe("codex:1:persist me:10s");
    controller1.stopAll();
    controller2.stopAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  test("restart advances interval occurrence identity without replaying the committed tick", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cron-restart-"));
    const storageFile = path.join(dir, "tasks.json");
    const dispatch = jest.fn();
    const timers = [];
    const options = { storageFile, dispatch, nowFn: () => 1000, setIntervalFn: (fn) => { timers.push(fn); return {}; }, clearIntervalFn: () => {} };
    try {
      const first = createDaemonCronController(options);
      first.handleCronOp({ every: "10s", target: "worker", prompt: "check" });
      const initial = dispatch.mock.calls[0][0].occurrenceId;
      const recovered = createDaemonCronController(options);
      expect(dispatch).toHaveBeenCalledTimes(1);
      timers[1]();
      expect(dispatch.mock.calls[1][0].occurrenceId).toBe(initial.replace(/:1$/, ":2"));
      expect(fs.statSync(storageFile).mode & 0o777).toBe(0o600);
      recovered.stopAll();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("an overdue one-time task recovers once and a reserved occurrence is not resent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cron-once-"));
    const storageFile = path.join(dir, "tasks.json");
    let reserved;
    const dispatch = jest.fn(() => { reserved = fs.readFileSync(storageFile, "utf8"); });
    const timers = [];
    const options = { storageFile, dispatch, nowFn: () => 1000, setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return {}; }, clearTimeoutFn: () => {} };
    try {
      const first = createDaemonCronController(options);
      first.handleCronOp({ once_at_ms: 2000, target: "worker", prompt: "check" });
      expect(dispatch).not.toHaveBeenCalled();
      const recovered = createDaemonCronController({ ...options, nowFn: () => 3000 });
      expect(timers[1].ms).toBe(0);
      timers[1].fn();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(reserved).tasks[0].tickCount).toBe(1);
      fs.writeFileSync(storageFile, reserved);
      const afterReservation = createDaemonCronController(options);
      expect(afterReservation.listTasks()).toHaveLength(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
      recovered.stopAll();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test("storage failures cannot dispatch a tick or stop an active schedule", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-cron-fault-"));
    const storageFile = path.join(dir, "tasks.json");
    let fail = false;
    let tick;
    const dispatch = jest.fn();
    const clearIntervalFn = jest.fn();
    const fsModule = { ...fs, renameSync: (...args) => { if (fail) throw new Error("disk unavailable"); return fs.renameSync(...args); } };
    try {
      const controller = createDaemonCronController({ storageFile, fsModule, dispatch, log: () => {},
        setIntervalFn: (fn) => { tick = fn; return {}; }, clearIntervalFn });
      controller.handleCronOp({ every: "10s", target: "worker", prompt: "check" });
      fail = true;
      tick();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(controller.listTasks()[0].tickCount).toBe(1);
      expect(() => controller.stopAll()).toThrow("disk unavailable");
      expect(controller.listTasks()).toHaveLength(1);
      expect(clearIntervalFn).not.toHaveBeenCalled();
      expect(fs.readdirSync(dir)).toEqual(["tasks.json"]);
      fail = false;
      tick();
      expect(dispatch).toHaveBeenCalledTimes(2);
      controller.stopAll();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

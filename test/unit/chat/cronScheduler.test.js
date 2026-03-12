const {
  parseIntervalMs,
  formatIntervalMs,
  summarizeTask,
  createCronScheduler,
} = require("../../../src/chat/cronScheduler");

describe("chat cronScheduler", () => {
  test("parses interval strings", () => {
    expect(parseIntervalMs("5")).toBe(5000);
    expect(parseIntervalMs("1500ms")).toBe(1500);
    expect(parseIntervalMs("10s")).toBe(10000);
    expect(parseIntervalMs("2m")).toBe(120000);
    expect(parseIntervalMs("1h")).toBe(3600000);
    expect(parseIntervalMs("")).toBe(0);
    expect(parseIntervalMs("abc")).toBe(0);
  });

  test("formats interval strings", () => {
    expect(formatIntervalMs(1500)).toBe("1500ms");
    expect(formatIntervalMs(10000)).toBe("10s");
    expect(formatIntervalMs(120000)).toBe("2m");
    expect(formatIntervalMs(3600000)).toBe("1h");
  });

  test("creates, dispatches and stops cron task", () => {
    const timers = [];
    const dispatch = jest.fn();
    const setIntervalFn = jest.fn((fn, ms) => {
      const timer = { fn, ms, id: `t${timers.length + 1}` };
      timers.push(timer);
      return timer;
    });
    const clearIntervalFn = jest.fn();
    const onChange = jest.fn();

    const scheduler = createCronScheduler({
      dispatch,
      setIntervalFn,
      clearIntervalFn,
      onChange,
      nowFn: () => 1000,
    });

    const task = scheduler.addTask({
      intervalMs: 5000,
      targets: ["codex:1", "codex:2"],
      prompt: "run check",
    });

    expect(task).toBeTruthy();
    expect(task.id).toBe("c1");
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(scheduler.listTasks()).toHaveLength(1);

    timers[0].fn();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith({
      taskId: "c1",
      target: "codex:1",
      message: "run check",
    });

    expect(scheduler.stopTask("c1")).toBe(true);
    expect(clearIntervalFn).toHaveBeenCalledWith(timers[0]);
    expect(scheduler.listTasks()).toHaveLength(0);
  });

  test("summarizeTask truncates long prompt", () => {
    const summary = summarizeTask({
      id: "c3",
      intervalMs: 10000,
      targets: ["a:1", "b:2"],
      prompt: "this is a very long prompt for test summary",
    });
    expect(summary).toContain("c3 a:1+b:2:this is a very long p...");
    expect(summary).toContain("...");
  });

  test("uses explicit title when provided", () => {
    const summary = summarizeTask({
      id: "c4",
      intervalMs: 30000,
      targets: ["codex:1"],
      title: "Nightly Smoke",
      prompt: "run the full nightly smoke suite",
    });
    expect(summary).toBe("c4 codex:1:Nightly Smoke:30s");
  });
});

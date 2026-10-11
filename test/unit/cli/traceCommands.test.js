"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { runTraceCommand } = require("../../../src/app/cli/traceCommands");
describe("offline trace CLI", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-trace-cli-")); jest.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
  test("returns JSON without starting a daemon or initializing a project", () => {
    runTraceCommand("task", { project: root, json: true });
    expect(JSON.parse(console.log.mock.calls[0][0])).toMatchObject({ taskId: "task", total: 0, incomplete: false });
    expect(fs.readdirSync(root)).toEqual([]);
  });
  test("follows new events once and releases polling and signal listeners", () => {
    jest.useFakeTimers();
    const before = process.listenerCount("SIGINT");
    const stop = runTraceCommand("", { project: root, follow: true, json: true });
    const file = path.join(root, ".ufoo/agent/main/runtimes/main/events.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ eventId: "one", type: "task.started", time: "2026-10-10T00:00:00Z" }) + "\n");
    jest.advanceTimersByTime(3000);
    expect(console.log.mock.calls.map(([value]) => JSON.parse(value)).filter(e => e.type === "task.started")).toHaveLength(1);
    stop();
    expect(jest.getTimerCount()).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

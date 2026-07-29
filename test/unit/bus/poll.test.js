"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  acquirePollLease,
  enumerateEventKeys,
  releasePollLease,
  runPendingPoll,
} = require("../../../src/coordination/bus/poll");

describe("background pending poll", () => {
  test("gives duplicate unsequenced events distinct stable keys", () => {
    const events = [{ data: { message: "same" } }, { data: { message: "same" } }];
    const first = enumerateEventKeys(events).map((entry) => entry.key);
    const second = enumerateEventKeys(events).map((entry) => entry.key);

    expect(new Set(first).size).toBe(2);
    expect(second).toEqual(first);
  });

  test("keeps one batch in flight until it is acknowledged", async () => {
    const snapshots = [
      [{ seq: 1, data: { message: "first" } }],
      [
        { seq: 1, data: { message: "first" } },
        { seq: 2, data: { message: "second" } },
      ],
      [{ seq: 2, data: { message: "second" } }],
      [{ seq: 2, data: { message: "second" } }],
      [],
    ];
    const batches = [];
    let readIndex = 0;

    const result = await runPendingPoll({
      intervalMs: 250,
      maxIterations: snapshots.length,
      readPending: async () => snapshots[readIndex++],
      onEvents: async (events) => batches.push(events.map((event) => event.seq)),
      sleep: async () => {},
    });

    expect(result.iterations).toBe(5);
    expect(batches).toEqual([[1], [2]]);
  });

  test("never needs an ack or claim callback", async () => {
    const onEvents = jest.fn().mockResolvedValue();

    await runPendingPoll({
      maxIterations: 1,
      readPending: async () => [{ seq: 7 }],
      onEvents,
    });

    expect(onEvents).toHaveBeenCalledWith([{ seq: 7 }]);
  });

  test("emits no batch callback while the queue stays empty", async () => {
    const onEvents = jest.fn().mockResolvedValue();

    await runPendingPoll({
      intervalMs: 250,
      maxIterations: 3,
      readPending: async () => [],
      onEvents,
      sleep: async () => {},
    });

    expect(onEvents).not.toHaveBeenCalled();
  });

  test("allows only one resident poll lease per subscriber", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-poll-lease-"));
    const pidFile = path.join(dir, "poll.pid");
    try {
      const first = acquirePollLease(pidFile, {
        pid: process.pid,
      });

      expect(() => acquirePollLease(pidFile, {
        pid: 202,
      })).toThrow("already running");
      expect(releasePollLease(first)).toBe(true);

      const second = acquirePollLease(pidFile, {
        pid: 202,
        isAlive: () => false,
      });
      expect(second.pid).toBe(202);
      expect(releasePollLease(second)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

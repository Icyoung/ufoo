"use strict";

const {
  restartDaemonLifecycle,
  restartDaemonLifecycleSync,
} = require("../../../src/runtime/daemon/restart");

describe("daemon restart lifecycle", () => {
  test("async restart cleans stale state and starts even when daemon is already down", async () => {
    const states = [false, true];
    const isRunning = jest.fn(() => states.shift() ?? true);
    const stopDaemon = jest.fn(() => true);
    const startDaemon = jest.fn(() => true);
    const connect = jest.fn().mockResolvedValue(true);
    const requestStatus = jest.fn();

    const result = await restartDaemonLifecycle({
      projectRoot: "/tmp/project",
      isRunning,
      stopDaemon,
      startDaemon,
      connect,
      requestStatus,
      sleep: jest.fn(() => Promise.resolve()),
    });

    expect(result.ok).toBe(true);
    expect(stopDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(startDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(requestStatus).toHaveBeenCalledTimes(1);
  });

  test("async restart does not start when stop never reaches stopped state", async () => {
    const isRunning = jest.fn(() => true);
    const stopDaemon = jest.fn(() => true);
    const startDaemon = jest.fn();
    const connect = jest.fn();

    const result = await restartDaemonLifecycle({
      projectRoot: "/tmp/project",
      isRunning,
      stopDaemon,
      startDaemon,
      connect,
      stopTimeoutMs: 200,
      pollMs: 100,
      sleep: jest.fn(() => Promise.resolve()),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("failed_to_stop");
    expect(startDaemon).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  test("async restart waits for the new daemon before connecting", async () => {
    const calls = [];
    const states = [false, false, false, true];
    const isRunning = jest.fn(() => states.shift() ?? true);
    const stopDaemon = jest.fn(() => {
      calls.push("stop");
      return true;
    });
    const startDaemon = jest.fn(() => {
      calls.push("start");
      return true;
    });
    const connect = jest.fn(async () => {
      calls.push("connect");
      return true;
    });
    const sleep = jest.fn(async () => {
      calls.push("sleep");
    });

    const result = await restartDaemonLifecycle({
      projectRoot: "/tmp/project",
      isRunning,
      stopDaemon,
      startDaemon,
      connect,
      sleep,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["stop", "start", "sleep", "sleep", "connect"]);
  });

  test("sync restart uses the same stop/start state machine", () => {
    const states = [true, false, false, true];
    const isRunning = jest.fn(() => states.shift() ?? true);
    const stopDaemon = jest.fn(() => true);
    const startDaemon = jest.fn(() => true);
    const sleepSync = jest.fn();

    const result = restartDaemonLifecycleSync({
      projectRoot: "/tmp/project",
      isRunning,
      stopDaemon,
      startDaemon,
      sleepSync,
    });

    expect(result.ok).toBe(true);
    expect(stopDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(startDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(sleepSync).toHaveBeenCalledTimes(2);
  });
});

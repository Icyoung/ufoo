"use strict";

describe("daemon CLI runner", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("daemon start falls back to PATH node when process execPath is stale", () => {
    const child = { unref: jest.fn() };
    const spawn = jest.fn(() => child);
    jest.doMock("child_process", () => ({
      spawn,
      spawnSync: jest.fn(),
    }));
    jest.doMock("../../../src/daemon/index", () => ({
      startDaemon: jest.fn(),
      stopDaemon: jest.fn(),
      isRunning: jest.fn(() => false),
    }));
    jest.doMock("../../../src/config", () => ({
      loadConfig: jest.fn(() => ({})),
      defaultAgentModelForProvider: jest.fn(() => "default-model"),
    }));

    const originalExecPath = process.execPath;
    const originalDaemonChild = process.env.UFOO_DAEMON_CHILD;
    Object.defineProperty(process, "execPath", {
      value: "/missing/node",
      configurable: true,
    });
    delete process.env.UFOO_DAEMON_CHILD;

    try {
      const { runDaemonCli } = require("../../../src/daemon/run");
      runDaemonCli(["daemon", "start"]);

      expect(spawn.mock.calls[0][0]).toBe("node");
      expect(spawn.mock.calls[0][1]).toEqual([
        expect.stringContaining("bin/ufoo.js"),
        "daemon",
        "start",
      ]);
      expect(child.unref).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
      if (originalDaemonChild === undefined) {
        delete process.env.UFOO_DAEMON_CHILD;
      } else {
        process.env.UFOO_DAEMON_CHILD = originalDaemonChild;
      }
    }
  });
});

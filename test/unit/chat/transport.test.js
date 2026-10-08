"use strict";

describe("chat transport", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("a new project starts the daemon from the actual package binary", () => {
    const child = { on: jest.fn().mockReturnThis(), unref: jest.fn() };
    const spawn = jest.fn(() => child);
    jest.doMock("child_process", () => ({ spawn, spawnSync: jest.fn() }));
    jest.doMock("fs", () => ({ existsSync: jest.fn((file) => !String(file).endsWith("bin/ufoo.js")) }));
    const { startDaemon } = require("../../../src/app/chat/transport");
    startDaemon("/tmp/new-project");
    expect(spawn.mock.calls[0][1][0]).toBe(require.resolve("../../../bin/ufoo.js"));
  });

  test("startDaemon falls back to PATH node when process execPath is stale and handles spawn errors", () => {
    const handlers = {};
    const child = {
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
        return child;
      }),
      unref: jest.fn(),
    };
    const spawn = jest.fn(() => child);
    jest.doMock("child_process", () => ({
      spawn,
      spawnSync: jest.fn(),
    }));
    jest.doMock("fs", () => ({
      existsSync: jest.fn((target) => target !== "/missing/node"),
    }));

    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: "/missing/node",
      configurable: true,
    });
    try {
      const { startDaemon } = require("../../../src/app/chat/transport");
      const onError = jest.fn();
      startDaemon("/tmp/project", { onError });
      expect(spawn.mock.calls[0][0]).toBe("node");
      expect(spawn.mock.calls[0][1]).toEqual([
        expect.stringContaining("bin/ufoo.js"),
        "daemon",
        "--start",
      ]);
      expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
      const err = new Error("spawn failed");
      handlers.error(err);
      expect(onError).toHaveBeenCalledWith(err);
      expect(child.unref).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }
  });
});

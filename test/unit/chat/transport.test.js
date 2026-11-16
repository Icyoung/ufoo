"use strict";

describe("chat transport", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test.each([false, true])("requestDaemon preserves operation results only when requested: %s", async (fullResponse) => {
    const { EventEmitter } = require("events");
    const socket = new EventEmitter();
    const response = { type: "response", data: { reply: "Close failed" }, opsResults: [{ action: "close", ok: false, error: "denied" }] };
    socket.write = jest.fn(() => queueMicrotask(() => socket.emit("data", JSON.stringify(response) + "\n")));
    socket.end = jest.fn();
    jest.doMock("net", () => ({ createConnection: jest.fn((_path, ready) => {
      queueMicrotask(ready); return socket;
    }) }));
    jest.doMock("../../../src/runtime/daemon/endpoint", () => ({
      resolveDaemonEndpoint: () => ({ socketPath: "/tmp/test-only.sock" }),
      routeDaemonRequest: (_endpoint, payload) => payload,
    }));
    const { requestDaemon } = require("../../../src/app/chat/transport");
    const result = await requestDaemon("/tmp/project", { type: "close_agent", agent_id: "child" }, { fullResponse });
    expect(result).toEqual(fullResponse ? response : response.data);
    expect(socket.end).toHaveBeenCalled();
    jest.dontMock("net");
    jest.dontMock("../../../src/runtime/daemon/endpoint");
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

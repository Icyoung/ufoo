"use strict";

const { EventEmitter } = require("events");

const {
  DaemonProcessLifecycle,
} = require("../../../src/runtime/daemon/processLifecycle");

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.exit = jest.fn();
  }
}

describe("DaemonProcessLifecycle", () => {
  test("installs one process handler set for several project runtimes", () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new DaemonProcessLifecycle(fakeProcess);
    const cleanA = jest.fn();
    const cleanB = jest.fn();
    lifecycle.register("project-a:1", { cleanup: cleanA });
    lifecycle.register("project-b:1", { cleanup: cleanB });

    for (const event of [
      "beforeExit",
      "exit",
      "SIGTERM",
      "SIGINT",
      "uncaughtException",
      "unhandledRejection",
    ]) {
      expect(fakeProcess.listenerCount(event)).toBe(1);
    }

    fakeProcess.emit("SIGTERM");
    expect(cleanA).toHaveBeenCalledWith("SIGTERM", { sync: true });
    expect(cleanB).toHaveBeenCalledWith("SIGTERM", { sync: true });
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
  });

  test("contains lifecycle hook failures and continues cleaning other runtimes", () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new DaemonProcessLifecycle(fakeProcess);
    const cleanB = jest.fn();
    lifecycle.register("project-a:1", {
      onFatal: () => {
        throw new Error("diagnostic failed");
      },
      cleanup: () => {
        throw new Error("cleanup failed");
      },
    });
    lifecycle.register("project-b:1", {
      onFatal: jest.fn(),
      cleanup: cleanB,
    });

    const fatal = new Error("runtime crashed");
    fakeProcess.emit("uncaughtException", fatal);
    expect(cleanB).toHaveBeenCalledWith("uncaughtException", { sync: true });
    expect(fakeProcess.exit).toHaveBeenCalledWith(1);
  });

  test("unregister removes only the selected runtime", () => {
    const fakeProcess = new FakeProcess();
    const lifecycle = new DaemonProcessLifecycle(fakeProcess);
    const cleanA = jest.fn();
    const cleanB = jest.fn();
    const unregisterA = lifecycle.register("project-a:1", { cleanup: cleanA });
    lifecycle.register("project-b:1", { cleanup: cleanB });
    unregisterA();

    fakeProcess.emit("exit", 0);
    expect(cleanA).not.toHaveBeenCalled();
    expect(cleanB).toHaveBeenCalledWith("exit code=0", { sync: true });
  });
});

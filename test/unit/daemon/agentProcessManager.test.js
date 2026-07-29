"use strict";

const { EventEmitter } = require("events");

const { AgentProcessManager } = require("../../../src/runtime/daemon/agentProcessManager");

function fakeChild() {
  const child = new EventEmitter();
  child.kill = jest.fn();
  child.unref = jest.fn();
  return child;
}

describe("AgentProcessManager", () => {
  test("terminates managed children for legacy project-daemon cleanup", () => {
    const manager = new AgentProcessManager("/tmp/project");
    const child = fakeChild();
    manager.register("codex:one", child);

    manager.cleanup();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.unref).not.toHaveBeenCalled();
    expect(manager.count()).toBe(0);
  });

  test("detaches runners for global-daemon replacement without removing unrelated listeners", () => {
    const manager = new AgentProcessManager("/tmp/project");
    const child = fakeChild();
    const externalExitListener = jest.fn();
    child.on("exit", externalExitListener);
    manager.register("codex:one", child);

    manager.cleanup({ terminate: false });

    expect(child.kill).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.listeners("exit")).toEqual([externalExitListener]);
    expect(manager.count()).toBe(0);
  });
});

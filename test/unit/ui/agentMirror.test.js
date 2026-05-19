"use strict";

const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { IPC_REQUEST_TYPES, IPC_RESPONSE_TYPES } = require("../../../src/shared/eventContract");
const { startInternalAgentMirror } = require("../../../src/ui/components/agentMirror");

function createFakeStdio() {
  const stdin = new EventEmitter();
  stdin.isRaw = false;
  stdin.resume = jest.fn();
  stdin.setRawMode = jest.fn((value) => { stdin.isRaw = value; });

  const stdout = new EventEmitter();
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.write = jest.fn();
  return { stdin, stdout };
}

describe("startInternalAgentMirror", () => {
  test("uses daemon bus watch/send instead of inject socket", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agent-mirror-"));
    const { stdin, stdout } = createFakeStdio();
    const sent = [];
    const daemonConnection = {
      connect: jest.fn(() => true),
      send: jest.fn((req) => sent.push(req)),
    };
    let handler = null;
    const onExit = jest.fn();

    startInternalAgentMirror({
      agentId: "codex:1",
      agentLabel: "codex-1",
      projectRoot,
      daemonConnection,
      setDaemonMessageHandler: (fn) => { handler = fn; },
      stdin,
      stdout,
      onExit,
    });

    expect(daemonConnection.connect).toHaveBeenCalled();
    expect(sent).toEqual(expect.arrayContaining([
      { type: IPC_REQUEST_TYPES.BUS_WATCH, agent_id: "codex:1", enabled: true },
      { type: IPC_REQUEST_TYPES.STATUS },
    ]));
    expect(typeof handler).toBe("function");

    stdin.emit("keypress", "h", { name: "h" });
    stdin.emit("keypress", "i", { name: "i" });
    stdin.emit("keypress", null, { name: "return" });

    expect(sent).toEqual(expect.arrayContaining([
      {
        type: IPC_REQUEST_TYPES.BUS_SEND,
        target: "codex:1",
        message: "hi",
        injection_mode: "immediate",
        source: "chat-internal-agent-view",
      },
    ]));

    handler({
      type: IPC_RESPONSE_TYPES.BUS,
      data: {
        event: "message",
        publisher: "codex:1",
        target: "ufoo-agent",
        message: JSON.stringify({ stream: true, delta: "ok" }),
      },
    });
    expect(stdout.write.mock.calls.flat().join("")).toContain("ok");

    stdin.emit("keypress", null, { name: "escape" });
    expect(sent).toEqual(expect.arrayContaining([
      { type: IPC_REQUEST_TYPES.BUS_WATCH, agent_id: "codex:1", enabled: false },
    ]));
    expect(onExit).toHaveBeenCalled();
  });
});

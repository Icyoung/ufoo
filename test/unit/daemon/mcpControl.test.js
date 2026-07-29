"use strict";

const { EventEmitter } = require("events");

const {
  requestMcpControl,
} = require("../../../src/runtime/daemon/mcpControl");
const {
  IPC_RESPONSE_TYPES,
} = require("../../../src/runtime/contracts/eventContract");

function fakeClient(response) {
  const client = new EventEmitter();
  client.end = jest.fn();
  client.write = jest.fn(() => {
    queueMicrotask(() => {
      client.emit("data", `${JSON.stringify(response)}\n`);
    });
  });
  queueMicrotask(() => client.emit("connect"));
  return client;
}

describe("MCP daemon control client", () => {
  test("returns typed status from the global daemon socket", async () => {
    const result = await requestMcpControl("status", {
      projectRoot: "/tmp/global",
      isRunning: () => true,
      socketPath: () => "/virtual/ufoo.sock",
      connect: () => fakeClient({
        type: IPC_RESPONSE_TYPES.RESPONSE,
        data: {
          ok: true,
          operation: "status",
          mcp: { running: true, endpoint: "http://127.0.0.1:47631/mcp" },
        },
      }),
    });
    expect(result.mcp).toMatchObject({
      running: true,
      endpoint: "http://127.0.0.1:47631/mcp",
    });
  });

  test("does not invent a listener when the global daemon is stopped", async () => {
    await expect(requestMcpControl("restart", {
      projectRoot: "/tmp/global",
      isRunning: () => false,
    })).rejects.toMatchObject({
      code: "global_daemon_not_running",
    });
  });
});

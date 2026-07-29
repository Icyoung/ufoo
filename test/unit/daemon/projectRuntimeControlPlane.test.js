"use strict";

const { EventEmitter } = require("events");
const {
  createProjectRuntimeControlPlane,
} = require("../../../src/runtime/daemon/projectRuntimeControlPlane");
const {
  IPC_REQUEST_TYPES,
  IPC_RESPONSE_TYPES,
} = require("../../../src/runtime/contracts/eventContract");

function createSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.output = [];
  socket.write = (line) => {
    socket.output.push(JSON.parse(String(line).trim()));
    return true;
  };
  return socket;
}

describe("project runtime control plane", () => {
  test("executes a correlated project operation", async () => {
    const execute = jest.fn(async (projectRoot, operation, args, context) => ({
      projectRoot,
      operation,
      args,
      requestId: context.requestId,
    }));
    const plane = createProjectRuntimeControlPlane({
      projectRoot: "/tmp/project-runtime",
      execute,
    });
    const socket = createSocket();

    const handled = await plane.handleRequest({
      type: IPC_REQUEST_TYPES.CONTROL_PLANE_CALL,
      request_id: "request-a",
      operation: "poll_inbox",
      arguments: { subscriber: "codex:a" },
    }, socket);

    expect(handled).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "/tmp/project-runtime",
      "poll_inbox",
      { subscriber: "codex:a" },
      expect.objectContaining({ requestId: "request-a" })
    );
    expect(socket.output).toEqual([
      expect.objectContaining({
        type: IPC_RESPONSE_TYPES.CONTROL_PLANE_RESULT,
        request_id: "request-a",
        ok: true,
        result: expect.objectContaining({ operation: "poll_inbox" }),
      }),
    ]);
    expect(plane.activeCount()).toBe(0);
  });

  test("cancels an active operation without stopping the runtime", async () => {
    const execute = jest.fn((projectRoot, operation, args, context) => (
      new Promise((resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          const err = new Error("cancelled");
          err.code = "request_cancelled";
          reject(err);
        }, { once: true });
      })
    ));
    const plane = createProjectRuntimeControlPlane({
      projectRoot: "/tmp/project-runtime",
      execute,
    });
    const socket = createSocket();
    const pending = plane.handleRequest({
      type: IPC_REQUEST_TYPES.CONTROL_PLANE_CALL,
      request_id: "request-b",
      operation: "wait_for_message",
      arguments: { subscriber: "codex:b" },
    }, socket);
    await new Promise((resolve) => setImmediate(resolve));

    expect(plane.activeCount()).toBe(1);
    expect(await plane.handleRequest({
      type: IPC_REQUEST_TYPES.CONTROL_PLANE_CANCEL,
      request_id: "request-b",
    }, socket)).toBe(true);
    await pending;

    expect(socket.output).toContainEqual(expect.objectContaining({
      type: IPC_RESPONSE_TYPES.CONTROL_PLANE_RESULT,
      request_id: "request-b",
      ok: false,
      error: {
        code: "request_cancelled",
        message: "cancelled",
      },
    }));
    expect(plane.activeCount()).toBe(0);
  });

  test("ignores unrelated daemon IPC requests", async () => {
    const plane = createProjectRuntimeControlPlane({
      projectRoot: "/tmp/project-runtime",
      execute: jest.fn(),
    });
    expect(await plane.handleRequest({ type: IPC_REQUEST_TYPES.STATUS }, createSocket()))
      .toBe(false);
  });
});

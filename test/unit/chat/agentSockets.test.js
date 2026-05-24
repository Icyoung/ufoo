const EventEmitter = require("events");
const fs = require("fs");
const net = require("net");
const { PTY_SOCKET_MESSAGE_TYPES, PTY_SOCKET_SUBSCRIBE_MODES } = require("../../../src/runtime/contracts/ptySocketContract");
const { createAgentSockets } = require("../../../src/app/chat/agentSockets");

function createFakeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.connecting = true;
  socket.write = jest.fn(() => true);
  socket.destroy = jest.fn(() => {
    socket.destroyed = true;
    socket.emit("close");
  });
  return socket;
}

describe("chat agentSockets", () => {
  let existsSpy;
  let connSpy;
  let sockets;

  function emitConnect(index = 0) {
    const socket = sockets[index];
    socket.connecting = false;
    if (typeof socket._connectCb === "function") socket._connectCb();
    socket.emit("connect");
  }

  beforeEach(() => {
    sockets = [];
    existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
    connSpy = jest.spyOn(net, "createConnection").mockImplementation((_sockPath, cb) => {
      const socket = createFakeSocket();
      socket._connectCb = cb;
      sockets.push(socket);
      return socket;
    });
  });

  afterEach(() => {
    connSpy.mockRestore();
    existsSpy.mockRestore();
  });

  test("sendRaw writes to input socket when connected", () => {
    const sendBusRaw = jest.fn();
    const mgr = createAgentSockets({
      isBusMode: () => true,
      getViewingAgent: () => "codex:1",
      sendBusRaw,
    });

    mgr.connectInput("/tmp/inject.sock");
    emitConnect(0);
    mgr.sendRaw("hello");

    expect(sockets[0].write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.RAW, data: "hello" })}\n`
    );
    expect(sendBusRaw).not.toHaveBeenCalled();
  });

  test("sendRaw falls back to bus when no input socket", () => {
    const sendBusRaw = jest.fn();
    const mgr = createAgentSockets({
      isBusMode: () => true,
      getViewingAgent: () => "codex:1",
      sendBusRaw,
    });

    mgr.sendRaw("hello");
    expect(sendBusRaw).toHaveBeenCalledWith("codex:1", "hello");
  });

  test("sendResize buffers until input connect", () => {
    const mgr = createAgentSockets();
    mgr.sendResize(120, 30);

    mgr.connectInput("/tmp/inject.sock");

    expect(sockets[0].write).not.toHaveBeenCalled();

    emitConnect(0);
    expect(sockets[0].write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.RESIZE, cols: 120, rows: 30 })}\n`
    );
  });

  test("connectOutput subscribes and requestScreenSnapshot works", () => {
    const onTermWrite = jest.fn();
    const onPlaceCursor = jest.fn();
    const mgr = createAgentSockets({
      onTermWrite,
      onPlaceCursor,
      isAgentView: () => true,
    });

    mgr.connectOutput("/tmp/inject.sock");
    emitConnect(0);

    expect(sockets[0].write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE, mode: PTY_SOCKET_SUBSCRIBE_MODES.FULL })}\n`
    );

    const ok = mgr.requestScreenSnapshot();
    expect(ok).toBe(true);
    expect(sockets[0].write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE, mode: PTY_SOCKET_SUBSCRIBE_MODES.SCREEN })}\n`
    );

    const okFull = mgr.requestSnapshot("full");
    expect(okFull).toBe(true);
    const lastCall = sockets[0].write.mock.calls[sockets[0].write.mock.calls.length - 1][0];
    expect(lastCall).toBe(`${JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.SUBSCRIBE, mode: PTY_SOCKET_SUBSCRIBE_MODES.FULL })}\n`);

    sockets[0].emit("data", Buffer.from(
      `${JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.OUTPUT, data: "A" })}\n` +
      `${JSON.stringify({ type: PTY_SOCKET_MESSAGE_TYPES.SNAPSHOT, data: "B", cursor: { x: 1, y: 2 } })}\n`
    ));

    expect(onTermWrite).toHaveBeenCalledWith("A");
    expect(onTermWrite).toHaveBeenCalledWith("B");
    expect(onPlaceCursor).toHaveBeenCalledWith({ x: 1, y: 2 });
  });

  test("connectOutput reports missing socket path", () => {
    existsSpy.mockReturnValue(false);
    const onTermWrite = jest.fn();
    const mgr = createAgentSockets({ onTermWrite });

    mgr.connectOutput("/tmp/missing.sock");
    expect(onTermWrite).toHaveBeenCalledWith(expect.stringContaining("inject.sock not found"));
  });
});

jest.mock("net", () => {
  const { EventEmitter } = require("events");
  const createServer = jest.fn((handler) => {
    const server = new EventEmitter();
    server.listen = jest.fn();
    server.close = jest.fn();
    server._handler = handler;
    return server;
  });
  return { createServer };
});

const EventEmitter = require("events");
const { createDaemonIpcServer } = require("../../../src/daemon/ipcServer");
const net = require("net");

describe("daemon ipcServer", () => {
  let servers = [];

  function createFakeSocket() {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.write = jest.fn();
    return socket;
  }

  function createServerHarness(overrides = {}) {
    const cleanupInactive = jest.fn();
    const buildStatus = jest.fn(() => ({ active: [] }));
    const handleRequest = jest.fn();
    const log = jest.fn();
    const server = createDaemonIpcServer({
      projectRoot: "/tmp/daemon-ipc",
      parseJsonLines: (line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      },
      handleRequest,
      buildStatus,
      cleanupInactive,
      log,
      statusIntervalMs: 20,
      ...overrides,
    });
    servers.push(server);
    return { server, cleanupInactive, buildStatus, handleRequest, log };
  }

  afterEach(() => {
    for (const srv of servers) {
      try {
        srv.stop();
      } catch {
        // ignore
      }
    }
    servers = [];
    jest.useRealTimers();
  });

  test("tracks clients and stops cleanly", () => {
    const { server } = createServerHarness();
    server.listen("/tmp/fake.sock");
    expect(net.createServer).toHaveBeenCalled();

    const socket = createFakeSocket();
    server.server._handler(socket);
    expect(server.hasClients()).toBe(true);

    socket.emit("close");
    expect(server.hasClients()).toBe(false);

    server.stop();
    expect(server.server.close).toHaveBeenCalled();
  });

  test("status sync invokes cleanup and buildStatus when clients connected", () => {
    jest.useFakeTimers();
    const cleanupInactive = jest.fn();
    const buildStatus = jest.fn(() => ({ active: [{ id: "a" }] }));
    const { server } = createServerHarness({ cleanupInactive, buildStatus });

    const socket = createFakeSocket();
    server.server._handler(socket);

    jest.advanceTimersByTime(25);

    expect(cleanupInactive).toHaveBeenCalled();
    expect(buildStatus).toHaveBeenCalled();
  });

  test("pushes status when active_meta activity_state changes", () => {
    jest.useFakeTimers();
    let callCount = 0;
    const buildStatus = jest.fn(() => {
      callCount += 1;
      // Same active list, but activity_state changes on 2nd call
      const state = callCount <= 1 ? "starting" : "working";
      return {
        active: ["claude-code:abc123"],
        active_meta: [{ id: "claude-code:abc123", activity_state: state }],
      };
    });
    const { server } = createServerHarness({ buildStatus });

    const socket = createFakeSocket();
    server.server._handler(socket);

    // First tick — initial push
    jest.advanceTimersByTime(25);
    expect(socket.write).toHaveBeenCalledTimes(1);

    // Second tick — same active list, but meta changed
    jest.advanceTimersByTime(25);
    expect(socket.write).toHaveBeenCalledTimes(2);
  });

  test("does NOT push when active and meta are both unchanged", () => {
    jest.useFakeTimers();
    const buildStatus = jest.fn(() => ({
      active: ["claude-code:abc123"],
      active_meta: [{ id: "claude-code:abc123", activity_state: "working" }],
    }));
    const { server } = createServerHarness({ buildStatus });

    const socket = createFakeSocket();
    server.server._handler(socket);

    // First tick — initial push
    jest.advanceTimersByTime(25);
    expect(socket.write).toHaveBeenCalledTimes(1);

    // Second tick — nothing changed
    jest.advanceTimersByTime(25);
    expect(socket.write).toHaveBeenCalledTimes(1);
  });

  test("routes requests to handler", async () => {
    const handleRequest = jest.fn();
    const { server } = createServerHarness({ handleRequest });

    const socket = createFakeSocket();
    server.server._handler(socket);

    socket.emit("data", Buffer.from(`${JSON.stringify({ type: "ping" })}\n`));
    await new Promise((resolve) => setImmediate(resolve));

    expect(handleRequest).toHaveBeenCalled();
  });
});

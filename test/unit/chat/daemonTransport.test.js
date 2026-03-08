const { createDaemonTransport } = require("../../../src/chat/daemonTransport");
const { DAEMON_TRANSPORT_DEFAULTS } = require("../../../src/chat/daemonTransportDefaults");

describe("chat daemonTransport", () => {
  test("exports complete default contract", () => {
    expect(DAEMON_TRANSPORT_DEFAULTS).toEqual({
      primaryRetries: 25,
      secondaryRetries: 50,
      retryDelayMs: 200,
      restartDelayMs: 1000,
      connectTimeoutMs: 2000,
    });
  });

  test("returns client when primary retry succeeds", async () => {
    const client = { id: "c1" };
    const connectWithRetry = jest.fn().mockResolvedValueOnce(client);
    const startDaemon = jest.fn();
    const isRunning = jest.fn(() => true);
    const transport = createDaemonTransport({
      projectRoot: "/tmp/project",
      sockPath: "/tmp/ufoo.sock",
      isRunning,
      startDaemon,
      connectWithRetry,
    });

    const connected = await transport.connectClient();

    expect(connected).toBe(client);
    expect(connectWithRetry).toHaveBeenCalledTimes(1);
    expect(connectWithRetry).toHaveBeenCalledWith(
      "/tmp/ufoo.sock",
      DAEMON_TRANSPORT_DEFAULTS.primaryRetries,
      DAEMON_TRANSPORT_DEFAULTS.retryDelayMs,
      { timeoutMs: DAEMON_TRANSPORT_DEFAULTS.connectTimeoutMs }
    );
    expect(startDaemon).not.toHaveBeenCalled();
  });

  test("starts daemon then retries when primary retry fails and daemon offline", async () => {
    const client = { id: "c2" };
    const connectWithRetry = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(client);
    const startDaemon = jest.fn();
    const isRunning = jest.fn(() => false);
    const transport = createDaemonTransport({
      projectRoot: "/tmp/project",
      sockPath: "/tmp/ufoo.sock",
      isRunning,
      startDaemon,
      connectWithRetry,
      restartDelayMs: 0,
    });

    const connected = await transport.connectClient();

    expect(connected).toBe(client);
    expect(connectWithRetry).toHaveBeenCalledTimes(2);
    expect(connectWithRetry).toHaveBeenNthCalledWith(
      1,
      "/tmp/ufoo.sock",
      DAEMON_TRANSPORT_DEFAULTS.primaryRetries,
      DAEMON_TRANSPORT_DEFAULTS.retryDelayMs,
      { timeoutMs: DAEMON_TRANSPORT_DEFAULTS.connectTimeoutMs }
    );
    expect(connectWithRetry).toHaveBeenNthCalledWith(
      2,
      "/tmp/ufoo.sock",
      DAEMON_TRANSPORT_DEFAULTS.secondaryRetries,
      DAEMON_TRANSPORT_DEFAULTS.retryDelayMs,
      { timeoutMs: DAEMON_TRANSPORT_DEFAULTS.connectTimeoutMs }
    );
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledWith("/tmp/project");
  });

  test("does not start daemon when fallback retry runs while daemon is already running", async () => {
    const connectWithRetry = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const startDaemon = jest.fn();
    const isRunning = jest.fn(() => true);
    const transport = createDaemonTransport({
      projectRoot: "/tmp/project",
      sockPath: "/tmp/ufoo.sock",
      isRunning,
      startDaemon,
      connectWithRetry,
    });

    const connected = await transport.connectClient();

    expect(connected).toBe(null);
    expect(connectWithRetry).toHaveBeenCalledTimes(2);
    expect(startDaemon).not.toHaveBeenCalled();
  });

  test("setTarget updates future connect target without mutating call contract", async () => {
    const connectWithRetry = jest.fn().mockResolvedValue({ id: "c3" });
    const transport = createDaemonTransport({
      projectRoot: "/tmp/project-a",
      sockPath: "/tmp/a.sock",
      isRunning: jest.fn(() => true),
      startDaemon: jest.fn(),
      connectWithRetry,
    });

    transport.setTarget({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });
    await transport.connectClient();

    expect(connectWithRetry).toHaveBeenCalledWith(
      "/tmp/b.sock",
      DAEMON_TRANSPORT_DEFAULTS.primaryRetries,
      DAEMON_TRANSPORT_DEFAULTS.retryDelayMs,
      { timeoutMs: DAEMON_TRANSPORT_DEFAULTS.connectTimeoutMs }
    );
    expect(transport.getTarget()).toEqual({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });
  });
});

const { restartDaemonFlow } = require("../../../src/app/chat/daemonReconnect");

describe("chat daemonReconnect", () => {
  test("restart flow uses resolveStatusLine for success", async () => {
    const logMessage = jest.fn();
    const resolveStatusLine = jest.fn();
    const stopDaemon = jest.fn();
    const startDaemon = jest.fn();
    const daemonConnection = {
      close: jest.fn(),
      connect: jest.fn().mockResolvedValue(true),
      requestStatus: jest.fn(),
    };

    const restartDaemon = restartDaemonFlow({
      projectRoot: "/tmp/project",
      stopDaemon,
      startDaemon,
      daemonConnection,
      logMessage,
      resolveStatusLine,
    });

    await restartDaemon();

    expect(resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}⚙{/gray-fg} Restarting daemon..."
    );
    expect(stopDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(startDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(daemonConnection.close).toHaveBeenCalledTimes(1);
    expect(daemonConnection.connect).toHaveBeenCalledTimes(1);
    expect(daemonConnection.requestStatus).toHaveBeenCalledTimes(1);
    expect(resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}✓{/gray-fg} Daemon reconnected"
    );
    // Status messages should NOT go to logMessage
    expect(logMessage).not.toHaveBeenCalledWith(
      "status",
      expect.anything()
    );
  });

  test("restart flow falls back to logMessage when no resolveStatusLine", async () => {
    const logMessage = jest.fn();
    const stopDaemon = jest.fn();
    const startDaemon = jest.fn();
    const daemonConnection = {
      close: jest.fn(),
      connect: jest.fn().mockResolvedValue(true),
      requestStatus: jest.fn(),
    };

    const restartDaemon = restartDaemonFlow({
      projectRoot: "/tmp/project",
      stopDaemon,
      startDaemon,
      daemonConnection,
      logMessage,
    });

    await restartDaemon();

    expect(logMessage).toHaveBeenCalledWith(
      "status",
      "{gray-fg}⚙{/gray-fg} Restarting daemon..."
    );
    expect(logMessage).toHaveBeenCalledWith(
      "status",
      "{gray-fg}✓{/gray-fg} Daemon reconnected"
    );
  });

  test("restart flow uses resolveStatusLine for failure", async () => {
    const logMessage = jest.fn();
    const resolveStatusLine = jest.fn();
    const stopDaemon = jest.fn();
    const startDaemon = jest.fn();
    const daemonConnection = {
      close: jest.fn(),
      connect: jest.fn().mockResolvedValue(false),
    };

    const restartDaemon = restartDaemonFlow({
      projectRoot: "/tmp/project",
      stopDaemon,
      startDaemon,
      daemonConnection,
      logMessage,
      resolveStatusLine,
    });

    await restartDaemon();

    expect(resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}⚙{/gray-fg} Restarting daemon..."
    );
    expect(resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}✗{/gray-fg} Failed to reconnect to daemon"
    );
  });

  test("restart flow cleans stale state before starting when daemon is already down", async () => {
    const logMessage = jest.fn();
    const resolveStatusLine = jest.fn();
    const stopDaemon = jest.fn(() => true);
    const startDaemon = jest.fn(() => true);
    const states = [false, true];
    const isDaemonRunning = jest.fn(() => states.shift() ?? true);
    const daemonConnection = {
      close: jest.fn(),
      connect: jest.fn().mockResolvedValue(true),
      requestStatus: jest.fn(),
    };

    const restartDaemon = restartDaemonFlow({
      projectRoot: "/tmp/project",
      stopDaemon,
      startDaemon,
      isDaemonRunning,
      daemonConnection,
      logMessage,
      resolveStatusLine,
      sleep: jest.fn(() => Promise.resolve()),
    });

    await restartDaemon();

    expect(stopDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(startDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(daemonConnection.connect).toHaveBeenCalledTimes(1);
    expect(resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}✓{/gray-fg} Daemon reconnected"
    );
  });

  test("restart flow guards reentry", async () => {
    const logMessage = jest.fn();
    const stopDaemon = jest.fn();
    const startDaemon = jest.fn();
    let resolveConnect;
    const connectPromise = new Promise((resolve) => {
      resolveConnect = resolve;
    });
    const daemonConnection = {
      close: jest.fn(),
      connect: jest.fn(() => connectPromise),
    };

    const restartDaemon = restartDaemonFlow({
      projectRoot: "/tmp/project",
      stopDaemon,
      startDaemon,
      daemonConnection,
      logMessage,
    });

    const first = restartDaemon();
    const second = restartDaemon();
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(daemonConnection.connect).toHaveBeenCalledTimes(1);

    resolveConnect(true);
    await first;
    await second;
  });
});

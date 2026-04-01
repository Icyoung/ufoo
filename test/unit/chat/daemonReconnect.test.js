const { restartDaemonFlow } = require("../../../src/chat/daemonReconnect");

describe("chat daemonReconnect", () => {
  test("restart flow uses resolveStatusLine for success", async () => {
    const logMessage = jest.fn();
    const resolveStatusLine = jest.fn();
    const stopDaemon = jest.fn();
    const startDaemon = jest.fn();
    const daemonConnection = {
      close: jest.fn(),
      connect: jest.fn().mockResolvedValue(true),
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

    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect(daemonConnection.connect).toHaveBeenCalledTimes(1);

    resolveConnect(true);
    await first;
    await second;
  });
});

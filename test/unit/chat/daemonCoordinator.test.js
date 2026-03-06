const { EventEmitter } = require("events");
const { createDaemonCoordinator } = require("../../../src/chat/daemonCoordinator");

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }

  write(data) {
    this.writes.push(data);
  }

  end() {
    this.destroyed = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}


describe("chat daemonCoordinator", () => {
  test("throws when daemonTransport connectClient is missing or invalid", () => {
    expect(() => createDaemonCoordinator({ daemonTransport: {} })).toThrow(
      "createDaemonCoordinator requires connectClient, daemonTransport, or daemonConnection"
    );
    expect(() => createDaemonCoordinator({ daemonTransport: { connectClient: true } })).toThrow(
      "createDaemonCoordinator requires connectClient, daemonTransport, or daemonConnection"
    );
  });

  test("throws when no connection source is provided", () => {
    expect(() => createDaemonCoordinator({})).toThrow(
      "createDaemonCoordinator requires connectClient, daemonTransport, or daemonConnection"
    );
  });

  test("delegates connection API to daemonConnection", async () => {
    const daemonConnection = {
      connect: jest.fn().mockResolvedValue(true),
      requestStatus: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      markExit: jest.fn(),
      getState: jest.fn(() => ({ client: { destroyed: false } })),
    };
    const restartDaemon = jest.fn();

    const coordinator = createDaemonCoordinator({
      daemonConnection,
      restartDaemon,
    });

    await coordinator.connect();
    coordinator.requestStatus();
    coordinator.send({ type: "status" });
    coordinator.close();
    coordinator.markExit();
    coordinator.restart();

    expect(daemonConnection.connect).toHaveBeenCalledTimes(1);
    expect(daemonConnection.requestStatus).toHaveBeenCalledTimes(1);
    expect(daemonConnection.send).toHaveBeenCalledWith({ type: "status" });
    expect(daemonConnection.close).toHaveBeenCalledTimes(1);
    expect(daemonConnection.markExit).toHaveBeenCalledTimes(1);
    expect(restartDaemon).toHaveBeenCalledTimes(1);
  });

  test("isConnected reflects daemonConnection state", () => {
    const daemonConnection = {
      connect: jest.fn(),
      requestStatus: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      markExit: jest.fn(),
      getState: jest.fn(() => ({ client: { destroyed: false } })),
    };
    const coordinator = createDaemonCoordinator({ daemonConnection, restartDaemon: jest.fn() });

    expect(coordinator.isConnected()).toBe(true);

    daemonConnection.getState.mockReturnValue({ client: { destroyed: true } });
    expect(coordinator.isConnected()).toBe(false);

    daemonConnection.getState.mockReturnValue({ client: null });
    expect(coordinator.isConnected()).toBe(false);
  });

  test("uses daemonTransport connectClient when provided", async () => {
    const connectClient = jest.fn().mockResolvedValue(new FakeClient());
    const daemonTransport = { connectClient };
    const stopDaemon = jest.fn();
    const startDaemon = jest.fn();
    const coordinator = createDaemonCoordinator({
      projectRoot: "/tmp/project",
      daemonTransport,
      handleMessage: jest.fn(() => false),
      queueStatusLine: jest.fn(),
      resolveStatusLine: jest.fn(),
      logMessage: jest.fn(),
      stopDaemon,
      startDaemon,
    });

    const connected = await coordinator.connect();
    expect(connected).toBe(true);
    expect(connectClient).toHaveBeenCalledTimes(1);
  });

  test("integrates reconnect then restart flow", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const third = new FakeClient();
    const connectClient = jest.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValueOnce(third);
    const handleMessage = jest.fn(() => false);
    const queueStatusLine = jest.fn();
    const resolveStatusLine = jest.fn();
    const logMessage = jest.fn();
    const stopDaemon = jest.fn();
    const startDaemon = jest.fn();

    const coordinator = createDaemonCoordinator({
      projectRoot: "/tmp/project",
      connectClient,
      handleMessage,
      queueStatusLine,
      resolveStatusLine,
      logMessage,
      stopDaemon,
      startDaemon,
    });

    const connected = await coordinator.connect();
    expect(connected).toBe(true);

    first.emit("close");
    await flushPromises();
    await flushPromises();

    expect(queueStatusLine).toHaveBeenCalledWith("Reconnecting to daemon");
    expect(resolveStatusLine).toHaveBeenCalledWith("{gray-fg}✓{/gray-fg} Daemon reconnected");

    await coordinator.restart();

    expect(stopDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(startDaemon).toHaveBeenCalledWith("/tmp/project");
    expect(logMessage).toHaveBeenCalledWith(
      "status",
      "{white-fg}⚙{/white-fg} Restarting daemon..."
    );
    expect(logMessage).toHaveBeenCalledWith(
      "status",
      "{white-fg}✓{/white-fg} Daemon reconnected"
    );
    expect(connectClient).toHaveBeenCalledTimes(3);
    expect(coordinator.isConnected()).toBe(true);
  });

  test("switchProject uses transport connect-before-disconnect and updates target", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const daemonTransport = {
      connectClient: jest.fn().mockResolvedValue(first),
      connectClientForTarget: jest.fn().mockResolvedValue(second),
      setTarget: jest.fn(),
    };

    const coordinator = createDaemonCoordinator({
      projectRoot: "/tmp/project-a",
      daemonTransport,
      handleMessage: jest.fn(() => false),
      queueStatusLine: jest.fn(),
      resolveStatusLine: jest.fn(),
      logMessage: jest.fn(),
      stopDaemon: jest.fn(),
      startDaemon: jest.fn(),
    });

    const connected = await coordinator.connect();
    expect(connected).toBe(true);

    const result = await coordinator.switchProject({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });

    expect(result.ok).toBe(true);
    expect(daemonTransport.connectClientForTarget).toHaveBeenCalledWith({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });
    expect(daemonTransport.setTarget).toHaveBeenCalledWith({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });
    expect(second.writes).toContain('{"type":"status"}\n');
  });

  test("switchProject serializes concurrent calls in order", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const third = new FakeClient();
    const firstTargetConnect = createDeferred();
    let connectTargetCalls = 0;
    const daemonTransport = {
      connectClient: jest.fn().mockResolvedValue(first),
      connectClientForTarget: jest.fn().mockImplementation(() => {
        connectTargetCalls += 1;
        if (connectTargetCalls === 1) {
          return firstTargetConnect.promise.then(() => second);
        }
        return Promise.resolve(third);
      }),
      setTarget: jest.fn(),
    };

    const coordinator = createDaemonCoordinator({
      projectRoot: "/tmp/project-a",
      daemonTransport,
      handleMessage: jest.fn(() => false),
      queueStatusLine: jest.fn(),
      resolveStatusLine: jest.fn(),
      logMessage: jest.fn(),
      stopDaemon: jest.fn(),
      startDaemon: jest.fn(),
    });

    await coordinator.connect();

    const p1 = coordinator.switchProject({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });
    const p2 = coordinator.switchProject({
      projectRoot: "/tmp/project-c",
      sockPath: "/tmp/c.sock",
    });

    await flushPromises();
    expect(connectTargetCalls).toBe(1);

    firstTargetConnect.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(connectTargetCalls).toBe(2);
    expect(daemonTransport.setTarget).toHaveBeenNthCalledWith(1, {
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });
    expect(daemonTransport.setTarget).toHaveBeenNthCalledWith(2, {
      projectRoot: "/tmp/project-c",
      sockPath: "/tmp/c.sock",
    });
    expect(coordinator.getState().client).toBe(third);
  });

  test("switchProject failure does not set target and keeps current connection", async () => {
    const first = new FakeClient();
    const daemonTransport = {
      connectClient: jest.fn().mockResolvedValue(first),
      connectClientForTarget: jest.fn().mockResolvedValue(null),
      setTarget: jest.fn(),
    };

    const coordinator = createDaemonCoordinator({
      projectRoot: "/tmp/project-a",
      daemonTransport,
      handleMessage: jest.fn(() => false),
      queueStatusLine: jest.fn(),
      resolveStatusLine: jest.fn(),
      logMessage: jest.fn(),
      stopDaemon: jest.fn(),
      startDaemon: jest.fn(),
    });

    await coordinator.connect();
    const beforeClient = coordinator.getState().client;
    const result = await coordinator.switchProject({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });

    expect(result.ok).toBe(false);
    expect(daemonTransport.setTarget).not.toHaveBeenCalled();
    expect(coordinator.getState().client).toBe(beforeClient);
    coordinator.send({ type: "status_after_fail" });
    expect(first.writes).toContain('{"type":"status_after_fail"}\n');
  });

  test("switchProject rapid sequence converges to last target", async () => {
    const first = new FakeClient();
    const targetClients = Array.from({ length: 12 }, () => new FakeClient());
    let connectIdx = 0;
    const daemonTransport = {
      connectClient: jest.fn().mockResolvedValue(first),
      connectClientForTarget: jest.fn().mockImplementation(async () => {
        const next = targetClients[connectIdx] || targetClients[targetClients.length - 1];
        connectIdx += 1;
        return next;
      }),
      setTarget: jest.fn(),
    };

    const coordinator = createDaemonCoordinator({
      projectRoot: "/tmp/project-a",
      daemonTransport,
      handleMessage: jest.fn(() => false),
      queueStatusLine: jest.fn(),
      resolveStatusLine: jest.fn(),
      logMessage: jest.fn(),
      stopDaemon: jest.fn(),
      startDaemon: jest.fn(),
    });

    await coordinator.connect();

    const promises = Array.from({ length: 12 }, (_, i) => coordinator.switchProject({
      projectRoot: `/tmp/project-${i + 1}`,
      sockPath: `/tmp/${i + 1}.sock`,
    }));
    const results = await Promise.all(promises);

    expect(results.every((r) => r && r.ok === true)).toBe(true);
    expect(daemonTransport.connectClientForTarget).toHaveBeenCalledTimes(12);
    expect(daemonTransport.setTarget).toHaveBeenCalledTimes(12);
    expect(daemonTransport.setTarget).toHaveBeenLastCalledWith({
      projectRoot: "/tmp/project-12",
      sockPath: "/tmp/12.sock",
    });
    expect(coordinator.getState().client).toBe(targetClients[11]);
  });

  test("switchProject queue continues after an earlier failure", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    let targetCall = 0;
    const daemonTransport = {
      connectClient: jest.fn().mockResolvedValue(first),
      connectClientForTarget: jest.fn().mockImplementation(async () => {
        targetCall += 1;
        if (targetCall === 1) return null;
        return second;
      }),
      setTarget: jest.fn(),
    };

    const coordinator = createDaemonCoordinator({
      projectRoot: "/tmp/project-a",
      daemonTransport,
      handleMessage: jest.fn(() => false),
      queueStatusLine: jest.fn(),
      resolveStatusLine: jest.fn(),
      logMessage: jest.fn(),
      stopDaemon: jest.fn(),
      startDaemon: jest.fn(),
    });

    await coordinator.connect();

    const p1 = coordinator.switchProject({
      projectRoot: "/tmp/project-b",
      sockPath: "/tmp/b.sock",
    });
    const p2 = coordinator.switchProject({
      projectRoot: "/tmp/project-c",
      sockPath: "/tmp/c.sock",
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
    expect(daemonTransport.setTarget).toHaveBeenCalledTimes(1);
    expect(daemonTransport.setTarget).toHaveBeenCalledWith({
      projectRoot: "/tmp/project-c",
      sockPath: "/tmp/c.sock",
    });
    expect(coordinator.getState().client).toBe(second);
  });

});

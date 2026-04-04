const { EventEmitter } = require("events");
const { createDaemonConnection } = require("../../../src/chat/daemonConnection");

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

describe("chat daemonConnection", () => {
  function createHarness(overrides = {}) {
    const connectClient = jest.fn();
    const handleMessage = jest.fn(() => false);
    const queueStatusLine = jest.fn();
    const resolveStatusLine = jest.fn();
    const logMessage = jest.fn();

    const connection = createDaemonConnection({
      connectClient,
      handleMessage,
      queueStatusLine,
      resolveStatusLine,
      logMessage,
      ...overrides,
    });

    return {
      connection,
      connectClient,
      handleMessage,
      queueStatusLine,
      resolveStatusLine,
      logMessage,
    };
  }

  test("connect attaches client and send writes payload", async () => {
    const first = new FakeClient();
    const { connection, connectClient } = createHarness();
    connectClient.mockResolvedValueOnce(first);

    const ok = await connection.connect();
    connection.send({ type: "status" });

    expect(ok).toBe(true);
    expect(first.writes).toEqual(['{"type":"status"}\n']);
  });

  test("disconnect triggers reconnect with status bar only (no chat log)", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { connection, connectClient, queueStatusLine, resolveStatusLine, logMessage } = createHarness();
    connectClient.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await connection.connect();
    first.emit("close");
    await flushPromises();
    await flushPromises();

    // Disconnect and reconnect should NOT log to chat — only status bar
    expect(logMessage).not.toHaveBeenCalledWith(
      "status",
      "{white-fg}✗{/white-fg} Daemon disconnected"
    );
    expect(logMessage).not.toHaveBeenCalledWith(
      "status",
      "{white-fg}⚙{/white-fg} Reconnecting to daemon..."
    );
    expect(queueStatusLine).toHaveBeenCalledWith("Reconnecting to daemon", { key: "daemon-reconnect" });
    expect(resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}✓{/gray-fg} Daemon reconnected",
      { key: "daemon-reconnect" }
    );
    expect(second.writes).toContain('{"type":"status"}\n');
  });

  test("send queues while disconnected and flushes after reconnect", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { connection, connectClient } = createHarness();
    connectClient.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    await connection.connect();
    first.destroyed = true;
    connection.send({ type: "ping", data: { ok: true } });
    await flushPromises();
    await flushPromises();

    expect(second.writes).toContain('{"type":"ping","data":{"ok":true}}\n');
  });

  test("markExit prevents reconnect on disconnect", async () => {
    const first = new FakeClient();
    const { connection, connectClient } = createHarness();
    connectClient.mockResolvedValue(first);

    await connection.connect();
    connection.markExit();
    first.emit("close");
    await flushPromises();

    expect(connectClient).toHaveBeenCalledTimes(1);
  });

  test("switchConnection keeps old client when target connect fails", async () => {
    const first = new FakeClient();
    const { connection, connectClient, resolveStatusLine } = createHarness();
    connectClient.mockResolvedValueOnce(first);

    await connection.connect();
    const result = await connection.switchConnection({
      connectClient: async () => null,
    });

    expect(result.ok).toBe(false);
    expect(resolveStatusLine).toHaveBeenCalledWith("{gray-fg}✗{/gray-fg} Switch failed", { key: "daemon-switch" });
    expect(connection.getState().client).toBe(first);
    connection.send({ type: "status_after_fail" });
    expect(first.writes).toContain('{"type":"status_after_fail"}\n');
  });

  test("switchConnection swaps to new client and requests status", async () => {
    const first = new FakeClient();
    const second = new FakeClient();
    const { connection, connectClient } = createHarness();
    connectClient.mockResolvedValueOnce(first);

    await connection.connect();
    const result = await connection.switchConnection({
      connectClient: async () => second,
    });

    expect(result).toEqual({ ok: true });
    expect(connection.getState().client).toBe(second);
    expect(second.writes).toContain('{"type":"status"}\n');
  });

  test("switchConnection handles thrown errors and keeps old client alive", async () => {
    const first = new FakeClient();
    const { connection, connectClient, resolveStatusLine, logMessage } = createHarness();
    connectClient.mockResolvedValueOnce(first);

    await connection.connect();
    const result = await connection.switchConnection({
      connectClient: async () => {
        throw new Error("boom");
      },
    });

    expect(result).toEqual({ ok: false, error: "boom" });
    expect(connection.getState().client).toBe(first);
    expect(resolveStatusLine).toHaveBeenCalledWith("{gray-fg}✗{/gray-fg} Switch failed", { key: "daemon-switch" });
    expect(logMessage).toHaveBeenCalledWith("error", "{white-fg}✗{/white-fg} boom");
    connection.send({ type: "status_after_throw" });
    expect(first.writes).toContain('{"type":"status_after_throw"}\n');
  });

  test("switchConnection times out and resolves switch pending status", async () => {
    const first = new FakeClient();
    const deferred = new Promise(() => {});
    const { connection, connectClient, resolveStatusLine } = createHarness({
      switchConnectionTimeoutMs: 5,
    });
    connectClient.mockResolvedValueOnce(first);

    await connection.connect();
    const result = await connection.switchConnection({
      connectClient: () => deferred,
    });

    expect(result.ok).toBe(false);
    expect(String(result.error || "")).toContain("timed out");
    expect(resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}✗{/gray-fg} Switch failed",
      { key: "daemon-switch" }
    );
    expect(connection.getState().client).toBe(first);
  });
});

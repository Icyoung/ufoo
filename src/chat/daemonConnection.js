const { IPC_REQUEST_TYPES } = require("../shared/eventContract");

function createDaemonConnection(options = {}) {
  const {
    connectClient: connectClientOption,
    handleMessage,
    queueStatusLine,
    resolveStatusLine,
    logMessage,
    switchConnectionTimeoutMs = 18000,
  } = options;

  let connectClient = connectClientOption;
  let client = null;
  let reconnectPromise = null;
  let exitRequested = false;
  let connectionLostNotified = false;
  const pendingRequests = [];
  const MAX_PENDING_REQUESTS = 50;
  const STATUS_KEY_RECONNECT = "daemon-reconnect";
  const STATUS_KEY_SWITCH = "daemon-switch";
  const DEFAULT_SWITCH_TIMEOUT_MS = Number.isFinite(switchConnectionTimeoutMs)
    && switchConnectionTimeoutMs > 0
    ? Math.trunc(switchConnectionTimeoutMs)
    : 18000;

  function withTimeout(promiseLike, timeoutMs, timeoutMessage) {
    const ms = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.trunc(timeoutMs)
      : DEFAULT_SWITCH_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(timeoutMessage || `operation timed out after ${ms}ms`);
        err.code = "UFOO_TIMEOUT";
        reject(err);
      }, ms);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      Promise.resolve(promiseLike).then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function enqueueRequest(req) {
    if (!req || req.type === IPC_REQUEST_TYPES.STATUS) return;
    pendingRequests.push(req);
    if (pendingRequests.length > MAX_PENDING_REQUESTS) {
      pendingRequests.shift();
    }
  }

  function flushPendingRequests() {
    if (!client || client.destroyed) return;
    while (pendingRequests.length > 0) {
      const req = pendingRequests.shift();
      client.write(`${JSON.stringify(req)}\n`);
    }
  }

  function detachClient(target = client) {
    if (!target) return;
    target.removeAllListeners("data");
    target.removeAllListeners("close");
    target.removeAllListeners("error");
    if (target === client) {
      client = null;
    }
    try {
      target.end();
      target.destroy();
    } catch {
      // ignore
    }
  }

  function attachClient(newClient) {
    if (!newClient) return;
    detachClient();
    client = newClient;
    connectionLostNotified = false;
    let buffer = "";
    client.on("data", (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines.filter((l) => l.trim())) {
        try {
          const msg = JSON.parse(line);
          const shouldStop = handleMessage(msg);
          if (shouldStop) {
            return;
          }
        } catch {
          // ignore
        }
      }
    });
    const handleDisconnect = () => {
      if (client === newClient) {
        client = null;
      }
      if (exitRequested) return;
      if (!connectionLostNotified) {
        connectionLostNotified = true;
        logMessage("status", "{white-fg}✗{/white-fg} Daemon disconnected");
      }
      void ensureConnected();
    };
    client.on("close", handleDisconnect);
    client.on("error", handleDisconnect);
    flushPendingRequests();
  }

  async function ensureConnected() {
    if (client && !client.destroyed) return true;
    if (exitRequested) return false;
    if (reconnectPromise) return reconnectPromise;
    queueStatusLine("Reconnecting to daemon", { key: STATUS_KEY_RECONNECT });
    logMessage("status", "{white-fg}⚙{/white-fg} Reconnecting to daemon...");
    reconnectPromise = (async () => {
      const newClient = await connectClient();
      if (!newClient) {
        resolveStatusLine("{gray-fg}✗{/gray-fg} Daemon offline", { key: STATUS_KEY_RECONNECT });
        logMessage("error", "{white-fg}✗{/white-fg} Failed to reconnect to daemon");
        return false;
      }
      attachClient(newClient);
      connectionLostNotified = false;
      resolveStatusLine("{gray-fg}✓{/gray-fg} Daemon reconnected", { key: STATUS_KEY_RECONNECT });
      requestStatus();
      return true;
    })();
    try {
      return await reconnectPromise;
    } finally {
      reconnectPromise = null;
    }
  }

  async function connect() {
    if (client && !client.destroyed) return true;
    const newClient = await connectClient();
    if (!newClient) return false;
    attachClient(newClient);
    return true;
  }

  async function switchConnection(next = {}) {
    const nextConnectClient = typeof next.connectClient === "function"
      ? next.connectClient
      : null;
    if (!nextConnectClient) {
      return { ok: false, error: "switchConnection requires connectClient" };
    }
    const previousClient = client;
    try {
      queueStatusLine("Switching daemon connection", { key: STATUS_KEY_SWITCH });
      const timeoutMs = Number.isFinite(next.timeoutMs) && next.timeoutMs > 0
        ? Math.trunc(next.timeoutMs)
        : DEFAULT_SWITCH_TIMEOUT_MS;
      const nextClient = await withTimeout(
        nextConnectClient(),
        timeoutMs,
        `Switch connection timed out after ${timeoutMs}ms`
      );
      if (!nextClient) {
        resolveStatusLine("{gray-fg}✗{/gray-fg} Switch failed", { key: STATUS_KEY_SWITCH });
        return { ok: false, error: "Failed to connect target daemon" };
      }
      connectClient = nextConnectClient;
      attachClient(nextClient);
      if (next.callRequestStatus !== false) {
        requestStatus();
      }
      resolveStatusLine("{gray-fg}✓{/gray-fg} Daemon switched", { key: STATUS_KEY_SWITCH });
      return { ok: true };
    } catch (err) {
      // Keep existing connection alive on switch failures.
      if (previousClient && (!client || client.destroyed)) {
        client = previousClient;
      }
      const message = err && err.message ? err.message : String(err || "switch failed");
      resolveStatusLine("{gray-fg}✗{/gray-fg} Switch failed", { key: STATUS_KEY_SWITCH });
      logMessage("error", `{white-fg}✗{/white-fg} ${message}`);
      return { ok: false, error: message };
    }
  }

  function send(req) {
    if (!client || client.destroyed) {
      enqueueRequest(req);
      void ensureConnected();
      return;
    }
    client.write(`${JSON.stringify(req)}\n`);
  }

  function requestStatus() {
    send({ type: IPC_REQUEST_TYPES.STATUS });
  }

  function close() {
    detachClient();
  }

  function markExit() {
    exitRequested = true;
  }

  function getState() {
    return {
      client,
      reconnectPromise,
      pendingRequestCount: pendingRequests.length,
      exitRequested,
      connectionLostNotified,
    };
  }

  return {
    connect,
    send,
    requestStatus,
    switchConnection,
    close,
    markExit,
    getState,
  };
}

module.exports = {
  createDaemonConnection,
};

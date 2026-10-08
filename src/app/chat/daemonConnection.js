const { IPC_REQUEST_TYPES, IPC_RESPONSE_TYPES } = require("../../runtime/contracts/eventContract");
const { randomUUID } = require("crypto");

function createDaemonConnection(options = {}) {
  const {
    connectClient: connectClientOption,
    handleMessage,
    queueStatusLine,
    resolveStatusLine,
    logMessage,
    transformRequest: transformRequestOption = (request) => request,
    switchConnectionTimeoutMs = 18000,
  } = options;

  let connectClient = connectClientOption;
  let transformRequest = transformRequestOption;
  let client = null;
  let reconnectPromise = null;
  let exitRequested = false;
  let connectionLostNotified = false;
  const pendingRequests = [];
  const MAX_PENDING_REQUESTS = 50;
  const STATUS_KEY_RECONNECT = "daemon-reconnect";
  const STATUS_KEY_SWITCH = "daemon-switch";
  const runtimeCursors = new Map();
  const runtimeReplays = new Map();
  const replayByScope = new Map();
  const scopeFor = (event) => `${event.projectRoot || ""}:${event.sessionId}`;
  function requestReplay(cursor, allowedTasks = null) {
    const scope = scopeFor(cursor);
    if (!client || replayByScope.has(scope)) return;
    const requestId = `replay-${randomUUID()}`;
    const replay = { ...cursor, scope, requestId, events: [], buffered: [], allowedTasks };
    replayByScope.set(scope, replay); runtimeReplays.set(requestId, replay);
    writeReplay(replay);
  }
  function writeReplay(replay) {
    client.write(`${JSON.stringify(transformRequest({ type: IPC_REQUEST_TYPES.AGENT_RUNTIME, operation: "events", request_id: replay.requestId,
      project_root: replay.projectRoot, session_id: replay.sessionId, after_sequence: replay.sequence || 0 }))}\n`);
  }
  function deliverRuntime(event) {
    const scope = scopeFor(event);
    runtimeCursors.set(scope, { projectRoot: event.projectRoot, sessionId: event.sessionId, sequence: Math.max(runtimeCursors.get(scope)?.sequence || 0, event.sequence || 0) });
    handleMessage({ type: IPC_RESPONSE_TYPES.RUNTIME_EVENT, data: event });
  }
  function receive(msg) {
    if (msg.type === IPC_RESPONSE_TYPES.RUNTIME_EVENT) {
      const replay = replayByScope.get(scopeFor(msg.data || {}));
      if (replay) { replay.buffered.push(msg.data); if (replay.buffered.length > 4096) replay.buffered.shift(); }
      else deliverRuntime(msg.data);
      return;
    }
    const replay = runtimeReplays.get(msg.request_id);
    if (msg.type === IPC_RESPONSE_TYPES.ERROR && replay) {
      runtimeReplays.delete(replay.requestId); replayByScope.delete(replay.scope);
      replay.buffered.sort((a, b) => a.sequence - b.sequence).forEach(deliverRuntime);
    }
    if (msg.type === IPC_RESPONSE_TYPES.RUNTIME_RESULT && replay) {
      (msg.data.events || []).filter((event) => !replay.allowedTasks || replay.allowedTasks.has(event.taskRunId)).forEach(deliverRuntime);
      if (msg.data.has_more) { replay.sequence = msg.data.next_sequence; writeReplay(replay); return; }
      runtimeReplays.delete(replay.requestId); replayByScope.delete(replay.scope);
      const events = replay.buffered;
      events.sort((a, b) => a.sequence - b.sequence).forEach(deliverRuntime);
      runtimeCursors.set(replay.scope, { projectRoot: replay.projectRoot, sessionId: replay.sessionId, sequence: Math.max(runtimeCursors.get(replay.scope)?.sequence || 0, msg.data.next_sequence || 0) });
      return;
    }
    if (msg.type === IPC_RESPONSE_TYPES.STATUS && msg.data?.agent_runtime) {
      const runtime = msg.data.agent_runtime;
      const scopes = [...(runtime.sessions || []), ...(runtime.children || []).map((task) => ({ sessionId: task.sessionId, tasks: [task] }))];
      for (const session of scopes) {
        const active = session.tasks.filter((task) => ["queued", "running", "waiting_user"].includes(task.status));
        const cursor = { projectRoot: msg.data.project_root || msg.data.projectRoot || "", sessionId: session.sessionId, sequence: 0 };
        if (active.length && !runtimeCursors.has(scopeFor(cursor))) requestReplay(cursor, new Set(active.map((task) => task.taskRunId)));
      }
    }
    handleMessage(msg);
  }
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
      client.write(`${JSON.stringify(transformRequest(req))}\n`);
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
          receive(msg);
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
      }
      void ensureConnected();
    };
    client.on("close", handleDisconnect);
    client.on("error", handleDisconnect);
    runtimeReplays.clear(); replayByScope.clear();
    for (const cursor of runtimeCursors.values()) requestReplay(cursor);
    flushPendingRequests();
  }

  async function ensureConnected() {
    if (client && !client.destroyed) return true;
    if (exitRequested) return false;
    if (reconnectPromise) return reconnectPromise;
    queueStatusLine("Reconnecting to daemon", { key: STATUS_KEY_RECONNECT });
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
      if (typeof next.transformRequest === "function") {
        transformRequest = next.transformRequest;
      }
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
    client.write(`${JSON.stringify(transformRequest(req))}\n`);
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

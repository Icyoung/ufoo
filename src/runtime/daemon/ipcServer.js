"use strict";

const net = require("net");
const { IPC_RESPONSE_TYPES } = require("../contracts/eventContract");

function createDaemonIpcServer(options = {}) {
  const {
    projectRoot,
    parseJsonLines = () => [],
    handleRequest = async () => {},
    buildStatus = () => ({}),
    cleanupInactive = () => {},
    log = () => {},
    statusIntervalMs = 3000,
  } = options;

  const sockets = new Set();
  const socketListeners = new Map();
  function detachSocket(socket) {
    sockets.delete(socket);
    const listeners = socketListeners.get(socket);
    if (listeners) {
      socket.removeListener("close", listeners.close);
      socket.removeListener("error", listeners.error);
      socketListeners.delete(socket);
    }
  }
  function attachSocket(socket) {
    if (!socket || socket.destroyed || typeof socket.on !== "function" || socketListeners.has(socket)) return;
    const listeners = {
      close: () => detachSocket(socket),
      error: (err) => log(`ipc socket error: ${err && err.message ? err.message : String(err || "unknown error")}`),
    };
    sockets.add(socket);
    socketListeners.set(socket, listeners);
    socket.on("close", listeners.close);
    socket.on("error", listeners.error);
  }
  const sendToSockets = (payload) => {
    const line = `${JSON.stringify(payload)}\n`;
    for (const sock of sockets) {
      if (!sock || sock.destroyed) continue;
      try {
        sock.write(line);
      } catch {
        // ignore write errors
      }
    }
  };

  let lastActiveJson = "";
  let lastMetaJson = "";
  const statusSyncInterval = setInterval(() => {
    if (sockets.size === 0) return;
    try {
      cleanupInactive();
    } catch {
      // ignore cleanup errors
    }
    try {
      const status = buildStatus(projectRoot);
      const currentActiveJson = JSON.stringify(status.active);
      const currentMetaJson = JSON.stringify(
        (status.active_meta || []).map((m) => `${m.id}:${m.activity_state || ""}`)
      );
      if (currentActiveJson !== lastActiveJson || currentMetaJson !== lastMetaJson) {
        lastActiveJson = currentActiveJson;
        lastMetaJson = currentMetaJson;
        sendToSockets({ type: IPC_RESPONSE_TYPES.STATUS, data: status });
        log(`status sync: active agents changed to ${status.active.length}`);
      }
    } catch {
      // ignore status check errors
    }
  }, statusIntervalMs);

  const server = net.createServer((socket) => {
    attachSocket(socket);
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      const complete = lines.filter((l) => l.trim());
      for (const line of complete) {
        const items = parseJsonLines(line);
        for (const req of items) {
          if (!req || typeof req !== "object") continue;
          Promise.resolve().then(() => handleRequest(req, socket)).catch((err) => {
            const message = err && err.message ? err.message : String(err || "request failed");
            const requestType = String(req.type || "unknown");
            log(`ipc request failed type=${requestType}: ${err && err.stack ? err.stack : message}`);
            try {
              socket.write(`${JSON.stringify({
                type: IPC_RESPONSE_TYPES.ERROR,
                error: message,
                request_type: requestType,
              })}\n`);
            } catch {
              // ignore failed error replies
            }
          });
        }
      }
    });
  });

  server.on("error", (err) => {
    log(`ipc server error: ${err && err.message ? err.message : String(err || "unknown error")}`);
  });

  function listen(sockPath) {
    server.listen(sockPath);
  }

  function stop() {
    clearInterval(statusSyncInterval);
    for (const socket of [...sockets]) {
      socket.destroy?.();
      detachSocket(socket);
    }
    sockets.clear();
    try {
      server.close();
    } catch {
      // ignore close errors
    }
  }

  function hasClients() {
    return sockets.size > 0;
  }

  return {
    server,
    sockets,
    attachSocket,
    detachSocket,
    sendToSockets,
    listen,
    stop,
    hasClients,
  };
}

module.exports = {
  createDaemonIpcServer,
};

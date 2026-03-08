"use strict";

const net = require("net");
const { IPC_RESPONSE_TYPES } = require("../shared/eventContract");

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
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", async (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      const complete = lines.filter((l) => l.trim());
      for (const line of complete) {
        const items = parseJsonLines(line);
        for (const req of items) {
          if (!req || typeof req !== "object") continue;
          await handleRequest(req, socket);
        }
      }
    });
  });

  function listen(sockPath) {
    server.listen(sockPath);
  }

  function stop() {
    clearInterval(statusSyncInterval);
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
    sendToSockets,
    listen,
    stop,
    hasClients,
  };
}

module.exports = {
  createDaemonIpcServer,
};

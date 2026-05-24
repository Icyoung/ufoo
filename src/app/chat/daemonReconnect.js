const { restartLocks } = require("./daemonTransport");

function resolveDaemonConnection(daemonConnection) {
  return typeof daemonConnection === "function" ? daemonConnection() : daemonConnection;
}

function restartDaemonFlow(options = {}) {
  const {
    projectRoot,
    stopDaemon,
    startDaemon,
    daemonConnection,
    logMessage,
    resolveStatusLine = null,
  } = options;

  const statusMsg = resolveStatusLine || ((text) => logMessage("status", text));

  return async function restartDaemon() {
    // Use global restart lock to prevent concurrent restart flows
    if (restartLocks.get(projectRoot)) return;
    restartLocks.set(projectRoot, true);
    statusMsg("{gray-fg}⚙{/gray-fg} Restarting daemon...");
    try {
      const connection = resolveDaemonConnection(daemonConnection);
      if (connection) {
        connection.close();
      }
      stopDaemon(projectRoot);
      startDaemon(projectRoot);
      const connected = connection ? await connection.connect() : false;
      if (connected) {
        statusMsg("{gray-fg}✓{/gray-fg} Daemon reconnected");
      } else {
        statusMsg("{gray-fg}✗{/gray-fg} Failed to reconnect to daemon");
      }
    } finally {
      restartLocks.delete(projectRoot);
    }
  };
}

module.exports = {
  restartDaemonFlow,
};

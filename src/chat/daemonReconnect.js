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

  let restartInProgress = false;

  return async function restartDaemon() {
    if (restartInProgress) return;
    restartInProgress = true;
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
      restartInProgress = false;
    }
  };
}

module.exports = {
  restartDaemonFlow,
};

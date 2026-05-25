const { restartLocks } = require("./daemonTransport");
const { restartDaemonLifecycle } = require("../../runtime/daemon/restart");

function resolveDaemonConnection(daemonConnection) {
  return typeof daemonConnection === "function" ? daemonConnection() : daemonConnection;
}

function restartDaemonFlow(options = {}) {
  const {
    projectRoot,
    stopDaemon,
    startDaemon,
    isDaemonRunning,
    daemonConnection,
    logMessage,
    resolveStatusLine = null,
    sleep,
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
      const result = await restartDaemonLifecycle({
        projectRoot,
        isRunning: isDaemonRunning,
        stopDaemon,
        startDaemon,
        connect: connection ? () => connection.connect() : null,
        requestStatus: connection && typeof connection.requestStatus === "function"
          ? () => connection.requestStatus()
          : null,
        sleep,
      });
      if (result.ok) {
        statusMsg("{gray-fg}✓{/gray-fg} Daemon reconnected");
      } else if (result.error === "failed_to_stop") {
        statusMsg("{gray-fg}✗{/gray-fg} Failed to stop daemon");
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

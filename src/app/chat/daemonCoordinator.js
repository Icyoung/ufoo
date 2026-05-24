const { createDaemonConnection } = require("./daemonConnection");
const { restartDaemonFlow } = require("./daemonReconnect");

function createDaemonCoordinator(options = {}) {
  const {
    projectRoot,
    daemonTransport,
    connectClient,
    handleMessage,
    queueStatusLine,
    resolveStatusLine,
    logMessage,
    stopDaemon,
    startDaemon,
    daemonConnection,
    restartDaemon,
  } = options;

  const connectClientFn = connectClient
    || (daemonTransport && typeof daemonTransport.connectClient === "function"
      ? daemonTransport.connectClient.bind(daemonTransport)
      : null);

  if (!daemonConnection && !connectClientFn) {
    throw new Error("createDaemonCoordinator requires connectClient, daemonTransport, or daemonConnection");
  }

  const connection = daemonConnection || createDaemonConnection({
    connectClient: connectClientFn,
    handleMessage,
    queueStatusLine,
    resolveStatusLine,
    logMessage,
  });

  const restart = restartDaemon || restartDaemonFlow({
    projectRoot,
    stopDaemon,
    startDaemon,
    daemonConnection: connection,
    logMessage,
    resolveStatusLine,
  });
  let switchProjectChain = Promise.resolve();

  function switchProject(target = {}) {
    const runSwitch = async () => {
      if (!daemonTransport || typeof daemonTransport.connectClientForTarget !== "function") {
        return { ok: false, error: "project switching requires daemonTransport.connectClientForTarget" };
      }
      if (!target || !target.projectRoot || !target.sockPath) {
        return { ok: false, error: "switchProject requires projectRoot and sockPath" };
      }
      if (!connection || typeof connection.switchConnection !== "function") {
        return { ok: false, error: "daemon connection does not support switching" };
      }

      const result = await connection.switchConnection({
        connectClient: () => daemonTransport.connectClientForTarget(target),
        callRequestStatus: false,
      });
      if (!result || result.ok !== true) {
        return {
          ok: false,
          error: (result && result.error) || "switch failed",
        };
      }
      if (typeof daemonTransport.setTarget === "function") {
        daemonTransport.setTarget(target);
      }
      connection.requestStatus();
      return { ok: true, target };
    };

    const scheduled = switchProjectChain.then(runSwitch, runSwitch);
    switchProjectChain = scheduled.catch(() => {});
    return scheduled;
  }

  function isConnected() {
    if (!connection || typeof connection.getState !== "function") return false;
    const state = connection.getState();
    return Boolean(state && state.client && !state.client.destroyed);
  }

  return {
    connect: () => connection.connect(),
    requestStatus: () => connection.requestStatus(),
    send: (req) => connection.send(req),
    restart: () => restart(),
    close: () => connection.close(),
    markExit: () => connection.markExit(),
    switchProject,
    isConnected,
    getState: () => (typeof connection.getState === "function" ? connection.getState() : null),
  };
}

module.exports = {
  createDaemonCoordinator,
};

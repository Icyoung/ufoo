const { DAEMON_TRANSPORT_DEFAULTS } = require("./daemonTransportDefaults");

function createDaemonTransport(options = {}) {
  const {
    projectRoot,
    sockPath,
    isRunning = () => true,
    startDaemon = () => {},
    connectWithRetry = async () => null,
    primaryRetries = DAEMON_TRANSPORT_DEFAULTS.primaryRetries,
    secondaryRetries = DAEMON_TRANSPORT_DEFAULTS.secondaryRetries,
    retryDelayMs = DAEMON_TRANSPORT_DEFAULTS.retryDelayMs,
    restartDelayMs = DAEMON_TRANSPORT_DEFAULTS.restartDelayMs,
  } = options;

  let activeProjectRoot = projectRoot;
  let activeSockPath = sockPath;

  function resolveTarget(override = {}) {
    return {
      projectRoot: override.projectRoot || activeProjectRoot,
      sockPath: override.sockPath || activeSockPath,
    };
  }

  async function connectClientForTarget(override = {}) {
    const target = resolveTarget(override);
    let client = await connectWithRetry(target.sockPath, primaryRetries, retryDelayMs);
    if (!client) {
      // Retry once with a fresh daemon start and longer wait.
      if (!isRunning(target.projectRoot)) {
        startDaemon(target.projectRoot);
        await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
      }
      client = await connectWithRetry(target.sockPath, secondaryRetries, retryDelayMs);
    }
    return client;
  }

  async function connectClient() {
    return connectClientForTarget();
  }

  function setTarget(next = {}) {
    if (next.projectRoot) activeProjectRoot = next.projectRoot;
    if (next.sockPath) activeSockPath = next.sockPath;
    return getTarget();
  }

  function getTarget() {
    return {
      projectRoot: activeProjectRoot,
      sockPath: activeSockPath,
    };
  }

  return {
    connectClient,
    connectClientForTarget,
    setTarget,
    getTarget,
  };
}

module.exports = {
  createDaemonTransport,
};

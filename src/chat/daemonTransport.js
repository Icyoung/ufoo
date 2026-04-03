const { DAEMON_TRANSPORT_DEFAULTS } = require("./daemonTransportDefaults");

// Global restart lock per project to prevent concurrent restart flows
const restartLocks = new Map();

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
    connectTimeoutMs = DAEMON_TRANSPORT_DEFAULTS.connectTimeoutMs,
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
    let client = await connectWithRetry(
      target.sockPath,
      primaryRetries,
      retryDelayMs,
      { timeoutMs: connectTimeoutMs }
    );
    if (!client) {
      // Retry once with a fresh daemon start and longer wait.
      // Check if a restart is already in progress via the explicit restart flow.
      const isExplicitRestartInProgress = restartLocks.get(target.projectRoot);
      if (!isExplicitRestartInProgress && !isRunning(target.projectRoot)) {
        startDaemon(target.projectRoot);
        await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
      }
      client = await connectWithRetry(
        target.sockPath,
        secondaryRetries,
        retryDelayMs,
        { timeoutMs: connectTimeoutMs }
      );
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
  restartLocks,
};

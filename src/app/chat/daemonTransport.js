const { DAEMON_TRANSPORT_DEFAULTS } = require("./daemonTransportDefaults");

// Global restart lock per project to prevent concurrent restart flows
const restartLocks = new Map();

function createDaemonTransport(options = {}) {
  const {
    projectRoot,
    sockPath,
    isRunning = () => true,
    startDaemon = () => {},
    stopDaemon = null,
    connectWithRetry = async () => null,
    primaryRetries = DAEMON_TRANSPORT_DEFAULTS.primaryRetries,
    secondaryRetries = DAEMON_TRANSPORT_DEFAULTS.secondaryRetries,
    retryDelayMs = DAEMON_TRANSPORT_DEFAULTS.retryDelayMs,
    restartDelayMs = DAEMON_TRANSPORT_DEFAULTS.restartDelayMs,
    connectTimeoutMs = DAEMON_TRANSPORT_DEFAULTS.connectTimeoutMs,
    stuckRecoveryStopWaitMs = 300,
  } = options;

  let activeProjectRoot = projectRoot;
  let activeSockPath = sockPath;
  let activeDaemonRoot = options.daemonRoot || projectRoot;
  let daemonRootFollowsProject = !options.daemonRoot;

  function resolveTarget(override = {}) {
    return {
      projectRoot: override.projectRoot || activeProjectRoot,
      sockPath: override.sockPath || activeSockPath,
      daemonRoot: override.daemonRoot || activeDaemonRoot,
    };
  }

  async function connectClientForTarget(override = {}) {
    const target = resolveTarget(override);
    const autoStart = override.autoStart !== false;
    let client = await connectWithRetry(
      target.sockPath,
      primaryRetries,
      retryDelayMs,
      { timeoutMs: connectTimeoutMs }
    );
    if (!client) {
      // Retry once with a fresh daemon start (or stuck-daemon recovery if PID exists
      // but the IPC socket is unresponsive).
      const isExplicitRestartInProgress = restartLocks.get(target.daemonRoot);
      if (autoStart && !isExplicitRestartInProgress) {
        if (!isRunning(target.daemonRoot)) {
          startDaemon(target.daemonRoot);
          await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
        } else if (typeof stopDaemon === "function") {
          // PID is alive but IPC connection failed across all primary retries: recycle wedged daemon.
          restartLocks.set(target.daemonRoot, true);
          try {
            await Promise.resolve(stopDaemon(target.daemonRoot, {
              source: "daemon-transport:stuck-recovery",
            }));
            if (stuckRecoveryStopWaitMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, stuckRecoveryStopWaitMs));
            }
            startDaemon(target.daemonRoot);
            if (restartDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, restartDelayMs));
            }
          } finally {
            restartLocks.delete(target.daemonRoot);
          }
        }
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
    if (next.projectRoot) {
      activeProjectRoot = next.projectRoot;
      if (daemonRootFollowsProject && !next.daemonRoot) {
        activeDaemonRoot = next.projectRoot;
      }
    }
    if (next.sockPath) activeSockPath = next.sockPath;
    if (next.daemonRoot) {
      activeDaemonRoot = next.daemonRoot;
      daemonRootFollowsProject = false;
    }
    return getTarget();
  }

  function getTarget() {
    const target = {
      projectRoot: activeProjectRoot,
      sockPath: activeSockPath,
    };
    if (activeDaemonRoot !== activeProjectRoot) {
      target.daemonRoot = activeDaemonRoot;
    }
    return target;
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

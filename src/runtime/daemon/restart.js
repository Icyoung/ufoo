"use strict";

const DEFAULT_STOP_TIMEOUT_MS = 5000;
const DEFAULT_START_TIMEOUT_MS = 5000;
const DEFAULT_POLL_MS = 100;

function normalizePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function waitAttempts(timeoutMs, pollMs) {
  return Math.max(1, Math.ceil(timeoutMs / pollMs));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonState(isRunning, projectRoot) {
  if (typeof isRunning !== "function") return null;
  return Boolean(isRunning(projectRoot));
}

async function waitForDaemonState({
  projectRoot,
  isRunning,
  desired,
  timeoutMs,
  pollMs,
  sleep = defaultSleep,
}) {
  if (typeof isRunning !== "function") return true;
  const attempts = waitAttempts(timeoutMs, pollMs);
  for (let i = 0; i <= attempts; i += 1) {
    if (daemonState(isRunning, projectRoot) === desired) return true;
    if (i >= attempts) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
  }
  return daemonState(isRunning, projectRoot) === desired;
}

function waitForDaemonStateSync({
  projectRoot,
  isRunning,
  desired,
  timeoutMs,
  pollMs,
  sleepSync,
}) {
  if (typeof isRunning !== "function") return true;
  const attempts = waitAttempts(timeoutMs, pollMs);
  for (let i = 0; i <= attempts; i += 1) {
    if (daemonState(isRunning, projectRoot) === desired) return true;
    if (i >= attempts) break;
    if (typeof sleepSync === "function") sleepSync(pollMs);
  }
  return daemonState(isRunning, projectRoot) === desired;
}

function createResult(overrides = {}) {
  return {
    ok: false,
    stopped: false,
    started: false,
    connected: false,
    stopOk: false,
    startOk: false,
    error: null,
    ...overrides,
  };
}

async function restartDaemonLifecycle(options = {}) {
  const {
    projectRoot,
    isRunning,
    stopDaemon,
    startDaemon,
    stopOptions,
    startOptions,
    connect,
    requestStatus,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    sleep = defaultSleep,
  } = options;

  if (!projectRoot) return createResult({ error: "missing_project_root" });
  if (typeof startDaemon !== "function") return createResult({ error: "missing_start_daemon" });

  let stopOk = true;
  let stopError = null;
  if (typeof stopDaemon === "function") {
    try {
      stopOk = Boolean(stopOptions === undefined
        ? await stopDaemon(projectRoot)
        : await stopDaemon(projectRoot, stopOptions));
    } catch (err) {
      stopOk = false;
      stopError = err;
    }
  }

  const stopped = await waitForDaemonState({
    projectRoot,
    isRunning,
    desired: false,
    timeoutMs: normalizePositiveInt(stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS),
    pollMs: normalizePositiveInt(pollMs, DEFAULT_POLL_MS),
    sleep,
  });

  if (!stopped) {
    return createResult({
      stopped: false,
      stopOk,
      error: "failed_to_stop",
      stopError,
    });
  }

  let startOk = true;
  let startError = null;
  try {
    if (startOptions === undefined) {
      await startDaemon(projectRoot);
    } else {
      await startDaemon(projectRoot, startOptions);
    }
  } catch (err) {
    startOk = false;
    startError = err;
  }

  if (!startOk) {
    return createResult({
      stopped: true,
      stopOk,
      startOk: false,
      error: "failed_to_start",
      stopError,
      startError,
    });
  }

  const started = await waitForDaemonState({
    projectRoot,
    isRunning,
    desired: true,
    timeoutMs: normalizePositiveInt(startTimeoutMs, DEFAULT_START_TIMEOUT_MS),
    pollMs: normalizePositiveInt(pollMs, DEFAULT_POLL_MS),
    sleep,
  });

  let connected = started;
  let connectError = null;
  if (typeof connect === "function") {
    try {
      connected = Boolean(await connect(projectRoot));
    } catch (err) {
      connected = false;
      connectError = err;
    }
  }

  if (connected && typeof requestStatus === "function") {
    try {
      requestStatus(projectRoot);
    } catch {
      // Status refresh is best-effort after the lifecycle itself succeeds.
    }
  }

  const ok = typeof connect === "function" ? connected : started;
  return createResult({
    ok,
    stopped: true,
    started,
    connected,
    stopOk,
    startOk: true,
    error: ok ? null : (started ? "failed_to_connect" : "failed_to_start"),
    stopError,
    startError,
    connectError,
  });
}

function restartDaemonLifecycleSync(options = {}) {
  const {
    projectRoot,
    isRunning,
    stopDaemon,
    startDaemon,
    stopOptions,
    startOptions,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    sleepSync,
  } = options;

  if (!projectRoot) return createResult({ error: "missing_project_root" });
  if (typeof startDaemon !== "function") return createResult({ error: "missing_start_daemon" });

  let stopOk = true;
  let stopError = null;
  if (typeof stopDaemon === "function") {
    try {
      stopOk = Boolean(stopOptions === undefined
        ? stopDaemon(projectRoot)
        : stopDaemon(projectRoot, stopOptions));
    } catch (err) {
      stopOk = false;
      stopError = err;
    }
  }

  const stopped = waitForDaemonStateSync({
    projectRoot,
    isRunning,
    desired: false,
    timeoutMs: normalizePositiveInt(stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS),
    pollMs: normalizePositiveInt(pollMs, DEFAULT_POLL_MS),
    sleepSync,
  });

  if (!stopped) {
    return createResult({
      stopped: false,
      stopOk,
      error: "failed_to_stop",
      stopError,
    });
  }

  let startOk = true;
  let startError = null;
  try {
    if (startOptions === undefined) {
      startDaemon(projectRoot);
    } else {
      startDaemon(projectRoot, startOptions);
    }
  } catch (err) {
    startOk = false;
    startError = err;
  }

  if (!startOk) {
    return createResult({
      stopped: true,
      stopOk,
      startOk: false,
      error: "failed_to_start",
      stopError,
      startError,
    });
  }

  const started = waitForDaemonStateSync({
    projectRoot,
    isRunning,
    desired: true,
    timeoutMs: normalizePositiveInt(startTimeoutMs, DEFAULT_START_TIMEOUT_MS),
    pollMs: normalizePositiveInt(pollMs, DEFAULT_POLL_MS),
    sleepSync,
  });

  return createResult({
    ok: started,
    stopped: true,
    started,
    connected: false,
    stopOk,
    startOk: true,
    error: started ? null : "failed_to_start",
    stopError,
    startError,
  });
}

module.exports = {
  DEFAULT_STOP_TIMEOUT_MS,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  restartDaemonLifecycle,
  restartDaemonLifecycleSync,
};

"use strict";

/**
 * Headless UcodeController — task serial queue, cancel, view ports.
 *
 * Runner/tools/session stay in src/code/*; Ink/Rust hosts attach via ports.
 */

function createUcodeController({
  projectRoot = process.cwd(),
  ports = {},
} = {}) {
  const view = {
    dispatch: typeof ports.dispatch === "function" ? ports.dispatch : () => {},
    setStatus: typeof ports.setStatus === "function" ? ports.setStatus : () => {},
    appendLog: typeof ports.appendLog === "function" ? ports.appendLog : () => {},
  };

  let started = false;
  let abortController = null;
  let chain = Promise.resolve();
  let queueDepth = 0;

  function start() {
    started = true;
  }

  function stop() {
    if (abortController) {
      try {
        abortController.abort();
      } catch {
        // ignore
      }
      abortController = null;
    }
    queueDepth = 0;
    started = false;
  }

  function beginTask() {
    abortController = new AbortController();
    queueDepth = Math.max(1, queueDepth);
    return abortController;
  }

  function endTask() {
    if (queueDepth > 0) queueDepth -= 1;
    if (queueDepth === 0) abortController = null;
  }

  function cancelTask() {
    if (abortController) abortController.abort();
  }

  function isBusy() {
    return queueDepth > 0;
  }

  /**
   * Serialize async work so NL / auto-bus / resume never overlap.
   * AbortController is allocated synchronously so cancel works before the slot starts.
   */
  function runExclusive(fn) {
    const abort = new AbortController();
    queueDepth += 1;
    abortController = abort;
    const run = chain.then(async () => {
      if (!started) {
        return null;
      }
      abortController = abort;
      try {
        if (abort.signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return await fn(abort);
      } finally {
        queueDepth = Math.max(0, queueDepth - 1);
        if (abortController === abort) abortController = null;
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  return {
    projectRoot,
    view,
    isStarted: () => started,
    isBusy,
    start,
    stop,
    beginTask,
    endTask,
    cancelTask,
    runExclusive,
    getAbortSignal: () => (abortController ? abortController.signal : null),
  };
}

/**
 * Throttle thinking_delta → status.set so fast streams don't flood the UI.
 */
function createThinkingStatusPublisher(publish, options = {}) {
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 120;
  let timer = null;
  let lastFlush = 0;

  function flush() {
    timer = null;
    lastFlush = Date.now();
    publish("status.set", {
      text: "Thinking…",
      busy: true,
    });
  }

  function onThinkingDelta(chunk) {
    if (!String(chunk || "")) return;
    const elapsed = Date.now() - lastFlush;
    if (elapsed >= intervalMs) {
      flush();
      return;
    }
    if (!timer) {
      timer = setTimeout(flush, Math.max(16, intervalMs - elapsed));
      if (typeof timer.unref === "function") timer.unref();
    }
  }

  function reset() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastFlush = 0;
  }

  return { onThinkingDelta, reset, flush };
}

module.exports = {
  createUcodeController,
  createThinkingStatusPublisher,
};

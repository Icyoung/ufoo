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
  const onQueueChange = typeof ports.onQueueChange === "function"
    ? ports.onQueueChange
    : () => {};

  let started = false;
  let activeTask = null;
  let pendingTasks = [];
  let taskSeq = 0;
  let draining = false;
  let legacyAbortController = null;
  let pauseReason = "";

  function taskLabel(meta = {}, id = 0) {
    const label = String(meta.label || "").trim();
    if (label) return label;
    const kind = String(meta.kind || "task").trim();
    return `${kind} #${id}`;
  }

  function taskView(task, position = 0) {
    if (!task) return null;
    return {
      id: task.id,
      kind: task.kind,
      label: task.label,
      status: task.status,
      enqueuedAt: task.enqueuedAt,
      startedAt: task.startedAt || 0,
      position,
    };
  }

  function queueSnapshot(event = "") {
    const queued = pendingTasks.map((task, index) => taskView(task, index + 1));
    return {
      event: String(event || ""),
      busy: Boolean(activeTask || queued.length),
      activeBusy: Boolean(activeTask),
      queueDepth: (activeTask ? 1 : 0) + queued.length,
      queuedCount: queued.length,
      active: taskView(activeTask, 0),
      queued,
      cancelRequested: Boolean(activeTask && activeTask.cancelRequested),
      paused: Boolean(pauseReason),
      pausedReason: pauseReason,
    };
  }

  function notifyQueueChange(event = "") {
    try {
      onQueueChange(queueSnapshot(event));
    } catch {
      // Queue telemetry must never affect task execution.
    }
  }

  function settleCancelled(task, reason = "cancelled") {
    if (!task || task.settled) return;
    task.settled = true;
    // A task that never entered the executor has no partial work to report.
    // Resolve it as a no-op so callers do not create unhandled cancellation
    // rejections while the active task continues to drain the queue.
    task.resolve(null);
    task.status = "cancelled";
    task.cancelReason = String(reason || "cancelled");
  }

  function clearPending(reason = "cleared") {
    const cleared = pendingTasks.splice(0);
    for (const task of cleared) settleCancelled(task, reason);
    if (cleared.length > 0) notifyQueueChange("cleared");
    return cleared.length;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (started && !pauseReason && !activeTask && pendingTasks.length > 0) {
        const task = pendingTasks.shift();
        if (!task) continue;
        if (task.controller.signal.aborted) {
          settleCancelled(task, task.cancelReason || "cancelled");
          notifyQueueChange("cancelled");
          continue;
        }

        activeTask = task;
        task.status = "running";
        task.startedAt = Date.now();
        notifyQueueChange("started");
        try {
          const value = await task.fn(task.controller, task);
          if (!task.settled) {
            task.settled = true;
            task.resolve(value);
          }
        } catch (err) {
          if (!task.settled) {
            task.settled = true;
            task.reject(err);
          }
        } finally {
          activeTask = null;
          notifyQueueChange(task.controller.signal.aborted ? "cancelled" : "completed");
        }
      }
    } finally {
      draining = false;
      notifyQueueChange("idle");
    }
  }

  function start() {
    started = true;
    void drain();
    notifyQueueChange("started");
  }

  function stop() {
    started = false;
    pauseReason = "";
    if (activeTask) {
      activeTask.cancelRequested = true;
      try {
        activeTask.controller.abort();
      } catch {
        // ignore
      }
    }
    clearPending("stopped");
    if (legacyAbortController) {
      try {
        legacyAbortController.abort();
      } catch {
        // ignore
      }
      legacyAbortController = null;
    }
    notifyQueueChange("stopped");
  }

  function beginTask() {
    legacyAbortController = new AbortController();
    return legacyAbortController;
  }

  function endTask() {
    legacyAbortController = null;
  }

  function cancelTask(reason = "user") {
    if (activeTask) {
      activeTask.cancelRequested = true;
      activeTask.cancelReason = String(reason || "user");
      try {
        activeTask.controller.abort();
      } catch {
        // ignore
      }
      notifyQueueChange("cancel_requested");
      return true;
    }
    if (legacyAbortController) {
      legacyAbortController.abort();
      return true;
    }
    return false;
  }

  function isBusy() {
    return Boolean(activeTask || pendingTasks.length > 0);
  }

  function pauseQueue(reason = "paused") {
    pauseReason = String(reason || "paused");
    notifyQueueChange("paused");
  }

  function resumeQueue() {
    if (!pauseReason) return;
    pauseReason = "";
    notifyQueueChange("resumed");
    void drain();
  }

  /**
   * Serialize async work so NL / auto-bus / resume never overlap.
   * The active controller is kept separate from queued controllers so Esc
   * always targets the request that is actually executing.
   */
  function runExclusive(fn, meta = {}) {
    if (typeof fn !== "function") {
      return Promise.reject(new TypeError("exclusive task must be a function"));
    }
    const taskMeta = meta && typeof meta === "object" ? meta : {};
    const id = ++taskSeq;
    const controller = new AbortController();
    let resolveTask;
    let rejectTask;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const task = {
      id,
      kind: String(taskMeta.kind || "task").trim() || "task",
      label: taskLabel(taskMeta, id),
      enqueuedAt: Date.now(),
      startedAt: 0,
      status: "queued",
      cancelRequested: false,
      cancelReason: "",
      controller,
      fn,
      resolve: resolveTask,
      reject: rejectTask,
      settled: false,
    };
    // Expose the id without changing the promise's value contract.
    promise.taskId = id;
    if (taskMeta.priority === true) pendingTasks.unshift(task);
    else pendingTasks.push(task);
    notifyQueueChange("enqueued");
    void drain();
    return promise;
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
    clearQueue: () => clearPending("cleared"),
    pauseQueue,
    resumeQueue,
    getQueueSnapshot: () => queueSnapshot("snapshot"),
    getAbortSignal: () => (activeTask ? activeTask.controller.signal : null),
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

"use strict";

/** Bounded host scheduler. Resource keys serialize writers without blocking other work. */
function createTaskScheduler({ maxConcurrent = 2, maxQueued = 64 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || !Number.isInteger(maxQueued) || maxQueued < 1) throw new Error("invalid scheduler limits");
  const jobs = new Map();
  const resources = new Set();
  let active = 0;
  let closed = false;
  let order = 0;
  function drain() {
    if (closed) return;
    const ready = [...jobs.values()].filter((job) => job.status === "queued").sort((a, b) => b.priority - a.priority || a.order - b.order);
    for (const job of ready) {
      if (active >= maxConcurrent) return;
      if (job.resourceKey && resources.has(job.resourceKey)) continue;
      active += 1;
      if (job.resourceKey) resources.add(job.resourceKey);
      job.status = "running";
      Promise.resolve().then(() => job.work(job.controller.signal)).then(job.resolve, job.reject).finally(() => {
        active -= 1;
        if (job.resourceKey) resources.delete(job.resourceKey);
        jobs.delete(job.id);
        if (job.externalSignal) job.externalSignal.removeEventListener("abort", job.abort);
        drain();
      });
    }
  }
  return Object.freeze({
    schedule({ id, resourceKey = "", signal = null, priority = 0 }, work) {
      if (closed) return Promise.reject(new Error("scheduler closed"));
      if (!id || typeof work !== "function") return Promise.reject(new Error("scheduler requires id and work"));
      if (jobs.has(id)) return jobs.get(id).promise;
      if ([...jobs.values()].filter((job) => job.status === "queued").length >= maxQueued) return Promise.reject(Object.assign(new Error("scheduler queue is full"), { code: "queue_full" }));
      const controller = new AbortController();
      const job = { id, resourceKey, priority, work, controller, order: order++, status: "queued", externalSignal: signal };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      job.abort = () => {
        controller.abort(signal && signal.reason);
        if (job.status === "queued") {
          jobs.delete(id);
          job.reject(Object.assign(new Error("task cancelled before scheduling"), { code: "cancelled" }));
          if (signal) signal.removeEventListener("abort", job.abort);
          drain();
        }
      };
      jobs.set(id, job);
      if (signal) {
        if (signal.aborted) job.abort();
        else signal.addEventListener("abort", job.abort, { once: true });
      }
      drain();
      return job.promise;
    },
    snapshot: () => ({ closed, active, queued: [...jobs.values()].filter((job) => job.status === "queued").length,
      jobs: [...jobs.values()].map(({ id, resourceKey, status }) => ({ id, resourceKey, status })) }),
    async close() {
      closed = true;
      const pending = [...jobs.values()];
      for (const job of pending) {
        job.controller.abort("scheduler_closed");
        if (job.status === "queued") {
          jobs.delete(job.id);
          job.reject(Object.assign(new Error("scheduler closed"), { code: "cancelled" }));
          if (job.externalSignal) job.externalSignal.removeEventListener("abort", job.abort);
        }
      }
      await Promise.allSettled(pending.map((job) => job.promise));
    },
  });
}

module.exports = { createTaskScheduler };

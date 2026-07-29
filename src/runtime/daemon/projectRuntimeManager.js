"use strict";

const {
  canonicalProjectRoot,
} = require("../projects");
const { createProjectContext } = require("./projectContext");
const {
  createProjectRuntime,
  RUNTIME_STATES,
} = require("./projectRuntime");

const DEFAULT_IDLE_GRACE_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;

class ProjectRuntimeManager {
  constructor(options = {}) {
    this.contextFactory = options.contextFactory || createProjectContext;
    this.runtimeFactory = options.runtimeFactory || createProjectRuntime;
    this.configureRuntime = typeof options.configureRuntime === "function"
      ? options.configureRuntime
      : null;
    this.authorizeProjectRoot = typeof options.authorizeProjectRoot === "function"
      ? options.authorizeProjectRoot
      : (() => true);
    this.idleGraceMs = Number.isFinite(options.idleGraceMs)
      ? Math.max(0, Number(options.idleGraceMs))
      : DEFAULT_IDLE_GRACE_MS;
    this.maxActiveRuntimes = Number.isFinite(options.maxActiveRuntimes)
      ? Math.max(1, Number(options.maxActiveRuntimes))
      : 32;
    this.maxConcurrentRequests = Number.isFinite(options.maxConcurrentRequests)
      ? Math.max(1, Number(options.maxConcurrentRequests))
      : 256;
    this.now = typeof options.now === "function" ? options.now : Date.now;
    this.runtimes = new Map();
    this.activationPromises = new Map();
    this.activeRequestCount = 0;
    this.disposed = false;
    const sweepIntervalMs = Number.isFinite(options.sweepIntervalMs)
      ? Math.max(0, Number(options.sweepIntervalMs))
      : DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = sweepIntervalMs > 0
      ? setInterval(() => {
        void this.sweepIdle();
      }, sweepIntervalMs)
      : null;
    if (this.sweepTimer && typeof this.sweepTimer.unref === "function") {
      this.sweepTimer.unref();
    }
  }

  resolveProject(projectRoot, options = {}) {
    const canonicalRoot = canonicalProjectRoot(projectRoot);
    if (this.authorizeProjectRoot(canonicalRoot, options) !== true) {
      const err = new Error(`project runtime access denied: ${canonicalRoot}`);
      err.code = "PROJECT_RUNTIME_ACCESS_DENIED";
      throw err;
    }
    return canonicalRoot;
  }

  createEntry(projectRoot, options = {}) {
    const previousGeneration = Number(options.previousGeneration) || 0;
    const context = this.contextFactory({
      ...options,
      projectRoot,
      runtimeGeneration: previousGeneration + 1,
    });
    const runtime = this.runtimeFactory(context, options.runtimeOptions || {});
    if (this.configureRuntime) this.configureRuntime(runtime, context);
    const entry = {
      context,
      runtime,
      lastUsedAtMs: this.now(),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.runtimes.set(context.projectId, entry);
    return entry;
  }

  entryForRoot(projectRoot) {
    const canonicalRoot = canonicalProjectRoot(projectRoot);
    for (const entry of this.runtimes.values()) {
      if (entry.context.projectRoot === canonicalRoot) return entry;
    }
    return null;
  }

  activeRuntimeCount() {
    let count = 0;
    for (const entry of this.runtimes.values()) {
      if (entry.runtime.state === RUNTIME_STATES.ACTIVE) count += 1;
    }
    return count;
  }

  async activate(projectRoot, options = {}) {
    if (this.disposed) {
      const err = new Error("project runtime manager is disposed");
      err.code = "PROJECT_RUNTIME_MANAGER_DISPOSED";
      throw err;
    }
    const canonicalRoot = this.resolveProject(projectRoot, options);
    let entry = this.entryForRoot(canonicalRoot);
    if (entry && entry.runtime.state === RUNTIME_STATES.ACTIVE) {
      entry.lastUsedAtMs = this.now();
      return entry.runtime;
    }
    const projectId = entry
      ? entry.context.projectId
      : this.contextFactory({
        ...options,
        projectRoot: canonicalRoot,
        runtimeGeneration: 1,
      }).projectId;
    if (this.activationPromises.has(projectId)) {
      return this.activationPromises.get(projectId);
    }
    const activation = (async () => {
      if (!entry) {
        entry = this.createEntry(canonicalRoot, options);
      } else if (
        entry.runtime.state === RUNTIME_STATES.FAILED
        || entry.runtime.state === RUNTIME_STATES.DISPOSED
      ) {
        entry = await this.recycle(canonicalRoot, options);
      }
      if (
        entry.runtime.state !== RUNTIME_STATES.ACTIVE
        && this.activeRuntimeCount() >= this.maxActiveRuntimes
      ) {
        await this.sweepIdle({ forcePressure: true });
      }
      if (
        entry.runtime.state !== RUNTIME_STATES.ACTIVE
        && this.activeRuntimeCount() >= this.maxActiveRuntimes
      ) {
        const err = new Error(
          `active project runtime limit reached (${this.maxActiveRuntimes})`
        );
        err.code = "PROJECT_RUNTIME_LIMIT";
        throw err;
      }
      await entry.runtime.activate();
      entry.lastUsedAtMs = this.now();
      return entry.runtime;
    })();
    this.activationPromises.set(projectId, activation);
    try {
      return await activation;
    } finally {
      this.activationPromises.delete(projectId);
    }
  }

  async call(projectRoot, operation, args = {}, requestContext = {}) {
    if (this.activeRequestCount >= this.maxConcurrentRequests) {
      const err = new Error(
        `global project runtime request limit reached (${this.maxConcurrentRequests})`
      );
      err.code = "PROJECT_RUNTIME_REQUEST_LIMIT";
      throw err;
    }
    const runtime = await this.activate(projectRoot, requestContext);
    const entry = this.runtimes.get(runtime.context.projectId);
    this.activeRequestCount += 1;
    if (entry) entry.lastUsedAtMs = this.now();
    try {
      return await runtime.call(operation, args, requestContext);
    } finally {
      this.activeRequestCount -= 1;
      if (entry) entry.lastUsedAtMs = this.now();
    }
  }

  cancel(projectRoot, requestId) {
    const entry = this.entryForRoot(projectRoot);
    return entry ? entry.runtime.cancel(requestId) : false;
  }

  async suspend(projectRoot) {
    const entry = this.entryForRoot(projectRoot);
    if (!entry) return false;
    if (entry.runtime.state === RUNTIME_STATES.DORMANT) return true;
    await entry.runtime.suspend();
    return true;
  }

  async recycle(projectRoot, options = {}) {
    const canonicalRoot = this.resolveProject(projectRoot, options);
    const existing = this.entryForRoot(canonicalRoot);
    const generation = existing ? existing.context.runtimeGeneration : 0;
    if (existing) {
      existing.runtime.dispose();
      this.runtimes.delete(existing.context.projectId);
    }
    return this.createEntry(canonicalRoot, {
      ...options,
      previousGeneration: generation,
    });
  }

  remove(projectRoot) {
    const entry = this.entryForRoot(projectRoot);
    if (!entry) return false;
    entry.runtime.dispose();
    this.runtimes.delete(entry.context.projectId);
    this.activationPromises.delete(entry.context.projectId);
    return true;
  }

  async sweepIdle(options = {}) {
    const nowMs = this.now();
    const candidates = Array.from(this.runtimes.values())
      .filter((entry) => entry.runtime.state === RUNTIME_STATES.ACTIVE)
      .sort((a, b) => a.lastUsedAtMs - b.lastUsedAtMs);
    let suspended = 0;
    for (const entry of candidates) {
      const idleForMs = nowMs - entry.lastUsedAtMs;
      const underPressure = options.forcePressure === true
        && this.activeRuntimeCount() >= this.maxActiveRuntimes;
      if (!underPressure && idleForMs < this.idleGraceMs) continue;
      if (!entry.runtime.canSuspend()) continue;
      try {
        await entry.runtime.suspend();
        suspended += 1;
      } catch {
        // A busy/failing runtime is reported by its own status and skipped.
      }
    }
    return suspended;
  }

  status() {
    return {
      disposed: this.disposed,
      runtime_count: this.runtimes.size,
      active_runtime_count: this.activeRuntimeCount(),
      active_request_count: this.activeRequestCount,
      max_active_runtimes: this.maxActiveRuntimes,
      max_concurrent_requests: this.maxConcurrentRequests,
      runtimes: Array.from(this.runtimes.values())
        .map((entry) => ({
          ...entry.runtime.status(),
          manager_last_used_at: new Date(entry.lastUsedAtMs).toISOString(),
        }))
        .sort((a, b) => a.project_root.localeCompare(b.project_root)),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const entry of this.runtimes.values()) {
      entry.runtime.dispose();
    }
    this.runtimes.clear();
    this.activationPromises.clear();
  }
}

module.exports = {
  DEFAULT_IDLE_GRACE_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  ProjectRuntimeManager,
};

"use strict";

const { randomUUID } = require("crypto");

const RUNTIME_STATES = Object.freeze({
  REGISTERED: "registered",
  DORMANT: "dormant",
  ACTIVATING: "activating",
  ACTIVE: "active",
  DRAINING: "draining",
  FAILED: "failed",
  DISPOSED: "disposed",
});

class ProjectRuntime {
  constructor(context, options = {}) {
    if (!context || !context.projectId || !context.projectRoot) {
      throw new Error("ProjectRuntime requires an immutable ProjectContext");
    }
    this.context = context;
    this.state = RUNTIME_STATES.REGISTERED;
    this.operations = new Map();
    this.resources = new Map();
    this.activeRequests = new Map();
    this.lastError = null;
    this.lastActiveAt = null;
    this.onActivate = typeof options.onActivate === "function" ? options.onActivate : null;
    this.onSuspend = typeof options.onSuspend === "function" ? options.onSuspend : null;
    this.onRecover = typeof options.onRecover === "function" ? options.onRecover : null;
    this.canSuspendHook = typeof options.canSuspend === "function" ? options.canSuspend : null;
    this.onDispose = typeof options.onDispose === "function" ? options.onDispose : null;
  }

  registerOperation(name, handler) {
    const operation = String(name || "").trim();
    if (!operation || typeof handler !== "function") {
      throw new Error("registerOperation requires a name and handler");
    }
    this.operations.set(operation, handler);
    return this;
  }

  own(name, resource) {
    const key = String(name || "").trim();
    if (!key) throw new Error("runtime resource name is required");
    if (this.resources.has(key)) {
      throw new Error(`runtime resource already exists: ${key}`);
    }
    this.resources.set(key, resource);
    return resource;
  }

  resource(name) {
    return this.resources.get(name);
  }

  async activate() {
    if (this.state === RUNTIME_STATES.ACTIVE) return this;
    if (this.state === RUNTIME_STATES.DISPOSED) {
      throw new Error("disposed runtime cannot be activated");
    }
    this.state = RUNTIME_STATES.ACTIVATING;
    try {
      if (this.onActivate) await this.onActivate(this);
      this.state = RUNTIME_STATES.ACTIVE;
      this.lastActiveAt = new Date().toISOString();
      this.lastError = null;
      return this;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  async call(operation, args = {}, requestContext = {}) {
    if (this.state !== RUNTIME_STATES.ACTIVE) {
      const err = new Error(
        `project runtime ${this.context.projectId} is not active (${this.state})`
      );
      err.code = "PROJECT_RUNTIME_NOT_ACTIVE";
      throw err;
    }
    const handler = this.operations.get(String(operation || ""));
    if (!handler) {
      const err = new Error(`unknown project runtime operation: ${operation || ""}`);
      err.code = "PROJECT_RUNTIME_UNKNOWN_OPERATION";
      throw err;
    }
    const requestId = String(requestContext.requestId || randomUUID());
    if (this.activeRequests.has(requestId)) {
      const err = new Error(`duplicate project runtime request: ${requestId}`);
      err.code = "PROJECT_RUNTIME_DUPLICATE_REQUEST";
      throw err;
    }
    const controller = new AbortController();
    const externalSignal = requestContext.signal;
    const abortFromExternal = () => controller.abort(externalSignal.reason);
    if (externalSignal) {
      if (externalSignal.aborted) abortFromExternal();
      else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
    this.activeRequests.set(requestId, controller);
    this.lastActiveAt = new Date().toISOString();
    try {
      return await handler(args, {
        context: this.context,
        requestContext: {
          ...requestContext,
          requestId,
        },
        runtime: this,
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.runtimeFatal === true) this.fail(err);
      throw err;
    } finally {
      this.activeRequests.delete(requestId);
      if (externalSignal) externalSignal.removeEventListener("abort", abortFromExternal);
    }
  }

  cancel(requestId, reason = "project runtime request cancelled") {
    const controller = this.activeRequests.get(String(requestId || ""));
    if (!controller) return false;
    controller.abort(new Error(reason));
    return true;
  }

  fail(err) {
    this.lastError = {
      code: err && err.code ? String(err.code) : "PROJECT_RUNTIME_FAILED",
      message: err && err.message ? err.message : String(err || "runtime failed"),
      at: new Date().toISOString(),
    };
    this.state = RUNTIME_STATES.FAILED;
  }

  canSuspend() {
    if (this.state !== RUNTIME_STATES.ACTIVE || this.activeRequests.size > 0) return false;
    if (this.canSuspendHook) return this.canSuspendHook(this) === true;
    return true;
  }

  async suspend() {
    if (!this.canSuspend()) {
      const err = new Error(`project runtime ${this.context.projectId} cannot suspend`);
      err.code = "PROJECT_RUNTIME_BUSY";
      throw err;
    }
    this.state = RUNTIME_STATES.DRAINING;
    try {
      if (this.onSuspend) await this.onSuspend(this);
      this.state = RUNTIME_STATES.DORMANT;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  async recover() {
    if (this.state !== RUNTIME_STATES.FAILED) return this;
    this.state = RUNTIME_STATES.ACTIVATING;
    try {
      if (this.onRecover) await this.onRecover(this);
      this.state = RUNTIME_STATES.ACTIVE;
      this.lastActiveAt = new Date().toISOString();
      this.lastError = null;
      return this;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  dispose() {
    if (this.state === RUNTIME_STATES.DISPOSED) return;
    this.state = RUNTIME_STATES.DRAINING;
    for (const controller of this.activeRequests.values()) {
      controller.abort(new Error("project runtime disposed"));
    }
    this.activeRequests.clear();
    if (this.onDispose) {
      try {
        this.onDispose(this);
      } catch (err) {
        this.lastError = {
          code: err && err.code ? String(err.code) : "PROJECT_RUNTIME_DISPOSE_FAILED",
          message: err && err.message ? err.message : String(err || "runtime dispose failed"),
          at: new Date().toISOString(),
        };
      }
    }
    this.state = RUNTIME_STATES.DISPOSED;
  }

  status() {
    return {
      project_id: this.context.projectId,
      project_root: this.context.projectRoot,
      project_name: this.context.projectName,
      topology: this.context.daemonTopology,
      generation: this.context.runtimeGeneration,
      state: this.state,
      active_request_count: this.activeRequests.size,
      resource_count: this.resources.size,
      last_active_at: this.lastActiveAt,
      last_error: this.lastError,
    };
  }
}

function createProjectRuntime(context, options = {}) {
  return new ProjectRuntime(context, options);
}

module.exports = {
  ProjectRuntime,
  RUNTIME_STATES,
  createProjectRuntime,
};

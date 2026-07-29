"use strict";

class DaemonProcessLifecycle {
  constructor(processRef = process) {
    this.processRef = processRef;
    this.registrations = new Map();
    this.installed = false;
    this.shuttingDown = false;
    this.boundHandlers = null;
  }

  register(id, hooks = {}) {
    const key = String(id || "").trim();
    if (!key) throw new Error("daemon process lifecycle registration id is required");
    if (this.registrations.has(key)) {
      throw new Error(`daemon process lifecycle already registered: ${key}`);
    }
    this.registrations.set(key, hooks);
    this.install();
    return () => {
      this.registrations.delete(key);
    };
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    const beforeExit = (code) => {
      this.notify("onBeforeExit", code);
    };
    const exit = (code) => {
      this.shutdown(`exit code=${code}`, { sync: true, notify: "onExit", value: code });
    };
    const sigterm = () => {
      this.shutdown("SIGTERM", { sync: true, notify: "onSignal", value: "SIGTERM" });
      this.processRef.exit(0);
    };
    const sigint = () => {
      this.shutdown("SIGINT", { sync: true, notify: "onSignal", value: "SIGINT" });
      this.processRef.exit(0);
    };
    const uncaughtException = (err) => {
      this.shutdown("uncaughtException", {
        sync: true,
        notify: "onFatal",
        value: { kind: "uncaughtException", error: err },
      });
      this.processRef.exit(1);
    };
    const unhandledRejection = (reason) => {
      this.shutdown("unhandledRejection", {
        sync: true,
        notify: "onFatal",
        value: { kind: "unhandledRejection", error: reason },
      });
      this.processRef.exit(1);
    };
    this.boundHandlers = {
      beforeExit,
      exit,
      SIGTERM: sigterm,
      SIGINT: sigint,
      uncaughtException,
      unhandledRejection,
    };
    for (const [event, handler] of Object.entries(this.boundHandlers)) {
      this.processRef.on(event, handler);
    }
  }

  notify(method, value) {
    for (const hooks of Array.from(this.registrations.values())) {
      const handler = hooks && hooks[method];
      if (typeof handler !== "function") continue;
      try {
        handler(value);
      } catch {
        // A lifecycle observer cannot prevent other runtimes from cleaning up.
      }
    }
  }

  shutdown(reason, options = {}) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const registrations = Array.from(this.registrations.values());
    for (const hooks of registrations) {
      try {
        const notify = options.notify && hooks && hooks[options.notify];
        if (typeof notify === "function") notify(options.value);
      } catch {
        // Fatal diagnostics for one runtime must not block cleanup of another.
      }
      try {
        if (hooks && typeof hooks.cleanup === "function") {
          hooks.cleanup(reason, { sync: options.sync === true });
        }
      } catch {
        // Continue draining every registered runtime.
      }
    }
  }

  disposeForTests() {
    if (this.boundHandlers && typeof this.processRef.removeListener === "function") {
      for (const [event, handler] of Object.entries(this.boundHandlers)) {
        this.processRef.removeListener(event, handler);
      }
    }
    this.boundHandlers = null;
    this.registrations.clear();
    this.installed = false;
    this.shuttingDown = false;
  }
}

const defaultDaemonProcessLifecycle = new DaemonProcessLifecycle(process);

function registerDaemonRuntimeLifecycle(id, hooks = {}) {
  return defaultDaemonProcessLifecycle.register(id, hooks);
}

module.exports = {
  DaemonProcessLifecycle,
  defaultDaemonProcessLifecycle,
  registerDaemonRuntimeLifecycle,
};

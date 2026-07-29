"use strict";

const { randomUUID } = require("crypto");
const fs = require("fs");

const {
  defaultAgentModelForProvider,
  loadConfig,
  normalizeDaemonTopology,
} = require("../../config");
const { getUfooPaths } = require("../../coordination/state/paths");
const {
  loadAgentsData,
  saveAgentsData,
} = require("../../coordination/state/agentsStore");
const {
  canonicalProjectRoot,
  markProjectStopped,
  resolveGlobalControllerProjectRoot,
} = require("../projects");
const { startDaemon } = require("./index");
const { createProjectRuntime } = require("./projectRuntime");
const { ProjectRuntimeManager } = require("./projectRuntimeManager");
const {
  CONTROL_PLANE_OPERATIONS,
  MCP_EXPOSED_SHARED_TOOLS,
  executeProjectRuntimeOperation,
} = require("./projectRuntimeGateway");

class GlobalDaemon {
  constructor(options = {}) {
    this.controllerRoot = canonicalProjectRoot(
      options.controllerRoot || resolveGlobalControllerProjectRoot()
    );
    this.topology = normalizeDaemonTopology(options.topology || "global");
    this.startProjectRuntime = options.startProjectRuntime || startDaemon;
    this.loadProjectConfig = options.loadProjectConfig || loadConfig;
    this.authorizeProjectRoot = typeof options.authorizeProjectRoot === "function"
      ? options.authorizeProjectRoot
      : (projectRoot) => fs.existsSync(getUfooPaths(projectRoot).ufooDir);
    this.controller = null;
    this.runtimeManager = options.runtimeManager || new ProjectRuntimeManager({
      authorizeProjectRoot: this.authorizeProjectRoot,
      idleGraceMs: options.idleGraceMs,
      sweepIntervalMs: options.sweepIntervalMs,
      maxActiveRuntimes: options.maxActiveRuntimes,
      maxConcurrentRequests: options.maxConcurrentRequests,
      runtimeFactory: (context) => this.createHostedRuntime(context),
    });
    this.activeGatewayRequests = new Map();
    this.projectRuntimeGateway = {
      call: (projectRoot, operation, args, context) =>
        this.callProjectOperation(projectRoot, operation, args, context),
      cancel: (requestId) => {
        const id = String(requestId || "");
        const projectRoot = this.activeGatewayRequests.get(id);
        return projectRoot ? this.runtimeManager.cancel(projectRoot, id) : false;
      },
      status: () => this.runtimeManager.status(),
      // GlobalDaemon owns the shared manager; MCP listener restart/cleanup
      // must not independently dispose project runtimes.
      dispose: () => {},
    };
    this.disposed = false;
    this.startedAt = "";
  }

  createHostedRuntime(context) {
    let hostHandle = null;
    const cleanupHost = (reason) => {
      const current = hostHandle;
      hostHandle = null;
      runtime.hostHandle = null;
      if (current && typeof current.cleanup === "function") current.cleanup(reason);
    };
    const runtime = createProjectRuntime(context, {
      onActivate: () => {
        hostHandle = this.startProjectRuntime({
          projectRoot: context.projectRoot,
          provider: context.provider,
          model: context.model,
          resumeMode: "none",
          daemonTopology: this.topology,
          runtimeGeneration: context.runtimeGeneration,
          globalRuntimeRouter: this,
          manageProcessState: false,
          listenProjectSocket: this.topology !== "global",
          registrySocketPath: getUfooPaths(this.controllerRoot).ufooSock,
        });
        runtime.hostHandle = hostHandle;
      },
      canSuspend: () => this.canSuspendHostedRuntime(hostHandle),
      onSuspend: () => cleanupHost("global-runtime-idle"),
      onDispose: () => cleanupHost("global-runtime-dispose"),
    });
    runtime.hostHandle = null;
    runtime.registerOperation("ipc_request", (_args, callContext) => {
      if (!hostHandle || typeof hostHandle.handleRequest !== "function") {
        const err = new Error(`project runtime is unavailable: ${context.projectRoot}`);
        err.code = "PROJECT_RUNTIME_UNAVAILABLE";
        throw err;
      }
      return hostHandle.handleRequest(
        callContext.requestContext.request,
        callContext.requestContext.socket
      );
    });
    for (const operation of [
      ...CONTROL_PLANE_OPERATIONS,
      ...MCP_EXPOSED_SHARED_TOOLS.filter((name) => name !== "read_project_registry"),
    ]) {
      runtime.registerOperation(operation, (args, callContext) =>
        executeProjectRuntimeOperation(
          context.projectRoot,
          operation,
          args,
          {
            ...callContext.requestContext,
            signal: callContext.signal,
          }
        ));
    }
    return runtime;
  }

  canSuspendHostedRuntime(hostHandle) {
    if (!hostHandle) return true;
    const ipcServer = hostHandle.runtime && hostHandle.runtime.resource("ipcServer");
    if (ipcServer && typeof ipcServer.hasClients === "function" && ipcServer.hasClients()) {
      return false;
    }
    const cronController = hostHandle.runtime && hostHandle.runtime.resource("cronController");
    if (
      cronController
      && typeof cronController.listTasks === "function"
      && cronController.listTasks().length > 0
    ) {
      return false;
    }
    const status = typeof hostHandle.status === "function" ? hostHandle.status() : null;
    return !status || !Array.isArray(status.active) || status.active.length === 0;
  }

  resolveProjectRoot(projectRoot) {
    const canonicalRoot = canonicalProjectRoot(projectRoot);
    if (canonicalRoot === this.controllerRoot) return canonicalRoot;
    if (this.authorizeProjectRoot(canonicalRoot) !== true) {
      const err = new Error(`project runtime access denied: ${canonicalRoot}`);
      err.code = "PROJECT_RUNTIME_ACCESS_DENIED";
      throw err;
    }
    return canonicalRoot;
  }

  async activateProject(projectRoot) {
    if (this.disposed) {
      const err = new Error("global daemon is disposed");
      err.code = "GLOBAL_DAEMON_DISPOSED";
      throw err;
    }
    const canonicalRoot = this.resolveProjectRoot(projectRoot);
    if (canonicalRoot === this.controllerRoot) return this.controller;
    const config = this.loadProjectConfig(canonicalRoot);
    const provider = config.agentProvider || "codex-cli";
    const model = config.agentModel || defaultAgentModelForProvider(provider);
    const runtime = await this.runtimeManager.activate(canonicalRoot, {
      config: {
        ...config,
        daemonTopology: this.topology,
      },
      provider,
      model,
      daemonTopology: this.topology,
    });
    return runtime.hostHandle;
  }

  async handleRequest(projectRoot, request, socket) {
    const canonicalRoot = this.resolveProjectRoot(projectRoot);
    const config = this.loadProjectConfig(canonicalRoot);
    const provider = config.agentProvider || "codex-cli";
    const model = config.agentModel || defaultAgentModelForProvider(provider);
    return this.runtimeManager.call(canonicalRoot, "ipc_request", {}, {
      request,
      socket,
      config: {
        ...config,
        daemonTopology: this.topology,
      },
      provider,
      model,
      daemonTopology: this.topology,
    });
  }

  async callProjectOperation(projectRoot, operation, args = {}, context = {}) {
    const canonicalRoot = this.resolveProjectRoot(projectRoot);
    const config = this.loadProjectConfig(canonicalRoot);
    const provider = config.agentProvider || "codex-cli";
    const model = config.agentModel || defaultAgentModelForProvider(provider);
    const requestId = String(context.requestId || context.toolCallId || randomUUID());
    this.activeGatewayRequests.set(requestId, canonicalRoot);
    try {
      return await this.runtimeManager.call(canonicalRoot, operation, args, {
        ...context,
        requestId,
        config: {
          ...config,
          daemonTopology: this.topology,
        },
        provider,
        model,
        daemonTopology: this.topology,
      });
    } finally {
      this.activeGatewayRequests.delete(requestId);
    }
  }

  async request(projectRoot, request, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || 12000;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const socket = {
        destroyed: false,
        write: (data) => {
          for (const line of String(data || "").split(/\r?\n/)) {
            if (!line.trim()) continue;
            let payload;
            try {
              payload = JSON.parse(line);
            } catch {
              continue;
            }
            if (payload.type === "response") {
              finish({
                ok: true,
                payload: payload.data || {},
                opsResults: payload.opsResults || [],
              });
              return true;
            }
            if (payload.type === "error") {
              finish({
                ok: false,
                error: payload.error || "project runtime error",
              });
              return true;
            }
          }
          return true;
        },
      };
      const timer = setTimeout(() => {
        socket.destroyed = true;
        finish({ ok: false, error: "Project runtime request timeout" });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.handleRequest(projectRoot, request, socket).catch((err) => {
        finish({
          ok: false,
          error: err && err.message ? err.message : String(err || "project runtime error"),
        });
      });
    });
  }

  closeProject(projectRoot, options = {}) {
    const canonicalRoot = this.resolveProjectRoot(projectRoot);
    if (canonicalRoot === this.controllerRoot) {
      const err = new Error("global controller runtime cannot be closed as a project");
      err.code = "GLOBAL_CONTROLLER_CLOSE_DENIED";
      throw err;
    }
    const entry = this.runtimeManager.entryForRoot(canonicalRoot);
    const terminated = [];
    if (options.terminateAgents === true) {
      const processManager = entry
        && entry.runtime.hostHandle
        && entry.runtime.hostHandle.runtime
        && entry.runtime.hostHandle.runtime.resource("processManager");
      if (processManager) processManager.cleanup({ terminate: true });

      const paths = getUfooPaths(canonicalRoot);
      const data = loadAgentsData(paths.agentsFile);
      for (const [subscriber, meta] of Object.entries(data.agents || {})) {
        const pid = Number.parseInt(meta && meta.pid, 10);
        const isController =
          subscriber === "ufoo-agent"
          || String((meta && meta.agent_type) || "") === "ufoo-agent";
        if (
          !isController
          && Number.isFinite(pid)
          && pid > 0
          && pid !== process.pid
        ) {
          try {
            process.kill(pid, "SIGTERM");
            terminated.push(subscriber);
          } catch {
            // Already-exited workloads are still marked inactive below.
          }
        }
        if (meta && meta.status === "active") {
          meta.status = "inactive";
          meta.last_seen = new Date().toISOString();
        }
      }
      saveAgentsData(paths.agentsFile, data);
    }
    const removed = this.runtimeManager.remove(canonicalRoot);
    markProjectStopped(canonicalRoot);
    return {
      ok: true,
      project_root: canonicalRoot,
      runtime_removed: removed,
      terminated_agents: terminated,
    };
  }

  start(options = {}) {
    if (this.controller) return this;
    if (this.disposed) {
      const err = new Error("disposed global daemon cannot be started");
      err.code = "GLOBAL_DAEMON_DISPOSED";
      throw err;
    }
    const config = this.loadProjectConfig(this.controllerRoot);
    const provider = options.provider || config.agentProvider || "codex-cli";
    const model =
      options.model
      || config.agentModel
      || defaultAgentModelForProvider(provider);
    this.controller = this.startProjectRuntime({
      projectRoot: this.controllerRoot,
      provider,
      model,
      resumeMode: options.resumeMode || "none",
      daemonTopology: this.topology,
      globalRuntimeRouter: this,
      beforeCleanup: () => this.disposeProjectRuntimes("global-controller-cleanup"),
    });
    this.startedAt = new Date().toISOString();
    return this;
  }

  disposeProjectRuntimes(reason = "global-daemon-stop") {
    void reason;
    this.activeGatewayRequests.clear();
    this.runtimeManager.dispose();
  }

  stop(reason = "global-daemon-stop") {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeProjectRuntimes(reason);
    const controller = this.controller;
    this.controller = null;
    if (controller && typeof controller.cleanup === "function") {
      controller.cleanup(reason);
    }
  }

  status() {
    const manager = this.runtimeManager.status();
    return {
      topology: this.topology,
      pid: process.pid,
      controller_root: this.controllerRoot,
      started_at: this.startedAt || null,
      runtime_count: manager.runtime_count,
      active_runtime_count: manager.active_runtime_count,
      active_request_count: manager.active_request_count,
      activating_runtime_count: this.runtimeManager.activationPromises.size,
      runtimes: manager.runtimes,
    };
  }
}

function startGlobalDaemon(options = {}) {
  const daemon = new GlobalDaemon(options);
  return daemon.start(options);
}

module.exports = {
  GlobalDaemon,
  startGlobalDaemon,
};

"use strict";

const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

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
  isGlobalControllerProjectRoot,
  listProjectRuntimes,
  markProjectStopped,
  resolveGlobalControllerProjectRoot,
} = require("../projects");
const { isAgentPidAlive } = require("../../coordination/bus/utils");
const { startDaemon } = require("./index");
const { createProjectRuntime } = require("./projectRuntime");
const { ProjectRuntimeManager } = require("./projectRuntimeManager");
const {
  CONTROL_PLANE_OPERATIONS,
  MCP_EXPOSED_SHARED_TOOLS,
  executeProjectRuntimeOperation,
} = require("./projectRuntimeGateway");

const MAX_REHYDRATION_SKIP_SAMPLES = 25;

function isSocketFile(filePath = "") {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isSocket();
  } catch {
    return false;
  }
}

function hasPersistedCronTasks(projectRoot) {
  const cronFile = path.join(getUfooPaths(projectRoot).runDir, "cron.tasks.json");
  try {
    const state = JSON.parse(fs.readFileSync(cronFile, "utf8"));
    return Array.isArray(state.tasks) && state.tasks.length > 0;
  } catch {
    return false;
  }
}

function projectRuntimeRecoveryReasons(projectRoot, options = {}) {
  const paths = getUfooPaths(projectRoot);
  if (!fs.existsSync(paths.ufooDir)) return [];
  const loadAgents = options.loadAgentsData || loadAgentsData;
  const agentPidIsAlive = options.isAgentPidAlive || isAgentPidAlive;
  const socketIsLive = options.isSocketFile || isSocketFile;
  const reasons = [];
  const data = fs.existsSync(paths.agentsFile)
    ? loadAgents(paths.agentsFile)
    : { agents: {} };
  const hasLiveHostAgent = Object.entries(data.agents || {}).some(([subscriber, meta]) => {
    if (!meta || meta.status !== "active" || meta.mcp_bridge === true) return false;
    if (subscriber === "ufoo-agent" || meta.agent_type === "ufoo-agent") return false;
    const pid = Number.parseInt(meta.pid, 10);
    return agentPidIsAlive(pid) || socketIsLive(meta.host_inject_sock);
  });
  if (hasLiveHostAgent) reasons.push("live_host_agent");
  const hasCronTasks = typeof options.hasPersistedCronTasks === "function"
    ? options.hasPersistedCronTasks(projectRoot)
    : hasPersistedCronTasks(projectRoot);
  if (hasCronTasks) reasons.push("scheduled_task");
  return reasons;
}

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
    this.listProjectRuntimes = options.listProjectRuntimes || listProjectRuntimes;
    this.projectRuntimeRecoveryReasons = options.projectRuntimeRecoveryReasons
      || ((projectRoot) => projectRuntimeRecoveryReasons(projectRoot));
    this.rehydrateProjects = options.rehydrateProjects === undefined
      ? isGlobalControllerProjectRoot(this.controllerRoot)
      : options.rehydrateProjects === true;
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
    this.clientProjects = new WeakMap();
    this.clientSubscriptions = new WeakMap();
    this.projectRuntimeGateway = {
      call: (projectRoot, operation, args, context) =>
        this.callProjectOperation(projectRoot, operation, args, context),
      cancel: (requestId) => {
        const id = String(requestId || "");
        const projectRoot = this.activeGatewayRequests.get(id);
        return projectRoot ? this.runtimeManager.cancel(projectRoot, id) : false;
      },
      status: () => ({
        ...this.runtimeManager.status(),
        rehydration: this.rehydration,
      }),
      // GlobalDaemon owns the shared manager; MCP listener restart/cleanup
      // must not independently dispose project runtimes.
      dispose: () => {},
    };
    this.disposed = false;
    this.startedAt = "";
    this.rehydration = {
      state: this.rehydrateProjects ? "pending" : "disabled",
      restored: [],
      skipped: [],
      skipped_count: 0,
      failed: [],
    };
    this.rehydrationPromise = Promise.resolve(this.rehydration);
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
      const socket = callContext.requestContext.socket;
      if (this.clientProjects.get(socket) === context.projectRoot) this.bindClientSocket(socket, hostHandle);
      return hostHandle.handleRequest(
        callContext.requestContext.request,
        socket
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

  async restoreRegisteredProjectRuntimes() {
    const startedAt = new Date().toISOString();
    const restored = [];
    const skipped = [];
    let skippedCount = 0;
    const failed = [];
    const recordSkip = (entry) => {
      skippedCount += 1;
      if (skipped.length < MAX_REHYDRATION_SKIP_SAMPLES) skipped.push(entry);
    };
    this.rehydration = {
      state: "running",
      started_at: startedAt,
      restored,
      skipped,
      skipped_count: skippedCount,
      failed,
    };
    const rows = this.listProjectRuntimes({ validate: false, cleanupTmp: true });
    const seen = new Set();
    for (const row of rows) {
      if (this.disposed) break;
      const rawRoot = row && row.project_root;
      if (!rawRoot) continue;
      let projectRoot;
      try {
        projectRoot = canonicalProjectRoot(rawRoot);
      } catch {
        recordSkip({ project_root: String(rawRoot), reason: "missing_project_root" });
        continue;
      }
      if (projectRoot === this.controllerRoot || seen.has(projectRoot)) continue;
      seen.add(projectRoot);
      let reasons;
      try {
        reasons = this.projectRuntimeRecoveryReasons(projectRoot);
      } catch (err) {
        failed.push({
          project_root: projectRoot,
          error: err && err.message ? err.message : String(err),
        });
        continue;
      }
      if (!Array.isArray(reasons) || reasons.length === 0) {
        recordSkip({ project_root: projectRoot, reason: "no_live_runtime_owner" });
        continue;
      }
      try {
        // Preserve ordering and the manager's active-runtime bound rather than
        // stampeding every registered project after a controller restart.
        // eslint-disable-next-line no-await-in-loop
        await this.activateProject(projectRoot);
        restored.push({ project_root: projectRoot, reasons: reasons.slice() });
      } catch (err) {
        failed.push({
          project_root: projectRoot,
          reasons: reasons.slice(),
          error: err && err.message ? err.message : String(err),
        });
      }
    }
    this.rehydration = {
      state: failed.length > 0 ? "degraded" : "complete",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      restored,
      skipped,
      skipped_count: skippedCount,
      failed,
    };
    return this.rehydration;
  }

  async handleRequest(projectRoot, request, socket) {
    const canonicalRoot = this.resolveProjectRoot(projectRoot);
    if (socket && typeof socket.on === "function") {
      const previousRoot = this.clientProjects.get(socket);
      this.clientProjects.set(socket, canonicalRoot);
      if (previousRoot !== canonicalRoot) this.bindClientSocket(socket, null);
    }
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

  bindClientSocket(socket, host) {
    if (!socket || typeof socket.on !== "function") return;
    const next = host?.runtime?.resource("ipcServer") || null;
    const previous = this.clientSubscriptions.get(socket)
      || this.controller?.runtime?.resource("ipcServer");
    if (previous === next) return;
    previous?.detachSocket?.(socket);
    next?.attachSocket?.(socket);
    if (next) this.clientSubscriptions.set(socket, next);
    else this.clientSubscriptions.delete(socket);
  }

  bindControllerClient(socket) {
    if (!socket || typeof socket.on !== "function") return;
    this.clientProjects.set(socket, this.controllerRoot);
    this.bindClientSocket(socket, this.controller);
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
    if (this.rehydrateProjects) {
      this.rehydrationPromise = this.restoreRegisteredProjectRuntimes().catch((err) => {
        this.rehydration = {
          state: "failed",
          started_at: this.rehydration.started_at || new Date().toISOString(),
          completed_at: new Date().toISOString(),
          restored: this.rehydration.restored || [],
          skipped: this.rehydration.skipped || [],
          skipped_count: this.rehydration.skipped_count || 0,
          failed: [{
            project_root: "",
            error: err && err.message ? err.message : String(err),
          }],
        };
        return this.rehydration;
      });
    }
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
      rehydration: this.rehydration,
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
  hasPersistedCronTasks,
  projectRuntimeRecoveryReasons,
  startGlobalDaemon,
};

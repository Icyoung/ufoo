"use strict";

const crypto = require("crypto");
const net = require("net");
const { getUfooPaths } = require("../../coordination/state/paths");
const {
  IPC_REQUEST_TYPES,
  IPC_RESPONSE_TYPES,
} = require("../contracts/eventContract");
const {
  assertToolAllowedForCallerTier,
} = require("../../tools/registry");
const { CALLER_TIERS } = require("../../tools/types");

const MCP_EXPOSED_SHARED_TOOLS = Object.freeze([
  "read_project_registry",
  "read_bus_summary",
  "read_prompt_history",
  "read_open_decisions",
  "list_agents",
  "dispatch_message",
  "ack_bus",
]);

const CONTROL_PLANE_OPERATIONS = Object.freeze([
  "register_agent",
  "heartbeat_agent",
  "publish_activity_state",
  "update_agent_metadata",
  "poll_inbox",
  "wait_for_message",
  "report_agent_status",
  "unregister_agent",
]);

function stripRoutingArgs(args = {}) {
  const next = { ...(args || {}) };
  delete next.project_root;
  delete next.projectRoot;
  delete next.subscriber;
  delete next.agent_handle;
  delete next.agentHandle;
  return next;
}

function unsupportedOperationError(operation = "") {
  const err = new Error(`unsupported project runtime operation: ${operation}`);
  err.code = "unsupported_project_runtime_operation";
  return err;
}

function createControlPlaneHandlers(service = null) {
  const resolvedService = service || require("./controlPlaneService");
  return {
    register_agent: (projectRoot, args) => resolvedService.registerAgent(projectRoot, args),
    heartbeat_agent: (projectRoot, args) => resolvedService.heartbeatAgent(projectRoot, args),
    publish_activity_state: (projectRoot, args) => resolvedService.publishActivityState(projectRoot, args),
    update_agent_metadata: (projectRoot, args) => resolvedService.updateAgentMetadata(projectRoot, args),
    poll_inbox: (projectRoot, args) => resolvedService.pollInbox(projectRoot, args),
    wait_for_message: (projectRoot, args, context) => resolvedService.waitForMessage(projectRoot, args, {
      signal: context.signal,
      pollIntervalMs: context.waitPollIntervalMs,
      heartbeatIntervalMs: context.waitHeartbeatIntervalMs,
      now: context.waitNow,
      sleep: context.waitSleep,
    }),
    report_agent_status: (projectRoot, args) => resolvedService.reportAgentStatus(projectRoot, args),
    unregister_agent: (projectRoot, args) => resolvedService.unregisterAgent(projectRoot, args),
  };
}

async function executeProjectRuntimeOperation(
  projectRoot,
  operation,
  args = {},
  context = {},
  options = {}
) {
  const name = String(operation || "").trim();
  const handlers = options.controlPlaneHandlers
    || createControlPlaneHandlers(options.controlPlaneService);
  const customHandler = handlers[name];
  if (customHandler) {
    return customHandler(projectRoot, args, context);
  }

  if (!MCP_EXPOSED_SHARED_TOOLS.includes(name) || name === "read_project_registry") {
    throw unsupportedOperationError(name);
  }

  if (name === "dispatch_message" || name === "ack_bus") {
    const subscriber = String(args.subscriber || args.source || context.subscriber || "").trim();
    const bus = resolvedBusForAgentHandle(projectRoot, options);
    assertExternalAgentHandle(bus, subscriber, args, options);
  }

  const tool = assertToolAllowedForCallerTier(name, CALLER_TIERS.WORKER, {
    tool_call_id: context.toolCallId,
  });
  const subscriber = String(args.subscriber || args.source || context.subscriber || "").trim();
  const toolArgs = stripRoutingArgs(args);
  if (name === "dispatch_message" && !toolArgs.source && subscriber) {
    toolArgs.source = subscriber;
  }
  return tool.handler({
    projectRoot,
    subscriber,
    caller_tier: CALLER_TIERS.WORKER,
    tool_call_id: context.toolCallId,
  }, toolArgs);
}

function resolvedBusForAgentHandle(projectRoot, options = {}) {
  const service = options.controlPlaneService || require("./controlPlaneService");
  return service.ensureBusLoaded(projectRoot);
}

function assertExternalAgentHandle(bus, subscriber, args = {}, options = {}) {
  const service = options.controlPlaneService || require("./controlPlaneService");
  return service.assertAgentHandle(bus, subscriber, args);
}

class LocalProjectRuntimeGateway {
  constructor(options = {}) {
    this.options = options;
  }

  call(projectRoot, operation, args = {}, context = {}) {
    return executeProjectRuntimeOperation(
      projectRoot,
      operation,
      args,
      context,
      this.options
    );
  }

  cancel() {
    return false;
  }
}

function projectRuntimeError(code, message) {
  const err = new Error(String(message || "project runtime request failed"));
  err.code = String(code || "project_runtime_error");
  return err;
}

function connectProjectRuntimeSocket(sockPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(projectRuntimeError(
        "project_runtime_connect_timeout",
        `project runtime connect timeout: ${sockPath}`
      ));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(projectRuntimeError(
        err && err.code ? String(err.code) : "project_runtime_unavailable",
        `failed to connect project runtime: ${err && err.message ? err.message : err}`
      ));
    });
  });
}

function resolveCallTimeoutMs(operation, args = {}, fallbackMs = 15000) {
  if (operation !== "wait_for_message") return fallbackMs;
  const timeoutSeconds = Number(args.timeout_seconds ?? args.timeoutSeconds ?? 600);
  const waitMs = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? timeoutSeconds * 1000
    : 600000;
  return waitMs + 5000;
}

class SocketProjectRuntimeGateway {
  constructor(options = {}) {
    this.connect = options.connect || connectProjectRuntimeSocket;
    this.socketPath = options.socketPath
      || ((projectRoot) => getUfooPaths(projectRoot).ufooSock);
    this.connectTimeoutMs = Number(options.connectTimeoutMs) || 5000;
    this.callTimeoutMs = Number(options.callTimeoutMs) || 15000;
    this.activeCalls = new Map();
  }

  async call(projectRoot, operation, args = {}, context = {}) {
    if (context.signal && context.signal.aborted) {
      throw projectRuntimeError("request_cancelled", "project runtime request was cancelled");
    }
    const sockPath = this.socketPath(projectRoot);
    const socket = await this.connect(sockPath, this.connectTimeoutMs);
    const requestId = String(
      context.requestId
      || crypto.randomUUID()
    );
    const timeoutMs = resolveCallTimeoutMs(operation, args, this.callTimeoutMs);

    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      let timer = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.activeCalls.delete(requestId);
        if (context.signal) context.signal.removeEventListener("abort", onAbort);
        socket.removeAllListeners();
        try {
          socket.end();
        } catch {
          // ignore close errors
        }
      };

      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        if (settled) return;
        try {
          socket.write(`${JSON.stringify({
            type: IPC_REQUEST_TYPES.CONTROL_PLANE_CANCEL,
            request_id: requestId,
          })}\n`);
        } catch {
          // best-effort cancellation
        }
        try {
          socket.destroy();
        } catch {
          // ignore close errors
        }
        finishReject(projectRuntimeError(
          "request_cancelled",
          "project runtime request was cancelled"
        ));
      };

      this.activeCalls.set(requestId, { cancel: onAbort, socket });
      if (context.signal) {
        context.signal.addEventListener("abort", onAbort, { once: true });
      }

      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let payload;
          try {
            payload = JSON.parse(line);
          } catch {
            continue;
          }
          if (
            payload.type !== IPC_RESPONSE_TYPES.CONTROL_PLANE_RESULT
            || String(payload.request_id || "") !== requestId
          ) {
            continue;
          }
          if (payload.ok === false) {
            const error = payload.error && typeof payload.error === "object"
              ? payload.error
              : {};
            finishReject(projectRuntimeError(
              error.code || "project_runtime_error",
              error.message || "project runtime request failed"
            ));
            return;
          }
          finishResolve(payload.result);
          return;
        }
      });
      socket.once("error", (err) => {
        finishReject(projectRuntimeError(
          err && err.code ? String(err.code) : "project_runtime_connection_error",
          err && err.message ? err.message : String(err)
        ));
      });
      socket.once("close", () => {
        finishReject(projectRuntimeError(
          "project_runtime_connection_closed",
          "project runtime connection closed before a result was returned"
        ));
      });

      timer = setTimeout(() => {
        onAbort();
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      socket.write(`${JSON.stringify({
        type: IPC_REQUEST_TYPES.CONTROL_PLANE_CALL,
        request_id: requestId,
        operation,
        arguments: args,
        tool_call_id: context.toolCallId,
      })}\n`);
    });
  }

  cancel(requestId) {
    const active = this.activeCalls.get(String(requestId || ""));
    if (!active) return false;
    active.cancel();
    return true;
  }
}

function createLocalProjectRuntimeGateway(options = {}) {
  return new LocalProjectRuntimeGateway(options);
}

function createSocketProjectRuntimeGateway(options = {}) {
  return new SocketProjectRuntimeGateway(options);
}

module.exports = {
  MCP_EXPOSED_SHARED_TOOLS,
  CONTROL_PLANE_OPERATIONS,
  stripRoutingArgs,
  executeProjectRuntimeOperation,
  LocalProjectRuntimeGateway,
  SocketProjectRuntimeGateway,
  createLocalProjectRuntimeGateway,
  createSocketProjectRuntimeGateway,
  connectProjectRuntimeSocket,
  resolveCallTimeoutMs,
};

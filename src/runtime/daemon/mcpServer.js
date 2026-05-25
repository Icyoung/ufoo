"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const EventBus = require("../../coordination/bus");
const { getUfooPaths } = require("../../coordination/state/paths");
const { normalizeReportInput } = require("../../coordination/report/store");
const { enqueueAgentReport } = require("./reportControlBus");
const { isRunning, socketPath } = require("./index");
const {
  normalizeProjectRoot,
  resolveGlobalControllerProjectRoot,
  isGlobalControllerProjectRoot,
  listProjectRuntimes,
} = require("../projects");
const { resolveNodeExecutable } = require("../process/nodeExecutable");
const {
  getToolDefinition,
  assertToolAllowedForCallerTier,
} = require("../../tools/registry");
const { CALLER_TIERS } = require("../../tools/types");
const {
  MCP_PROTOCOL_VERSION,
  MCP_ERROR_CODES,
  createJsonRpcResult,
  createJsonRpcError,
} = require("../contracts/mcpContract");

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
const PACKAGE_JSON = require(path.join(PACKAGE_ROOT, "package.json"));

const EXPOSED_SHARED_TOOLS = Object.freeze([
  "read_project_registry",
  "read_bus_summary",
  "read_prompt_history",
  "read_open_decisions",
  "list_agents",
  "dispatch_message",
  "ack_bus",
]);

const CUSTOM_TOOL_DEFINITIONS = Object.freeze([
  {
    name: "ufoo_mcp_status",
    description: "Read local global ufoo MCP bridge status and registered project summary.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: handleMcpStatus,
  },
  {
    name: "register_agent",
    description: "Register an externally launched agent into a registered project bus.",
    input_schema: {
      type: "object",
      required: ["project_root"],
      properties: {
        project_root: { type: "string" },
        agent_type: { type: "string" },
        session_id: { type: "string" },
        nickname: { type: "string" },
        scoped_nickname: { type: "string" },
        launch_mode: { type: "string" },
        capabilities: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    handler: handleRegisterAgent,
  },
  {
    name: "heartbeat_agent",
    description: "Refresh a registered agent heartbeat in its project bus.",
    input_schema: {
      type: "object",
      required: ["project_root", "subscriber"],
      properties: {
        project_root: { type: "string" },
        subscriber: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: handleHeartbeatAgent,
  },
  {
    name: "publish_activity_state",
    description: "Publish the caller agent activity state in its project bus metadata.",
    input_schema: {
      type: "object",
      required: ["project_root", "subscriber", "activity_state"],
      properties: {
        project_root: { type: "string" },
        subscriber: { type: "string" },
        activity_state: { type: "string" },
        detail: { type: "string" },
        since: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: handlePublishActivityState,
  },
  {
    name: "update_agent_metadata",
    description: "Update the caller agent nickname or MCP metadata in its project bus.",
    input_schema: {
      type: "object",
      required: ["project_root", "subscriber"],
      properties: {
        project_root: { type: "string" },
        subscriber: { type: "string" },
        nickname: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    handler: handleUpdateAgentMetadata,
  },
  {
    name: "poll_inbox",
    description: "Read pending bus messages for the caller-owned subscriber queue without acknowledging them.",
    input_schema: {
      type: "object",
      required: ["project_root", "subscriber"],
      properties: {
        project_root: { type: "string" },
        subscriber: { type: "string" },
        limit: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    handler: handlePollInbox,
  },
  {
    name: "report_agent_status",
    description: "Queue an agent task status report through the project daemon report-control queue.",
    input_schema: {
      type: "object",
      required: ["project_root", "subscriber", "task_id", "phase"],
      properties: {
        project_root: { type: "string" },
        subscriber: { type: "string" },
        task_id: { type: "string" },
        phase: { type: "string", enum: ["start", "progress", "done", "error"] },
        message: { type: "string" },
        summary: { type: "string" },
        error: { type: "string" },
        scope: { type: "string", enum: ["public", "private"] },
        meta: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    handler: handleReportAgentStatus,
  },
  {
    name: "unregister_agent",
    description: "Mark an MCP-registered agent inactive in its project bus.",
    input_schema: {
      type: "object",
      required: ["project_root", "subscriber"],
      properties: {
        project_root: { type: "string" },
        subscriber: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: handleUnregisterAgent,
  },
]);

function normalizeBusAgentType(agentType = "") {
  const value = String(agentType || "").trim().toLowerCase();
  if (!value) return "mcp-agent";
  if (value === "claude") return "claude-code";
  if (value === "ucode" || value === "ufoo") return "ufoo-code";
  return value;
}

function nowIso() {
  return new Date().toISOString();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function withProjectRootSchema(schema, options = {}) {
  const cloned = cloneJson(schema);
  const properties = {
    project_root: {
      type: "string",
      description: "Absolute project root from read_project_registry.",
    },
    subscriber: {
      type: "string",
      description: "Caller-owned subscriber id returned by register_agent.",
    },
    ...(cloned.properties || {}),
  };
  const required = Array.isArray(cloned.required) ? cloned.required.slice() : [];
  if (!required.includes("project_root")) required.unshift("project_root");
  if (options.requireSubscriber && !required.includes("subscriber")) required.push("subscriber");
  cloned.properties = properties;
  cloned.required = required;
  cloned.additionalProperties = false;
  return cloned;
}

function toMcpTool(definition, options = {}) {
  const inputSchema = options.projectScoped
    ? withProjectRootSchema(definition.input_schema, {
      requireSubscriber: options.requireSubscriber,
    })
    : cloneJson(definition.input_schema);
  return {
    name: definition.name,
    description: definition.description,
    inputSchema,
  };
}

function buildToolList() {
  const shared = EXPOSED_SHARED_TOOLS
    .map((name) => getToolDefinition(name))
    .filter(Boolean)
    .map((tool) => toMcpTool(tool, {
      projectScoped: tool.name !== "read_project_registry",
      requireSubscriber: tool.name === "dispatch_message" || tool.name === "ack_bus",
    }));
  const custom = CUSTOM_TOOL_DEFINITIONS.map((tool) => toMcpTool(tool));
  return [...custom, ...shared];
}

function createMcpContent(result) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
  };
}

function stripMcpRoutingArgs(args = {}) {
  const next = { ...(args || {}) };
  delete next.project_root;
  delete next.projectRoot;
  delete next.subscriber;
  return next;
}

async function suppressConsoleToStderr(fn) {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const write = (...parts) => {
    const line = parts.map((part) => {
      if (typeof part === "string") return part;
      try {
        return JSON.stringify(part);
      } catch {
        return String(part);
      }
    }).join(" ");
    process.stderr.write(`${line}\n`);
  };
  console.log = write;
  console.info = write;
  console.warn = write;
  console.error = write;
  try {
    return await Promise.resolve(fn());
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
}

function createSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function listRegisteredProjectRows() {
  return listProjectRuntimes({ validate: true, cleanupTmp: true })
    .filter((row) => !isGlobalControllerProjectRoot(row && row.project_root));
}

function resolveRegisteredProjectRoot(args = {}, options = {}) {
  const raw = String(args.project_root || args.projectRoot || "").trim();
  if (!raw) {
    const err = new Error("project_root is required for project-scoped MCP tools");
    err.code = "invalid_project_root";
    throw err;
  }
  const normalized = normalizeProjectRoot(raw);
  if (options.validateProjectRoot === false) return normalized;

  const rows = listRegisteredProjectRows();
  const match = rows.find((row) => normalizeProjectRoot(row.project_root) === normalized);
  if (!match) {
    const err = new Error(`project_root is not registered in the global runtime registry: ${normalized}`);
    err.code = "unregistered_project_root";
    throw err;
  }
  return match.project_root || normalized;
}

function ensureBusLoaded(projectRoot) {
  const bus = new EventBus(projectRoot);
  bus.ensureBus();
  bus.loadBusData();
  return bus;
}

function assertSubscriberExists(bus, subscriber) {
  const meta = bus.subscriberManager.getSubscriber(subscriber);
  if (!meta) {
    const err = new Error(`subscriber not found: ${subscriber}`);
    err.code = "subscriber_not_found";
    throw err;
  }
  return meta;
}

function resolveSubscriberArg(args = {}) {
  const subscriber = String(args.subscriber || args.source || "").trim();
  if (!subscriber) {
    const err = new Error("subscriber is required");
    err.code = "invalid_subscriber";
    throw err;
  }
  return subscriber;
}

function connectSocket(sockPath, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const client = net.createConnection(sockPath, () => {
      if (timer) clearTimeout(timer);
      resolve(client);
    });
    client.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    timer = setTimeout(() => {
      const err = new Error(`connect timeout: ${sockPath}`);
      err.code = "ETIMEDOUT";
      try {
        client.destroy(err);
      } catch {
        // ignore
      }
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

async function waitForSocket(projectRoot, timeoutMs = 3000) {
  const sock = socketPath(projectRoot);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(sock)) {
      try {
        const client = await connectSocket(sock, 250);
        client.end();
        return true;
      } catch {
        // retry
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function ensureGlobalControllerDaemon(options = {}) {
  if (options.autoStart === false) {
    return {
      root: resolveGlobalControllerProjectRoot(),
      running: isRunning(resolveGlobalControllerProjectRoot()),
      auto_started: false,
    };
  }

  const root = resolveGlobalControllerProjectRoot();
  const paths = getUfooPaths(root);
  if (!fs.existsSync(paths.ufooDir) || !fs.existsSync(paths.busDir) || !fs.existsSync(paths.agentDir)) {
    const UfooInit = require("../../app/cli/features/init");
    const init = new UfooInit(PACKAGE_ROOT);
    await suppressConsoleToStderr(() => init.init({
      targets: "context,bus",
      project: root,
      controllerMode: true,
    }));
  }

  if (isRunning(root)) {
    return { root, running: true, auto_started: false };
  }

  const child = spawn(resolveNodeExecutable(), [path.join(PACKAGE_ROOT, "bin", "ufoo.js"), "daemon", "start"], {
    detached: true,
    stdio: "ignore",
    cwd: root,
    env: process.env,
  });
  child.on("error", () => {});
  child.unref();
  const running = await waitForSocket(root, options.startTimeoutMs || 3000);
  return { root, running, auto_started: true };
}

async function handleMcpStatus(ctx = {}) {
  const root = resolveGlobalControllerProjectRoot();
  const projects = listRegisteredProjectRows();
  return {
    ok: true,
    global_controller_root: root,
    global_controller_sock: socketPath(root),
    global_controller_running: isRunning(root),
    auto_start: ctx.autoStart !== false,
    project_count: projects.length,
    projects,
  };
}

async function handleRegisterAgent(ctx = {}, args = {}) {
  const projectRoot = resolveRegisteredProjectRoot(args, ctx);
  const agentType = normalizeBusAgentType(args.agent_type || args.agentType || "mcp-agent");
  const sessionId = String(args.session_id || args.sessionId || createSessionId()).trim();
  const nickname = String(args.nickname || "").trim();
  const launchMode = String(args.launch_mode || args.launchMode || "mcp").trim();
  const capabilities = args.capabilities && typeof args.capabilities === "object"
    ? args.capabilities
    : null;
  const bus = ensureBusLoaded(projectRoot);
  const result = await bus.subscriberManager.join(sessionId, agentType, nickname, {
    parentPid: process.pid,
    launchMode,
    scopedNickname: String(args.scoped_nickname || args.scopedNickname || nickname || "").trim(),
    hostName: "ufoo-mcp",
    hostSessionId: `mcp-${process.pid}`,
    hostCapabilities: capabilities,
  });
  const subscriber = result.subscriber;
  const meta = bus.subscriberManager.getSubscriber(subscriber) || {};
  meta.activity_state = String(args.activity_state || "ready");
  meta.activity_since = nowIso();
  meta.mcp_bridge = true;
  if (capabilities) meta.mcp_capabilities = capabilities;
  bus.saveBusData();
  return {
    ok: true,
    project_root: projectRoot,
    subscriber_id: subscriber,
    subscriber,
    session_id: sessionId,
    agent_type: agentType,
    nickname: meta.nickname || result.nickname || "",
    scoped_nickname: meta.scoped_nickname || result.scopedNickname || "",
    launch_mode: launchMode,
  };
}

async function handleHeartbeatAgent(ctx = {}, args = {}) {
  const projectRoot = resolveRegisteredProjectRoot(args, ctx);
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  const meta = assertSubscriberExists(bus, subscriber);
  bus.subscriberManager.updateLastSeen(subscriber);
  meta.status = "active";
  bus.saveBusData();
  return {
    ok: true,
    project_root: projectRoot,
    subscriber,
    last_seen: meta.last_seen,
  };
}

async function handlePublishActivityState(ctx = {}, args = {}) {
  const projectRoot = resolveRegisteredProjectRoot(args, ctx);
  const subscriber = resolveSubscriberArg(args);
  const activityState = String(args.activity_state || args.activityState || "").trim();
  if (!activityState) {
    const err = new Error("activity_state is required");
    err.code = "invalid_activity_state";
    throw err;
  }
  const bus = ensureBusLoaded(projectRoot);
  const meta = assertSubscriberExists(bus, subscriber);
  bus.subscriberManager.updateLastSeen(subscriber);
  meta.status = "active";
  meta.activity_state = activityState;
  meta.activity_detail = String(args.detail || "").trim();
  meta.activity_since = String(args.since || "").trim() || nowIso();
  bus.saveBusData();
  return {
    ok: true,
    project_root: projectRoot,
    subscriber,
    activity_state: meta.activity_state,
    activity_detail: meta.activity_detail,
    activity_since: meta.activity_since,
  };
}

async function handleUpdateAgentMetadata(ctx = {}, args = {}) {
  const projectRoot = resolveRegisteredProjectRoot(args, ctx);
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  const meta = assertSubscriberExists(bus, subscriber);
  const nickname = String(args.nickname || "").trim();
  if (nickname) {
    await bus.subscriberManager.rename(subscriber, nickname);
  }
  const metadata = args.metadata && typeof args.metadata === "object" ? args.metadata : {};
  if (Object.keys(metadata).length > 0) {
    meta.mcp_metadata = {
      ...(meta.mcp_metadata && typeof meta.mcp_metadata === "object" ? meta.mcp_metadata : {}),
      ...metadata,
    };
  }
  bus.subscriberManager.updateLastSeen(subscriber);
  bus.saveBusData();
  const nextMeta = bus.subscriberManager.getSubscriber(subscriber) || meta;
  return {
    ok: true,
    project_root: projectRoot,
    subscriber,
    nickname: nextMeta.nickname || "",
    scoped_nickname: nextMeta.scoped_nickname || nextMeta.nickname || "",
    metadata: nextMeta.mcp_metadata || {},
  };
}

async function handlePollInbox(ctx = {}, args = {}) {
  const projectRoot = resolveRegisteredProjectRoot(args, ctx);
  const subscriber = resolveSubscriberArg(args);
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
    ? Math.floor(Number(args.limit))
    : 50;
  const bus = ensureBusLoaded(projectRoot);
  assertSubscriberExists(bus, subscriber);
  bus.subscriberManager.updateLastSeen(subscriber);
  bus.saveBusData();
  const pending = await bus.messageManager.check(subscriber);
  return {
    ok: true,
    project_root: projectRoot,
    subscriber,
    count: pending.length,
    messages: pending.slice(0, limit),
    truncated: pending.length > limit,
  };
}

async function handleReportAgentStatus(ctx = {}, args = {}) {
  const projectRoot = resolveRegisteredProjectRoot(args, ctx);
  const subscriber = resolveSubscriberArg(args);
  const report = normalizeReportInput({
    ...args,
    agent_id: subscriber,
    source: "mcp",
  });
  const queued = await enqueueAgentReport(projectRoot, report, { publisher: subscriber });
  return {
    ok: true,
    project_root: projectRoot,
    status: "queued",
    request_id: queued.request_id,
    report,
    queued,
  };
}

async function handleUnregisterAgent(ctx = {}, args = {}) {
  const projectRoot = resolveRegisteredProjectRoot(args, ctx);
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  const ok = await bus.subscriberManager.leave(subscriber);
  bus.saveBusData();
  return {
    ok,
    project_root: projectRoot,
    subscriber,
  };
}

function findCustomTool(name) {
  return CUSTOM_TOOL_DEFINITIONS.find((tool) => tool.name === name) || null;
}

async function invokeTool(name, args = {}, ctx = {}) {
  const custom = findCustomTool(name);
  if (custom) {
    return custom.handler(ctx, args);
  }

  if (!EXPOSED_SHARED_TOOLS.includes(name)) {
    const err = new Error(`unknown MCP tool: ${name}`);
    err.code = "unknown_tool";
    throw err;
  }

  const tool = assertToolAllowedForCallerTier(name, CALLER_TIERS.WORKER, {
    tool_call_id: ctx.toolCallId,
  });
  const projectRoot = name === "read_project_registry"
    ? resolveGlobalControllerProjectRoot()
    : resolveRegisteredProjectRoot(args, ctx);
  const subscriber = String(args.subscriber || args.source || "").trim();
  const toolArgs = stripMcpRoutingArgs(args);
  if (name === "dispatch_message" && !toolArgs.source && subscriber) {
    toolArgs.source = subscriber;
  }
  const toolCtx = {
    projectRoot,
    subscriber,
    caller_tier: CALLER_TIERS.WORKER,
  };
  return tool.handler(toolCtx, toolArgs);
}

class UfooMcpServer {
  constructor(options = {}) {
    this.options = {
      autoStart: options.autoStart !== false,
      validateProjectRoot: options.validateProjectRoot !== false,
      startTimeoutMs: options.startTimeoutMs,
    };
    this.initialized = false;
    this.startup = null;
  }

  async ensureStarted() {
    if (!this.startup) {
      this.startup = ensureGlobalControllerDaemon(this.options).catch((err) => {
        process.stderr.write(`[ufoo-mcp] global controller start failed: ${err.message || err}\n`);
        return {
          root: resolveGlobalControllerProjectRoot(),
          running: false,
          auto_started: false,
          error: err.message || String(err),
        };
      });
    }
    return this.startup;
  }

  async handleRequest(request) {
    if (!request || typeof request !== "object") {
      return createJsonRpcError(null, MCP_ERROR_CODES.INVALID_REQUEST, "Invalid JSON-RPC request");
    }

    const hasId = Object.prototype.hasOwnProperty.call(request, "id");
    const id = hasId ? request.id : undefined;
    const isNotification = !hasId;
    const method = String(request.method || "");
    const params = request.params && typeof request.params === "object" ? request.params : {};

    if (isNotification) {
      if (method === "notifications/initialized") {
        this.initialized = true;
      }
      return null;
    }

    try {
      if (method === "initialize") {
        await this.ensureStarted();
        return createJsonRpcResult(id, {
          protocolVersion: params.protocolVersion || MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "ufoo-global-mcp",
            version: PACKAGE_JSON.version || "0.0.0",
          },
        });
      }

      if (method === "ping") {
        return createJsonRpcResult(id, {});
      }

      if (method === "tools/list") {
        await this.ensureStarted();
        return createJsonRpcResult(id, {
          tools: buildToolList(),
        });
      }

      if (method === "tools/call") {
        await this.ensureStarted();
        const name = String(params.name || "").trim();
        const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
        if (!name) {
          return createJsonRpcError(id, MCP_ERROR_CODES.INVALID_PARAMS, "tools/call requires params.name");
        }
        const result = await suppressConsoleToStderr(() => invokeTool(name, args, {
          ...this.options,
          toolCallId: id,
        }));
        return createJsonRpcResult(id, createMcpContent(result));
      }

      return createJsonRpcError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown MCP method: ${method}`);
    } catch (err) {
      const data = {
        code: err && err.code ? String(err.code) : "tool_error",
      };
      if (err && err.stack && process.env.UFOO_MCP_DEBUG === "1") data.stack = err.stack;
      return createJsonRpcError(id, MCP_ERROR_CODES.INTERNAL_ERROR, err.message || String(err), data);
    }
  }
}

function createUfooMcpServer(options = {}) {
  return new UfooMcpServer(options);
}

async function runMcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const server = createUfooMcpServer(options);
  let buffer = "";

  const writeMessage = (message) => {
    if (!message) return;
    output.write(`${JSON.stringify(message)}\n`);
  };

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch (err) {
        writeMessage(createJsonRpcError(null, MCP_ERROR_CODES.PARSE_ERROR, err.message || "Parse error"));
        continue;
      }
      server.handleRequest(request)
        .then(writeMessage)
        .catch((err) => {
          writeMessage(createJsonRpcError(
            Object.prototype.hasOwnProperty.call(request, "id") ? request.id : null,
            MCP_ERROR_CODES.INTERNAL_ERROR,
            err.message || String(err)
          ));
        });
    }
  });

  return server;
}

module.exports = {
  EXPOSED_SHARED_TOOLS,
  CUSTOM_TOOL_DEFINITIONS,
  buildToolList,
  createUfooMcpServer,
  ensureGlobalControllerDaemon,
  invokeTool,
  runMcpServer,
};

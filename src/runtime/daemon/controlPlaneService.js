"use strict";

const net = require("net");
const EventBus = require("../../coordination/bus");
const { normalizeReportInput } = require("../../coordination/report/store");
const { enqueueAgentReport } = require("./reportControlBus");
const { isRunning, socketPath } = require("./index");
const { IPC_REQUEST_TYPES } = require("../contracts/eventContract");

function nowIso() {
  return new Date().toISOString();
}

function normalizeBusAgentType(agentType = "") {
  const value = String(agentType || "").trim().toLowerCase();
  if (!value) return "mcp-agent";
  if (value === "claude") return "claude-code";
  if (value === "ucode" || value === "ufoo") return "ufoo-code";
  return value;
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

function createSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function notifyDaemonRefresh(projectRoot) {
  if (!isRunning(projectRoot)) return;
  const sock = socketPath(projectRoot);
  try {
    const client = net.createConnection(sock, () => {
      client.write(`${JSON.stringify({ type: IPC_REQUEST_TYPES.REFRESH_STATUS })}\n`);
      client.end();
    });
    client.on("error", () => {});
  } catch {
    // fire-and-forget
  }
}

async function registerAgent(projectRoot, args = {}) {
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
  notifyDaemonRefresh(projectRoot);
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

async function heartbeatAgent(projectRoot, args = {}) {
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  const meta = assertSubscriberExists(bus, subscriber);
  bus.subscriberManager.updateLastSeen(subscriber);
  meta.status = "active";
  bus.saveBusData();
  notifyDaemonRefresh(projectRoot);
  return {
    ok: true,
    project_root: projectRoot,
    subscriber,
    last_seen: meta.last_seen,
  };
}

async function publishActivityState(projectRoot, args = {}) {
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
  notifyDaemonRefresh(projectRoot);
  return {
    ok: true,
    project_root: projectRoot,
    subscriber,
    activity_state: meta.activity_state,
    activity_detail: meta.activity_detail,
    activity_since: meta.activity_since,
  };
}

async function updateAgentMetadata(projectRoot, args = {}) {
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
  notifyDaemonRefresh(projectRoot);
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

async function pollInbox(projectRoot, args = {}) {
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

async function reportAgentStatus(projectRoot, args = {}) {
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

async function unregisterAgent(projectRoot, args = {}) {
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  const ok = await bus.subscriberManager.leave(subscriber);
  bus.saveBusData();
  notifyDaemonRefresh(projectRoot);
  return {
    ok,
    project_root: projectRoot,
    subscriber,
  };
}

module.exports = {
  normalizeBusAgentType,
  ensureBusLoaded,
  assertSubscriberExists,
  resolveSubscriberArg,
  createSessionId,
  notifyDaemonRefresh,
  registerAgent,
  heartbeatAgent,
  publishActivityState,
  updateAgentMetadata,
  pollInbox,
  reportAgentStatus,
  unregisterAgent,
};

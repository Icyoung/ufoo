"use strict";

const crypto = require("crypto");
const net = require("net");
const path = require("path");
const EventBus = require("../../coordination/bus");
const {
  acquirePollLease,
  releasePollLease,
} = require("../../coordination/bus/poll");
const { subscriberToSafeName } = require("../../coordination/bus/utils");
const { normalizeReportInput } = require("../../coordination/report/store");
const { enqueueAgentReport } = require("./reportControlBus");
const { isRunning } = require("./index");
const {
  resolveDaemonEndpoint,
  routeDaemonRequest,
} = require("./endpoint");
const { IPC_REQUEST_TYPES } = require("../contracts/eventContract");
const {
  MCP_WAIT_FOR_MESSAGE_DEFAULT_TIMEOUT_SECONDS,
  MCP_WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS,
} = require("../contracts/mcpContract");
const {
  applyProjectNicknamePrefix,
  checkAndCleanupNickname,
} = require("./nicknameScope");

const WAIT_FOR_MESSAGE_DEFAULT_TIMEOUT_SECONDS = MCP_WAIT_FOR_MESSAGE_DEFAULT_TIMEOUT_SECONDS;
const WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS = MCP_WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS;
const WAIT_FOR_MESSAGE_POLL_INTERVAL_MS = 1000;
const WAIT_FOR_MESSAGE_HEARTBEAT_INTERVAL_MS = 15000;
const MCP_AGENT_LEASE_TTL_MS = 24 * 60 * 60 * 1000;
const MCP_AGENT_RECENT_HEARTBEAT_MS = 30 * 1000;

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

function assertServerOwnedExternalIdentity(args = {}, fields = [], operation = "register_agent") {
  const field = fields.find((name) => Object.prototype.hasOwnProperty.call(args, name));
  if (!field) return;
  const err = new Error(
    `${operation} ${field} is server-assigned; use the subscriber and nickname returned by ufoo`
  );
  err.code = "external_identity_field_forbidden";
  throw err;
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

function createCryptoSessionId() {
  return crypto.randomBytes(4).toString("hex");
}

function isServerAllocatedExternalSessionId(sessionId = "") {
  return /^[0-9a-f]{8}$/.test(String(sessionId || ""));
}

function createAgentHandle() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashAgentHandle(handle = "") {
  return crypto.createHash("sha256").update(String(handle || ""), "utf8").digest("hex");
}

function leaseExpiryIso(nowMs = Date.now()) {
  return new Date(nowMs + MCP_AGENT_LEASE_TTL_MS).toISOString();
}

function extendMcpAgentLease(meta, nowMs = Date.now()) {
  meta.mcp_lease_expires_at = leaseExpiryIso(nowMs);
  delete meta.mcp_revoked_at;
  return meta.mcp_lease_expires_at;
}

function assertAgentHandle(bus, subscriber, args = {}, options = {}) {
  const meta = assertSubscriberExists(bus, subscriber);
  if (meta.mcp_bridge !== true || !meta.mcp_agent_handle_hash) {
    const err = new Error(`subscriber is not an MCP-registered Agent: ${subscriber}`);
    err.code = "agent_handle_not_available";
    throw err;
  }
  const handle = String(args.agent_handle || args.agentHandle || "").trim();
  if (!handle) {
    const err = new Error("agent_handle is required");
    err.code = "agent_handle_required";
    throw err;
  }
  const actual = Buffer.from(hashAgentHandle(handle), "hex");
  const expected = Buffer.from(String(meta.mcp_agent_handle_hash || ""), "hex");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    const err = new Error("agent_handle does not own this subscriber");
    err.code = "invalid_agent_handle";
    throw err;
  }
  if (options.allowInactive !== true && meta.status !== "active") {
    const err = new Error(`Agent registration is inactive: ${subscriber}`);
    err.code = "agent_lease_inactive";
    throw err;
  }
  const expiresAtMs = Date.parse(String(meta.mcp_lease_expires_at || ""));
  if (
    options.allowExpired !== true
    && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())
  ) {
    const err = new Error(`Agent lease expired: ${subscriber}`);
    err.code = "agent_lease_expired";
    throw err;
  }
  return meta;
}

function notifyDaemonRefresh(projectRoot) {
  const endpoint = resolveDaemonEndpoint(projectRoot);
  const daemonRoot = endpoint.scope === "global"
    ? endpoint.controllerRoot
    : endpoint.projectRoot;
  if (!isRunning(daemonRoot)) return;
  try {
    const client = net.createConnection(endpoint.socketPath, () => {
      client.write(`${JSON.stringify(routeDaemonRequest(endpoint, {
        type: IPC_REQUEST_TYPES.REFRESH_STATUS,
      }))}\n`);
      client.end();
    });
    client.on("error", () => {});
  } catch {
    // fire-and-forget
  }
}

async function registerAgentFull(projectRoot, args = {}, options = {}) {
  const {
    validateParentPid = false,
    checkNicknameConflicts = false,
  } = options;

  const agentType = normalizeBusAgentType(args.agent_type || args.agentType || "mcp-agent");
  const nickname = String(args.nickname || "").trim();
  const launchMode = String(args.launch_mode || args.launchMode || "mcp").trim();
  const capabilities = args.capabilities && typeof args.capabilities === "object"
    ? args.capabilities
    : null;
  const hostCapabilities = args.hostCapabilities && typeof args.hostCapabilities === "object"
    ? args.hostCapabilities
    : capabilities;
  const clientInstanceId = String(
    args.client_instance_id || args.clientInstanceId || ""
  ).trim();
  const bus = ensureBusLoaded(projectRoot);

  // Wrapper launches may provide resume metadata. External MCP registrations
  // recover only through client_instance_id; otherwise the server owns the
  // short session id so subscriber shapes stay consistent across launch modes.
  let sessionId;
  const explicitSessionId = String(args.session_id || args.sessionId || "").trim();
  const reuseSession = args.reuseSession && typeof args.reuseSession === "object"
    ? args.reuseSession
    : null;
  const reuseSessionId = typeof reuseSession?.sessionId === "string"
    ? reuseSession.sessionId.trim() : "";
  const reuseSubscriberId = typeof reuseSession?.subscriberId === "string"
    ? reuseSession.subscriberId.trim() : "";
  const reuseProviderSessionId = typeof reuseSession?.providerSessionId === "string"
    ? reuseSession.providerSessionId.trim() : "";

  const clientInstanceEntries = !validateParentPid && clientInstanceId
    ? Object.entries(bus.busData.agents || {}).filter(([, meta]) => (
      meta
      && meta.mcp_bridge === true
      && meta.mcp_client_instance_id === clientInstanceId
    ))
    : [];
  const recoveredEntry = clientInstanceEntries.find(([subscriber, meta]) => (
    meta.agent_type === agentType
    && subscriber.startsWith(`${agentType}:`)
    && isServerAllocatedExternalSessionId(subscriber.slice(agentType.length + 1))
  ));
  const recoveredSubscriber = recoveredEntry ? recoveredEntry[0] : "";
  const recoveredSessionId = recoveredSubscriber.startsWith(`${agentType}:`)
    ? recoveredSubscriber.slice(agentType.length + 1)
    : "";

  if (recoveredSessionId) {
    sessionId = recoveredSessionId;
  } else if (validateParentPid && explicitSessionId) {
    sessionId = explicitSessionId;
  } else if (
    validateParentPid
    && reuseSessionId
    && reuseSubscriberId === `${agentType}:${reuseSessionId}`
  ) {
    sessionId = reuseSessionId;
  } else {
    sessionId = createCryptoSessionId();
  }

  // parentPid validation
  const parentPid = Number.parseInt(args.parentPid, 10);
  if (validateParentPid) {
    if (!Number.isFinite(parentPid) || parentPid <= 0) {
      const err = new Error("register_agent requires valid parentPid");
      err.code = "invalid_parent_pid";
      throw err;
    }
  }

  // Nickname scope and conflict check
  let finalNickname = nickname;
  let scopedNickname = nickname
    ? applyProjectNicknamePrefix(projectRoot, nickname, { agentType })
    : "";
  if (checkNicknameConflicts && finalNickname) {
    const nickCheck = checkAndCleanupNickname(projectRoot, finalNickname, {
      tty: String(args.tty || ""),
      agentType,
      scopedNickname,
    });
    if (nickCheck.existing) {
      finalNickname = "";
      scopedNickname = "";
    }
  }

  // Bus join
  const joinOptions = {
    parentPid: Number.isFinite(parentPid) && parentPid > 0 ? parentPid : process.pid,
    launchMode,
    tmuxPane: String(args.tmuxPane || ""),
    tty: String(args.tty || ""),
    hostInjectSock: String(args.hostInjectSock || ""),
    hostDaemonSock: String(args.hostDaemonSock || ""),
    hostName: String(args.host_name || args.hostName || "ufoo-mcp"),
    hostSessionId: String(args.hostSessionId || `mcp-${process.pid}`),
    hostCapabilities: hostCapabilities,
    scopedNickname: scopedNickname || String(args.scoped_nickname || args.scopedNickname || finalNickname || "").trim(),
  };
  if (args.skipSessionResolve) joinOptions.skipSessionResolve = true;
  if (reuseSessionId) joinOptions.reuseSessionId = reuseSessionId;
  if (reuseProviderSessionId) joinOptions.reuseProviderSessionId = reuseProviderSessionId;

  const candidateSubscriber = `${agentType}:${sessionId}`;
  const existingCandidate = bus.subscriberManager.getSubscriber(candidateSubscriber);
  if (
    !validateParentPid
    && existingCandidate
    && existingCandidate.mcp_agent_handle_hash
    && (!clientInstanceId || existingCandidate.mcp_client_instance_id !== clientInstanceId)
  ) {
    const err = new Error(`subscriber is already registered: ${candidateSubscriber}`);
    err.code = "subscriber_already_registered";
    throw err;
  }
  const result = await bus.subscriberManager.join(sessionId, agentType, finalNickname, joinOptions);
  const subscriber = result.subscriber;
  if (finalNickname) {
    bus.subscriberManager.rename(subscriber, finalNickname, "ufoo-agent", { scopedNickname });
  }
  const meta = bus.subscriberManager.getSubscriber(subscriber) || {};
  meta.activity_state = String(args.activity_state || "ready");
  meta.activity_since = nowIso();
  meta.mcp_bridge = !validateParentPid;
  let agentHandle = "";
  if (!validateParentPid) {
    agentHandle = createAgentHandle();
    meta.mcp_agent_handle_hash = hashAgentHandle(agentHandle);
    meta.mcp_client_instance_id = clientInstanceId;
    meta.mcp_registered_at = meta.mcp_registered_at || nowIso();
    extendMcpAgentLease(meta);
  }
  if (hostCapabilities) meta.mcp_capabilities = hostCapabilities;
  const supersededSubscribers = [];
  if (!validateParentPid && clientInstanceId) {
    for (const [previousSubscriber, previousMeta] of clientInstanceEntries) {
      if (previousSubscriber === subscriber) continue;
      const revokedAt = nowIso();
      previousMeta.mcp_revoked_at = revokedAt;
      previousMeta.mcp_lease_expires_at = revokedAt;
      previousMeta.mcp_superseded_by = subscriber;
      await bus.subscriberManager.leave(previousSubscriber);
      previousMeta.status = "inactive";
      previousMeta.activity_state = "";
      supersededSubscribers.push(previousSubscriber);
    }
  }
  bus.saveBusData();
  notifyDaemonRefresh(projectRoot);
  return {
    ok: true,
    project_root: projectRoot,
    subscriber_id: subscriber,
    subscriber,
    session_id: sessionId,
    agent_type: agentType,
    nickname: meta.nickname || result.nickname || finalNickname || "",
    scoped_nickname: meta.scoped_nickname || result.scopedNickname || scopedNickname || "",
    launch_mode: launchMode,
    ...(agentHandle ? {
      agent_handle: agentHandle,
      lease_expires_at: meta.mcp_lease_expires_at,
      client_instance_id: clientInstanceId,
      recovered: Boolean(recoveredSubscriber),
      ...(supersededSubscribers.length > 0 ? { superseded_subscribers: supersededSubscribers } : {}),
    } : {}),
    reuseProviderSessionId,
    skipSessionResolve: !!args.skipSessionResolve,
  };
}

async function registerAgent(projectRoot, args = {}) {
  if (!String(args.agent_type || args.agentType || "").trim()) {
    const err = new Error("register_agent requires agent_type for canonical identity allocation");
    err.code = "external_agent_type_required";
    throw err;
  }
  assertServerOwnedExternalIdentity(args, [
    "session_id",
    "sessionId",
    "nickname",
    "scoped_nickname",
    "scopedNickname",
  ]);
  return registerAgentFull(projectRoot, args, {
    validateParentPid: false,
    checkNicknameConflicts: false,
  });
}

async function heartbeatAgent(projectRoot, args = {}) {
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  const meta = assertAgentHandle(bus, subscriber, args);
  bus.subscriberManager.updateLastSeen(subscriber);
  meta.status = "active";
  const leaseExpiresAt = extendMcpAgentLease(meta);
  bus.saveBusData();
  notifyDaemonRefresh(projectRoot);
  return {
    ok: true,
    project_root: projectRoot,
    subscriber,
    last_seen: meta.last_seen,
    lease_expires_at: leaseExpiresAt,
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
  const meta = assertAgentHandle(bus, subscriber, args);
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
  assertServerOwnedExternalIdentity(args, [
    "nickname",
    "scoped_nickname",
    "scopedNickname",
  ], "update_agent_metadata");
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  const meta = assertAgentHandle(bus, subscriber, args);
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
  assertAgentHandle(bus, subscriber, args);
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

function waitForMessageCancelledError() {
  const err = new Error("wait_for_message was cancelled");
  err.code = "request_cancelled";
  return err;
}

function throwIfWaitCancelled(signal) {
  if (signal && signal.aborted) {
    throw waitForMessageCancelledError();
  }
}

function waitWithSignal(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(waitForMessageCancelledError());
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeWaitForMessageArgs(args = {}) {
  const rawAfterSeq = args.after_seq ?? args.afterSeq ?? 0;
  const afterSeq = Number(rawAfterSeq);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    const err = new Error("wait_for_message after_seq must be a non-negative integer");
    err.code = "invalid_after_seq";
    throw err;
  }

  const rawTimeout = args.timeout_seconds
    ?? args.timeoutSeconds
    ?? WAIT_FOR_MESSAGE_DEFAULT_TIMEOUT_SECONDS;
  const timeoutSeconds = Number(rawTimeout);
  if (
    !Number.isFinite(timeoutSeconds)
    || timeoutSeconds < 0
    || (timeoutSeconds > 0 && timeoutSeconds < 1)
    || timeoutSeconds > WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS
  ) {
    const err = new Error(
      `wait_for_message timeout_seconds must be 0 (until message) or between 1 and ${WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS}`
    );
    err.code = "invalid_timeout";
    throw err;
  }

  const rawLimit = args.limit ?? 50;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    const err = new Error("wait_for_message limit must be an integer between 1 and 100");
    err.code = "invalid_limit";
    throw err;
  }

  return {
    afterSeq,
    timeoutSeconds,
    limit,
  };
}

function eventSeq(event = {}) {
  const seq = Number(event && event.seq);
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
}

function touchWaitingSubscriber(bus, subscriber, args = {}) {
  // Long waits span concurrent metadata updates from other agents. Reload
  // before writing heartbeat state so a stale in-memory registry cannot
  // overwrite those updates.
  bus.loadBusData();
  const meta = assertAgentHandle(bus, subscriber, args);
  meta.status = "active";
  bus.subscriberManager.updateLastSeen(subscriber);
  extendMcpAgentLease(meta);
  bus.saveBusData();
}

async function waitForMessage(projectRoot, args = {}, options = {}) {
  const subscriber = resolveSubscriberArg(args);
  const { afterSeq, timeoutSeconds, limit } = normalizeWaitForMessageArgs(args);
  const signal = options.signal || null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : waitWithSignal;
  const pollIntervalMs = Math.max(
    50,
    Number(options.pollIntervalMs) || WAIT_FOR_MESSAGE_POLL_INTERVAL_MS
  );
  const heartbeatIntervalMs = Math.max(
    1000,
    Number(options.heartbeatIntervalMs) || WAIT_FOR_MESSAGE_HEARTBEAT_INTERVAL_MS
  );
  const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : null;

  const bus = ensureBusLoaded(projectRoot);
  touchWaitingSubscriber(bus, subscriber, args);
  const lease = acquirePollLease(path.join(
    bus.busDir,
    "pids",
    `poll-${subscriberToSafeName(subscriber)}.pid`
  ), { operation: "wait_for_message" });
  const cleanupLease = () => releasePollLease(lease);
  process.once("exit", cleanupLease);

  const startedAt = now();
  const deadline = timeoutMs == null ? null : startedAt + timeoutMs;
  let nextHeartbeatAt = startedAt + heartbeatIntervalMs;

  try {
    while (true) {
      throwIfWaitCancelled(signal);

      // Queue reads are non-mutating: the Agent acknowledges only after work is
      // handled, and after_seq suppresses re-delivery within a re-armed wait.
      // eslint-disable-next-line no-await-in-loop
      const pending = await bus.queueManager.peekPending(subscriber);
      const unseen = pending.filter((event) => eventSeq(event) > afterSeq);
      if (unseen.length > 0) {
        const messages = unseen.slice(0, limit);
        const lastSeq = Math.max(afterSeq, ...messages.map(eventSeq));
        touchWaitingSubscriber(bus, subscriber, args);
        return {
          ok: true,
          project_root: projectRoot,
          subscriber,
          status: "message",
          timed_out: false,
          count: messages.length,
          messages,
          truncated: unseen.length > messages.length,
          after_seq: afterSeq,
          last_seq: lastSeq,
          waited_ms: Math.max(0, now() - startedAt),
        };
      }

      const current = now();
      if (deadline != null && current >= deadline) {
        touchWaitingSubscriber(bus, subscriber, args);
        return {
          ok: true,
          project_root: projectRoot,
          subscriber,
          status: "timeout",
          timed_out: true,
          count: 0,
          messages: [],
          truncated: false,
          after_seq: afterSeq,
          last_seq: afterSeq,
          waited_ms: Math.max(0, current - startedAt),
        };
      }

      if (current >= nextHeartbeatAt) {
        touchWaitingSubscriber(bus, subscriber, args);
        nextHeartbeatAt = current + heartbeatIntervalMs;
      }

      const delayMs = deadline == null
        ? pollIntervalMs
        : Math.max(1, Math.min(pollIntervalMs, deadline - current));
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs, signal);
    }
  } finally {
    process.removeListener("exit", cleanupLease);
    cleanupLease();
  }
}

async function reportAgentStatus(projectRoot, args = {}) {
  const subscriber = resolveSubscriberArg(args);
  const bus = ensureBusLoaded(projectRoot);
  assertAgentHandle(bus, subscriber, args);
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
  const meta = assertAgentHandle(bus, subscriber, args, {
    allowExpired: true,
    allowInactive: true,
  });
  meta.mcp_revoked_at = nowIso();
  meta.mcp_lease_expires_at = meta.mcp_revoked_at;
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
  createAgentHandle,
  hashAgentHandle,
  assertAgentHandle,
  extendMcpAgentLease,
  notifyDaemonRefresh,
  registerAgentFull,
  registerAgent,
  heartbeatAgent,
  publishActivityState,
  updateAgentMetadata,
  pollInbox,
  waitForMessage,
  reportAgentStatus,
  unregisterAgent,
  normalizeWaitForMessageArgs,
  WAIT_FOR_MESSAGE_DEFAULT_TIMEOUT_SECONDS,
  WAIT_FOR_MESSAGE_MAX_TIMEOUT_SECONDS,
  MCP_AGENT_LEASE_TTL_MS,
  MCP_AGENT_RECENT_HEARTBEAT_MS,
};

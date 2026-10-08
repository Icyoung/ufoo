"use strict";

const fs = require("fs");
const path = require("path");
const EventBus = require("../../coordination/bus");
const { DeliveryQueue } = require("../../coordination/bus/deliveryQueue");
const { subscriberToSafeName } = require("../../coordination/bus/utils");
const { getUfooPaths } = require("../../coordination/state/paths");
const { BUS_STATUS_PHASES } = require("../contracts/eventContract");
const { isInternalAgentMeta, isInternalDashboardEvent } = require("../contracts/agentMode");
const { isAgentReportControlEvent, extractAgentReportControl, drainReportControlEvents } = require("./reportControlBus");

function startBusBridge(
  projectRoot,
  provider,
  onEvent,
  onStatus,
  shouldDrain,
  onReport,
  options = {}
) {
  const state = {
    subscriber: null,
    queueFile: null,
    pending: new Set(),
    watchedAgents: new Set(),
    lastEventSeq: 0,
    emittedEventKeys: [],
    emittedEventKeySet: new Set(),
  };
  const eventBus = options.eventBus || new EventBus(projectRoot);
  const reportJoinError = typeof options.onJoinError === "function"
    ? options.onJoinError
    : () => {};
  let joinInProgress = null;
  let lastJoinError = "";
  let stopped = false;
  let polling = false;
  let observationWatch = null;
  let observationTimer = null;
  const eventCursors = new Map();
  let watchStartSeq = 0;

  function watchObservations() {
    if (observationWatch || stopped || state.watchedAgents.size === 0) return;
    try {
      observationWatch = fs.watch(getUfooPaths(projectRoot).busEventsDir, () => {
        if (stopped || observationTimer) return;
        observationTimer = setTimeout(() => {
          observationTimer = null;
          poll().catch(() => {});
        }, 25);
        observationTimer.unref?.();
      });
      observationWatch.unref?.();
      observationWatch.on("error", () => { observationWatch?.close(); observationWatch = null; });
    } catch { /* The regular poll also retries after workspace initialization. */ }
  }

  function getAgentNickname(agentId) {
    if (!agentId) return agentId;
    try {
      const busPath = getUfooPaths(projectRoot).agentsFile;
      const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
      const meta = bus.agents && bus.agents[agentId];
      if (meta && meta.nickname) {
        return meta.nickname;
      }
    } catch {
      // Ignore errors, return original ID
    }
    return agentId;
  }

  function getEventDedupeKey(evt) {
    if (!evt || typeof evt !== "object") return "";
    const seq = Number(evt.seq);
    if (Number.isFinite(seq) && seq > 0) return `seq:${seq}`;
    return [
      "event",
      evt.timestamp || evt.ts || "",
      evt.event || "",
      evt.publisher || "",
      evt.target || "",
      JSON.stringify(evt.data || {}),
    ].join(":");
  }

  function rememberEmittedEvent(evt) {
    const key = getEventDedupeKey(evt);
    if (!key) return false;
    if (state.emittedEventKeySet.has(key)) return true;
    state.emittedEventKeySet.add(key);
    state.emittedEventKeys.push(key);
    if (state.emittedEventKeys.length > 500) {
      const removed = state.emittedEventKeys.splice(0, state.emittedEventKeys.length - 500);
      for (const item of removed) state.emittedEventKeySet.delete(item);
    }
    return false;
  }

  function hasPositiveSeq(seq) {
    const value = Number(seq);
    return Number.isFinite(value) && value > 0;
  }

  function toBridgeEvent(evt) {
    const data = evt.data && typeof evt.data === "object" ? evt.data : {};
    return {
      seq: evt.seq,
      event: evt.event,
      publisher: evt.publisher,
      target: evt.target,
      data,
      message: data.message || "",
      state: data.state || "",
      previous: data.previous || "",
      subscriber: data.subscriber || "",
      source: data.source || "",
      injection_mode: data.injection_mode || "",
      ts: evt.timestamp || evt.ts,
    };
  }

  function emitBusEvent(evt) {
    if (!evt || !onEvent) return;
    if (options.internalOnly && !acceptsEvent(evt)) return;
    if (rememberEmittedEvent(evt)) return;
    onEvent(toBridgeEvent(evt));
  }

  function readAgentsData() {
    try {
      const busPath = getUfooPaths(projectRoot).agentsFile;
      return JSON.parse(fs.readFileSync(busPath, "utf8"));
    } catch {
      return {};
    }
  }

  function acceptsEvent(evt) {
    const agents = readAgentsData().agents || {};
    return isInternalDashboardEvent(toBridgeEvent(evt), (id) => agents[id]);
  }

  function buildWatchedAliases() {
    const aliases = new Set();
    const bus = readAgentsData();
    for (const agentId of state.watchedAgents) {
      const meta = bus.agents && bus.agents[agentId];
      if (options.internalOnly && !isInternalAgentMeta(meta)) {
        state.watchedAgents.delete(agentId);
        continue;
      }
      aliases.add(agentId);
      if (!meta) continue;
      if (meta.nickname) aliases.add(meta.nickname);
      if (meta.scoped_nickname) aliases.add(meta.scoped_nickname);
      if (meta.display_nickname) aliases.add(meta.display_nickname);
    }
    return aliases;
  }

  function isWatchedEvent(evt, aliases = buildWatchedAliases()) {
    if (!evt || !["message", "activity_state_changed", "agent_surface"].includes(evt.event)) return false;
    const publisher = String(evt.publisher || "");
    const target = String(evt.target || "");
    const subscriber = evt.data && evt.data.subscriber ? String(evt.data.subscriber) : "";
    return aliases.has(publisher) || aliases.has(target) || aliases.has(subscriber);
  }

  function getEventFiles() {
    try {
      const dir = getUfooPaths(projectRoot).busEventsDir;
      return fs.readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  function readCurrentSeq() {
    try {
      const raw = fs.readFileSync(path.join(getUfooPaths(projectRoot).busDir, "seq.counter"), "utf8").trim();
      const seq = Number(raw);
      return Number.isFinite(seq) ? seq : 0;
    } catch {
      return 0;
    }
  }

  function readEventFile(file) {
    let fd;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      let cursor = eventCursors.get(file) || { offset: 0, partial: Buffer.alloc(0) };
      if (size < cursor.offset) cursor = { offset: 0, partial: Buffer.alloc(0) };
      const buffer = Buffer.alloc(Math.min(size - cursor.offset, 512 * 1024));
      const read = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
      cursor.offset += read;
      const content = Buffer.concat([cursor.partial, buffer.subarray(0, read)]);
      const end = content.lastIndexOf(10);
      cursor.partial = content.subarray(end + 1);
      eventCursors.set(file, cursor);
      if (end < 0) return [];
      return content.subarray(0, end).toString("utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function pollWatchedEvents() {
    if (state.watchedAgents.size === 0) {
      state.lastEventSeq = readCurrentSeq();
      return;
    }
    const aliases = buildWatchedAliases();
    let maxSeq = state.lastEventSeq;
    for (const file of getEventFiles().slice(-2)) {
      for (const evt of readEventFile(file)) {
        const seq = Number(evt.seq);
        if (hasPositiveSeq(seq)) {
          // Append order can differ from sequence allocation across processes.
          // File cursors and emission dedupe avoid dropping a late append.
          if (seq <= watchStartSeq) continue;
          if (seq > maxSeq) maxSeq = seq;
        }
        if (isWatchedEvent(evt, aliases)) emitBusEvent(evt);
      }
    }
    state.lastEventSeq = Math.max(state.lastEventSeq, maxSeq);
  }

  async function ensureSubscriber() {
    if (stopped || state.subscriber) return state.subscriber;
    if (joinInProgress) return joinInProgress;
    joinInProgress = (async () => {
      try {
        // Determine agent type based on provider configuration
        const agentType = provider === "codex-cli" ? "codex" : (provider === "ucode" ? "ufoo-code" : "claude-code");
        // Use fixed ID "ufoo-agent" for daemon's bus identity with explicit nickname
        const sub = await eventBus.join("ufoo-agent", agentType, "ufoo-agent");
        if (!sub || stopped) return null;
        state.subscriber = sub;
        const safe = subscriberToSafeName(sub);
        state.queueFile = path.join(getUfooPaths(projectRoot).busQueuesDir, safe, "pending.jsonl");
        lastJoinError = "";
        return sub;
      } catch (err) {
        const detail = err && err.message ? err.message : String(err || "unknown join error");
        if (detail !== lastJoinError) {
          lastJoinError = detail;
          try {
            reportJoinError(err);
          } catch {
            // Diagnostics must never turn a recoverable join failure into an
            // unhandled rejection in the process-wide global daemon.
          }
        }
        return null;
      } finally {
        joinInProgress = null;
      }
    })();
    return joinInProgress;
  }

  async function handleReportControlEvent(evt) {
    if (!isAgentReportControlEvent(evt)) return false;
    if (typeof onReport !== "function") return false;
    const control = extractAgentReportControl(evt);
    if (!control) return false;
    await onReport(control.report, {
      event: evt,
      requestId: control.request_id,
      queuedAt: control.queued_at,
    });
    if (["done", "error"].includes(control.report.phase)) {
      const agentId = control.report.agent_id || evt.publisher;
      const reportState = require("../../coordination/report/store").loadReportState(projectRoot);
      if (!reportState.agents[agentId]?.pending_count && state.pending.delete(agentId) && onStatus) {
        onStatus({ phase: control.report.phase === "error" ? BUS_STATUS_PHASES.ERROR : BUS_STATUS_PHASES.DONE,
          text: `${getAgentNickname(agentId)} ${control.report.phase}`, key: agentId });
      }
    }
    return true;
  }

  async function pollReportControlQueue() {
    await drainReportControlEvents(projectRoot, handleReportControlEvent);
  }

  async function pollQueue() {
    if (!state.queueFile) return;
    const queue = new DeliveryQueue(state.queueFile);
    queue.recover();
    while (true) {
      const claim = queue.claimNext();
      if (!claim) break;
      const evt = claim.event;
      if (!evt) {
        queue.completeClaim(claim);
        continue;
      }
      try {
        if (evt.event === "message" && typeof options.onMessage === "function"
            && (!options.internalOnly || acceptsEvent(evt))) await options.onMessage(toBridgeEvent(evt));
        emitBusEvent(evt);
        queue.completeClaim(claim);
      } catch {
        queue.restoreClaim(claim);
        break;
      }
    }
  }

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await ensureSubscriber();
      watchObservations();
      await pollReportControlQueue();
      if (typeof shouldDrain === "function" && !shouldDrain() && typeof options.onMessage !== "function") return;
      await pollQueue();
      pollWatchedEvents();
    } finally {
      polling = false;
    }
  }

  const interval = setInterval(() => {
    poll().catch(() => {});
  }, 1000);
  return {
    markPending(target) {
      if (!target) return;
      state.pending.add(target);
      if (onStatus) {
        const displayName = getAgentNickname(target);
        onStatus({ phase: BUS_STATUS_PHASES.START, text: `${displayName} processing`, key: target });
      }
    },
    getSubscriber() {
      void ensureSubscriber();
      return state.subscriber;
    },
    refresh() {
      return poll();
    },
    watchAgent(agentId, enabled = true) {
      if (!agentId) return;
      if (enabled && options.internalOnly && !isInternalAgentMeta(readAgentsData().agents?.[agentId])) return;
      if (enabled) {
        if (state.watchedAgents.size === 0) {
          watchStartSeq = readCurrentSeq();
          state.lastEventSeq = watchStartSeq;
          eventCursors.clear();
          for (const file of getEventFiles().slice(-2)) {
            try { eventCursors.set(file, { offset: fs.statSync(file).size, partial: Buffer.alloc(0) }); } catch {}
          }
        }
        state.watchedAgents.add(agentId);
        watchObservations();
      } else {
        state.watchedAgents.delete(agentId);
        if (state.watchedAgents.size === 0) {
          state.lastEventSeq = readCurrentSeq();
        }
      }
    },
    stop() {
      stopped = true;
      clearInterval(interval);
      if (observationTimer) clearTimeout(observationTimer);
      observationWatch?.close();
    },
  };
}

module.exports = { startBusBridge };

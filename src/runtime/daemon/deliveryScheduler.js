const fs = require("fs");
const { getUfooPaths } = require("../../coordination/state/paths");
const { DeliveryQueue } = require("../../coordination/bus/deliveryQueue");
const Injector = require("../../coordination/bus/inject");
const { buildPromptInjectionText } = require("../../coordination/bus/promptEnvelope");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");
const { normalizeQueueEnvelope } = require("../../coordination/bus/deliveryQueue");

function asState(value = "") {
  return String(value || "").trim().toLowerCase();
}

function isDeliverableActivityState(value = "") {
  const state = asState(value);
  return state === "idle" || state === "ready";
}

// Warn once a subscriber has been continuously gate-deferred for this long.
const DEFAULT_DEFER_WARN_AFTER_MS = 60 * 1000;
// Minimum interval between repeated defer/lock warnings for the same subscriber.
const DEFAULT_WARN_INTERVAL_MS = 60 * 1000;
// After this long stuck in waiting_input/blocked, deliver anyway (better a
// message in a stuck terminal than a lost one). Env UFOO_DELIVERY_BLOCKED_GRACE_MS overrides.
const DEFAULT_BLOCKED_GRACE_MS = 15 * 60 * 1000;
// Warn when an inject lock is held longer than this (usually means a stuck inject).
const DEFAULT_LOCKED_WARN_AFTER_MS = 60 * 1000;

function positiveMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readAgentsFile(agentsFile) {
  try {
    if (!agentsFile || !fs.existsSync(agentsFile)) return { agents: {} };
    const parsed = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    if (!parsed || typeof parsed !== "object") return { agents: {} };
    if (!parsed.agents || typeof parsed.agents !== "object") parsed.agents = {};
    return parsed;
  } catch {
    return { agents: {} };
  }
}

class DeliveryScheduler {
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot;
    this.paths = getUfooPaths(projectRoot);
    this.injector = options.injector || new Injector(this.paths.busDir, this.paths.agentsFile);
    this.queueFactory = typeof options.queueFactory === "function"
      ? options.queueFactory
      : (subscriber) => DeliveryQueue.forSubscriber(this.paths.busDir, subscriber);
    this.buildInjectionText = typeof options.buildInjectionText === "function"
      ? options.buildInjectionText
      : buildPromptInjectionText;
    this.readAgents = typeof options.readAgents === "function"
      ? options.readAgents
      : () => readAgentsFile(this.paths.agentsFile);
    this.emitDelivery = typeof options.emitDelivery === "function"
      ? options.emitDelivery
      : async () => {};
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.deferWarnAfterMs = positiveMs(options.deferWarnAfterMs, DEFAULT_DEFER_WARN_AFTER_MS);
    this.warnIntervalMs = positiveMs(options.warnIntervalMs, DEFAULT_WARN_INTERVAL_MS);
    this.blockedGraceMs = positiveMs(
      options.blockedGraceMs,
      positiveMs(Number(process.env.UFOO_DELIVERY_BLOCKED_GRACE_MS), DEFAULT_BLOCKED_GRACE_MS),
    );
    this.lockedWarnAfterMs = positiveMs(options.lockedWarnAfterMs, DEFAULT_LOCKED_WARN_AFTER_MS);
    this.intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : 1000;
    this.adapterRouter = options.adapterRouter || createTerminalAdapterRouter();
    this.locks = new Map();
    this.deferrals = new Map();
    this.blockedStateSeen = new Map();
    this.graceWarned = new Map();
    this.timer = null;
    this.running = false;
  }

  pendingCount(subscriber) {
    try {
      const queue = this.queueFactory(subscriber);
      if (queue && typeof queue.readPending === "function") return queue.readPending().length;
    } catch {
      // logging must never break delivery
    }
    return "unknown";
  }

  noteDeferral(subscriber, reason) {
    const now = this.now();
    const prev = this.deferrals.get(subscriber);
    if (!prev || prev.reason !== reason) {
      // Log once per reason change instead of on every 1s tick.
      this.deferrals.set(subscriber, { reason, sinceMs: now, lastWarnAtMs: 0 });
      this.log(`delivery deferred subscriber=${subscriber} reason=${reason} pending=${this.pendingCount(subscriber)}`);
      return;
    }
    if (now - prev.sinceMs >= this.deferWarnAfterMs && now - prev.lastWarnAtMs >= this.warnIntervalMs) {
      prev.lastWarnAtMs = now;
      this.log(`WARN delivery still deferred subscriber=${subscriber} reason=${reason} pending=${this.pendingCount(subscriber)} deferred_ms=${now - prev.sinceMs}`);
    }
  }

  clearDeferral(subscriber) {
    this.deferrals.delete(subscriber);
  }

  noteGraceOverride(subscriber, activityState) {
    if (this.graceWarned.get(subscriber) === activityState) return;
    this.graceWarned.set(subscriber, activityState);
    this.log(`WARN delivery grace override subscriber=${subscriber} activity_state=${activityState} pending=${this.pendingCount(subscriber)} grace_ms=${this.blockedGraceMs} - agent stuck, delivering anyway`);
  }

  noteLocked(subscriber, lock) {
    const now = this.now();
    const lockedMs = now - lock.sinceMs;
    if (lockedMs >= this.lockedWarnAfterMs && now - lock.lastWarnAtMs >= this.warnIntervalMs) {
      lock.lastWarnAtMs = now;
      this.log(`WARN delivery lock held subscriber=${subscriber} locked_ms=${lockedMs} pending=${this.pendingCount(subscriber)} - previous inject may be stuck, daemon restart may be required`);
    }
  }

  getAgentMeta(subscriber) {
    const data = this.readAgents() || { agents: {} };
    const agents = data.agents && typeof data.agents === "object" ? data.agents : {};
    return {
      agents,
      meta: agents[subscriber] || null,
    };
  }

  shouldDeliver(subscriber) {
    const { meta } = this.getAgentMeta(subscriber);
    if (!meta || meta.status === "inactive") {
      return { ok: false, reason: "missing_or_inactive" };
    }
    const launchMode = String(meta.launch_mode || "").trim();
    const adapter = this.adapterRouter.getAdapter({ launchMode, agentId: subscriber, meta });
    if (!adapter.capabilities.supportsNotifierInjector) {
      return { ok: false, reason: launchMode ? "unsupported_launch_mode" : "missing_launch_mode" };
    }
    const activityState = asState(meta.activity_state);
    if (!isDeliverableActivityState(activityState)) {
      if (activityState === "waiting_input" || activityState === "blocked") {
        const sinceMs = this.resolveBlockedStateSinceMs(subscriber, meta, activityState);
        if (this.now() - sinceMs >= this.blockedGraceMs) {
          return { ok: true, reason: "deliverable", graceOverride: activityState };
        }
      } else {
        this.blockedStateSeen.delete(subscriber);
      }
      return { ok: false, reason: activityState || "unknown_activity_state" };
    }
    this.blockedStateSeen.delete(subscriber);
    return { ok: true, reason: "deliverable" };
  }

  // Prefer meta.activity_since (written on state change); fall back to the
  // first time this scheduler observed the state when the field is missing.
  resolveBlockedStateSinceMs(subscriber, meta, activityState) {
    const parsed = Date.parse(meta && meta.activity_since != null ? String(meta.activity_since) : "");
    if (Number.isFinite(parsed)) return parsed;
    const seen = this.blockedStateSeen.get(subscriber);
    if (seen && seen.state === activityState) return seen.sinceMs;
    const now = this.now();
    this.blockedStateSeen.set(subscriber, { state: activityState, sinceMs: now });
    return now;
  }

  async deliverSubscriber(subscriber) {
    if (!subscriber) return { ok: false, delivered: 0, reason: "missing_subscriber" };
    if (this.locks.has(subscriber)) {
      this.noteLocked(subscriber, this.locks.get(subscriber));
      return { ok: true, delivered: 0, deferred: true, reason: "locked" };
    }

    this.locks.set(subscriber, { sinceMs: this.now(), lastWarnAtMs: 0 });
    try {
      const gate = this.shouldDeliver(subscriber);
      if (!gate.ok) {
        this.noteDeferral(subscriber, gate.reason);
        return { ok: true, delivered: 0, deferred: true, reason: gate.reason };
      }
      if (gate.graceOverride) {
        this.noteGraceOverride(subscriber, gate.graceOverride);
      } else {
        this.graceWarned.delete(subscriber);
      }
      this.clearDeferral(subscriber);

      const queue = this.queueFactory(subscriber);
      const claim = queue.claimNext();
      if (!claim) {
        return { ok: true, delivered: 0, reason: "empty" };
      }

      const evt = claim.event;
      const envelope = normalizeQueueEnvelope(evt || {});
      const delivery = envelope.delivery || {};
      if (delivery.mode !== "inject") {
        queue.completeClaim(claim);
        return { ok: true, delivered: 0, skipped: true, reason: "unsupported_delivery_mode" };
      }
      if (!envelope || envelope.event !== "message" || !envelope.data || typeof envelope.data.message !== "string") {
        queue.completeClaim(claim);
        return { ok: true, delivered: 0, skipped: true, reason: "unsupported_event" };
      }

      if (delivery.gate === "idle") {
        const secondGate = this.shouldDeliver(subscriber);
        if (!secondGate.ok) {
          this.noteDeferral(subscriber, secondGate.reason);
          queue.restoreClaim(claim);
          return { ok: true, delivered: 0, deferred: true, reason: secondGate.reason };
        }
        if (secondGate.graceOverride) this.noteGraceOverride(subscriber, secondGate.graceOverride);
      }

      const { agents } = this.getAgentMeta(subscriber);
      const injectionText = this.buildInjectionText(envelope, subscriber, agents);
      try {
        await this.injector.inject(subscriber, injectionText);
        queue.completeClaim(claim);
        await this.emitDelivery({
          subscriber,
          event: envelope,
          status: "ok",
        });
        return { ok: true, delivered: 1, event: envelope };
      } catch (err) {
        queue.restoreClaim(claim);
        await this.emitDelivery({
          subscriber,
          event: envelope,
          status: "error",
          error: err && err.message ? err.message : String(err || "inject failed"),
        });
        return {
          ok: false,
          delivered: 0,
          reason: "inject_failed",
          error: err && err.message ? err.message : String(err || "inject failed"),
        };
      }
    } finally {
      this.locks.delete(subscriber);
    }
  }

  async deliverTargets(targets = []) {
    const unique = Array.from(new Set((Array.isArray(targets) ? targets : [targets]).filter(Boolean)));
    const results = [];
    for (const subscriber of unique) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await this.deliverSubscriber(subscriber));
    }
    return results;
  }

  listPendingSubscribers() {
    const data = this.readAgents() || { agents: {} };
    const agents = data.agents && typeof data.agents === "object" ? data.agents : {};
    const subscribers = [];
    for (const [subscriber, meta] of Object.entries(agents)) {
      if (!meta || meta.status === "inactive") continue;
      const queue = this.queueFactory(subscriber);
      if (queue.readPending().length > 0) subscribers.push(subscriber);
    }
    return subscribers;
  }

  async tick() {
    const subscribers = this.listPendingSubscribers();
    return this.deliverTargets(subscribers);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const run = () => {
      this.tick().catch((err) => {
        this.log(`delivery scheduler tick failed: ${err && err.message ? err.message : String(err)}`);
      });
    };
    run();
    this.timer = setInterval(run, this.intervalMs);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  DeliveryScheduler,
  isDeliverableActivityState,
};

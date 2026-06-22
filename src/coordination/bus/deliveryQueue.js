const fs = require("fs");
const path = require("path");
const {
  ensureDir,
  appendJSONL,
  generateInstanceId,
  readJSONL,
  writeFileAtomic,
  subscriberToSafeName,
  isPidAlive,
} = require("./utils");

const PROCESSING_STALE_MS = 30000;

function positiveSeq(event) {
  const seq = Number(event && event.seq);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

function eventToJsonl(events = []) {
  const lines = events
    .filter(Boolean)
    .map((event) => JSON.stringify(event));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function readJsonlLoose(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  if (!content.trim()) return [];
  return content.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const QUEUE_TYPES = {
  AGENT_MESSAGE: "agent_message",
  DAEMON_CONTROL: "daemon_control",
  REPORT: "report",
  WAKE: "wake",
  DELIVERY_STATUS: "delivery_status",
  EVENT: "event",
};

function inferQueueType(event = {}) {
  if (event.queue_type) return String(event.queue_type);
  if (event.event === "message") return QUEUE_TYPES.AGENT_MESSAGE;
  if (event.event === "wake") return QUEUE_TYPES.WAKE;
  if (event.event === "delivery") return QUEUE_TYPES.DELIVERY_STATUS;
  if (event.type === "report/control" || event.event === "controller_report") return QUEUE_TYPES.REPORT;
  if (String(event.target || "") === "ufoo-agent") return QUEUE_TYPES.DAEMON_CONTROL;
  return QUEUE_TYPES.EVENT;
}

function defaultDeliveryForType(queueType) {
  if (queueType === QUEUE_TYPES.AGENT_MESSAGE) {
    return { mode: "inject", gate: "idle", max_inflight: 1 };
  }
  if (queueType === QUEUE_TYPES.WAKE) {
    return { mode: "notify_only", gate: "none", max_inflight: 1 };
  }
  if (queueType === QUEUE_TYPES.DAEMON_CONTROL || queueType === QUEUE_TYPES.REPORT || queueType === QUEUE_TYPES.DELIVERY_STATUS) {
    return { mode: "daemon_consume", gate: "none", max_inflight: 1 };
  }
  return { mode: "self_consume", gate: "none", max_inflight: 1 };
}

function defaultAckForType(queueType) {
  if (queueType === QUEUE_TYPES.AGENT_MESSAGE) return { policy: "on_delivery" };
  if (queueType === QUEUE_TYPES.WAKE) return { policy: "fire_and_forget" };
  return { policy: "on_consume" };
}

function normalizeQueueEnvelope(event = {}, overrides = {}) {
  const queueType = overrides.queueType || overrides.queue_type || inferQueueType(event);
  const existingDelivery = event.delivery && typeof event.delivery === "object" ? event.delivery : {};
  const overrideDelivery = overrides.delivery && typeof overrides.delivery === "object" ? overrides.delivery : {};
  const existingAck = event.ack && typeof event.ack === "object" ? event.ack : {};
  const overrideAck = overrides.ack && typeof overrides.ack === "object" ? overrides.ack : {};
  return {
    ...event,
    queue_type: queueType,
    delivery: {
      ...defaultDeliveryForType(queueType),
      ...existingDelivery,
      ...overrideDelivery,
    },
    ack: {
      ...defaultAckForType(queueType),
      ...existingAck,
      ...overrideAck,
    },
  };
}

function stripQueueEnvelope(event = {}) {
  if (!event || typeof event !== "object") return event;
  const stripped = { ...event };
  delete stripped.queue_type;
  delete stripped.delivery;
  delete stripped.ack;
  return stripped;
}

class DeliveryQueue {
  constructor(pendingFile) {
    this.pendingFile = pendingFile;
  }

  static forSubscriber(busDir, subscriber) {
    return new DeliveryQueue(path.join(
      busDir,
      "queues",
      subscriberToSafeName(subscriber),
      "pending.jsonl"
    ));
  }

  queueDir() {
    return path.dirname(this.pendingFile);
  }

  ensureQueueDir() {
    ensureDir(this.queueDir());
  }

  processingPatternPrefix() {
    return `${path.basename(this.pendingFile)}.processing.`;
  }

  processingFiles() {
    const dir = this.queueDir();
    if (!fs.existsSync(dir)) return [];
    const prefix = this.processingPatternPrefix();
    return fs.readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }))
      .map((name) => path.join(dir, name));
  }

  processingFileInfo(filePath) {
    const name = path.basename(filePath || "");
    const escapedBase = path.basename(this.pendingFile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = name.match(new RegExp(`^${escapedBase}\\.processing\\.(\\d+)(?:\\.(\\d+))?`));
    const pid = match ? parseInt(match[1], 10) : NaN;
    const timestamp = match && match[2] ? parseInt(match[2], 10) : NaN;
    return {
      pid: Number.isFinite(pid) && pid > 0 ? pid : 0,
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0,
    };
  }

  isRecoverableProcessingFile(filePath, options = {}) {
    const maxAgeMs = Number.isFinite(options.maxAgeMs) ? options.maxAgeMs : PROCESSING_STALE_MS;
    const info = this.processingFileInfo(filePath);
    if (info.pid > 0) return !isPidAlive(info.pid);
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return false;

    const now = Date.now();
    if (info.timestamp > 0 && now - info.timestamp >= maxAgeMs) return true;

    try {
      const stat = fs.statSync(filePath);
      return Boolean(stat && stat.isFile() && now - stat.mtimeMs >= maxAgeMs);
    } catch {
      return false;
    }
  }

  readPending() {
    this.recover();
    return readJSONL(this.pendingFile);
  }

  readPendingRaw() {
    return readJSONL(this.pendingFile);
  }

  append(event) {
    if (!event) return;
    this.ensureQueueDir();
    appendJSONL(this.pendingFile, normalizeQueueEnvelope(event));
  }

  writePending(events = []) {
    this.ensureQueueDir();
    const items = Array.isArray(events) ? events.filter(Boolean) : [];
    if (items.length === 0) {
      try {
        fs.rmSync(this.pendingFile, { force: true });
      } catch {
        // ignore cleanup errors
      }
      return;
    }
    writeFileAtomic(this.pendingFile, eventToJsonl(items));
  }

  mergeAndSort(events = []) {
    const sequenced = new Map();
    const unsequenced = [];
    for (const event of events) {
      if (!event) continue;
      const seq = positiveSeq(event);
      if (seq > 0) {
        if (!sequenced.has(seq)) sequenced.set(seq, event);
      } else {
        unsequenced.push(event);
      }
    }
    return [
      ...Array.from(sequenced.entries())
        .sort(([a], [b]) => a - b)
        .map(([, event]) => event),
      ...unsequenced,
    ];
  }

  recover(options = {}) {
    const files = this.processingFiles()
      .filter((file) => this.isRecoverableProcessingFile(file, options));
    if (files.length === 0) return { recovered: 0, files: [] };

    const all = [...this.readPendingRaw()];
    for (const file of files) {
      all.push(...readJsonlLoose(file));
    }

    const merged = this.mergeAndSort(all);
    this.writePending(merged);

    for (const file of files) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }

    return { recovered: merged.length, files };
  }

  claimNext() {
    this.recover();
    const pending = this.readPendingRaw();
    if (pending.length === 0) return null;

    const event = pending[0];
    const remaining = pending.slice(1);
    const processingFile = `${this.pendingFile}.processing.${process.pid}.${Date.now()}.${generateInstanceId()}`;
    this.ensureQueueDir();
    writeFileAtomic(processingFile, eventToJsonl([event]));
    this.writePending(remaining);

    return {
      event,
      processingFile,
      pendingFile: this.pendingFile,
    };
  }

  completeClaim(claim) {
    const processingFile = claim && claim.processingFile;
    if (!processingFile) return false;
    try {
      if (fs.existsSync(processingFile)) {
        fs.rmSync(processingFile, { force: true });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  restoreClaim(claim) {
    const event = claim && claim.event;
    const processingFile = claim && claim.processingFile;
    if (!event) return false;

    const merged = this.mergeAndSort([event, ...this.readPendingRaw()]);
    this.writePending(merged);
    if (processingFile) {
      try {
        fs.rmSync(processingFile, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    return true;
  }
}

module.exports = {
  DeliveryQueue,
  QUEUE_TYPES,
  normalizeQueueEnvelope,
  stripQueueEnvelope,
  inferQueueType,
  positiveSeq,
};

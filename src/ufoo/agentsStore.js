const { getTimestamp, readJSON, writeJSON } = require("../bus/utils");

const AGENTS_SCHEMA_VERSION = 1;

function toSafeString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeAgentEntry(id, meta = {}) {
  let normalizedId = String(id || "");
  const doublePrefix = normalizedId.match(/^([^:]+):\1:(.+)$/);
  if (doublePrefix) {
    normalizedId = `${doublePrefix[1]}:${doublePrefix[2]}`;
  }
  const underscorePrefix = normalizedId.match(/^([^:]+):\1_(.+)$/);
  if (underscorePrefix) {
    normalizedId = `${underscorePrefix[1]}:${underscorePrefix[2]}`;
  }

  const normalizedMeta = meta && typeof meta === "object" ? { ...meta } : {};
  if (normalizedMeta.nickname && typeof normalizedMeta.nickname === "object") {
    const leakedOptions = normalizedMeta.nickname;
    normalizedMeta.nickname = "";
    if (!normalizedMeta.launch_mode) {
      normalizedMeta.launch_mode = toSafeString(leakedOptions.launchMode);
    }
    if (!normalizedMeta.tmux_pane) {
      normalizedMeta.tmux_pane = toSafeString(leakedOptions.tmuxPane);
    }
    if (!normalizedMeta.tty) {
      normalizedMeta.tty = toSafeString(leakedOptions.tty);
    }
    if (
      (!Number.isFinite(Number(normalizedMeta.pid)) || Number(normalizedMeta.pid) <= 0)
      && Number.isFinite(leakedOptions.parentPid)
      && leakedOptions.parentPid > 0
    ) {
      normalizedMeta.pid = leakedOptions.parentPid;
    }
  }

  return { id: normalizedId, meta: normalizedMeta };
}

function normalizeAgentsMap(agents = {}) {
  const out = {};
  for (const [rawId, rawMeta] of Object.entries(agents || {})) {
    const { id, meta } = normalizeAgentEntry(rawId, rawMeta);
    if (!id) continue;
    if (!out[id]) {
      out[id] = meta;
      continue;
    }
    const current = out[id] || {};
    const incoming = meta || {};
    const currentActive = current.status === "active";
    const incomingActive = incoming.status === "active";
    if (incomingActive && !currentActive) {
      out[id] = incoming;
      continue;
    }
    const currentSeen = String(current.last_seen || current.joined_at || "");
    const incomingSeen = String(incoming.last_seen || incoming.joined_at || "");
    if (incomingSeen > currentSeen) {
      out[id] = incoming;
    }
  }
  return out;
}

function normalizeAgentsData(data) {
  const base = data && typeof data === "object" ? { ...data } : {};
  const { subscribers: _legacy, ...rest } = base;
  const agents = normalizeAgentsMap(
    base.agents && typeof base.agents === "object" ? base.agents : {}
  );
  const createdAt = typeof base.created_at === "string" && base.created_at
    ? base.created_at
    : getTimestamp();

  return {
    ...rest,
    schema_version: AGENTS_SCHEMA_VERSION,
    created_at: createdAt,
    agents,
  };
}

function loadAgentsData(filePath) {
  const data = readJSON(filePath, null);
  if (!data) {
    return normalizeAgentsData({});
  }
  return normalizeAgentsData(data);
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function mergeExternalActivityFields(targetMeta, diskMeta) {
  if (!targetMeta || !diskMeta) return;

  const diskState = toSafeString(diskMeta.activity_state);
  if (!diskState) return;

  const memoryState = toSafeString(targetMeta.activity_state);
  const diskSince = toSafeString(diskMeta.activity_since);
  const memorySince = toSafeString(targetMeta.activity_since);
  const diskSinceMs = parseTimestampMs(diskSince);
  const memorySinceMs = parseTimestampMs(memorySince);

  if (!memoryState) {
    targetMeta.activity_state = diskState;
    if (diskSince) targetMeta.activity_since = diskSince;
    return;
  }

  const preferDisk = Number.isFinite(diskSinceMs)
    && (!Number.isFinite(memorySinceMs) || diskSinceMs > memorySinceMs);
  if (preferDisk) {
    targetMeta.activity_state = diskState;
    targetMeta.activity_since = diskSince;
  }
}

function saveAgentsData(filePath, data) {
  const normalized = normalizeAgentsData(data);

  // Merge externally-managed fields from disk to avoid daemon in-memory writes
  // overwriting fresher runner/notifier state updates.
  const disk = readJSON(filePath, null);
  if (disk && disk.agents && normalized.agents) {
    for (const [id, diskMeta] of Object.entries(disk.agents)) {
      if (!diskMeta || typeof diskMeta !== "object") continue;
      const targetMeta = normalized.agents[id];
      if (!targetMeta || typeof targetMeta !== "object") continue;
      mergeExternalActivityFields(targetMeta, diskMeta);
    }
  }

  writeJSON(filePath, normalized);
}

module.exports = {
  AGENTS_SCHEMA_VERSION,
  loadAgentsData,
  saveAgentsData,
  normalizeAgentsData,
};

function buildAgentMaps(activeAgents = [], metaList = [], fallbackMap = null) {
  const labelMap = new Map();
  const metaMap = new Map();
  const metaById = new Map();

  for (const meta of metaList) {
    if (!meta || !meta.id) continue;
    metaById.set(meta.id, meta);
  }

  for (const id of activeAgents) {
    const meta = metaById.get(id);
    const label = meta && (meta.display_nickname || meta.nickname)
      ? (meta.display_nickname || meta.nickname)
      : (fallbackMap && fallbackMap.get(id)) || id;
    labelMap.set(id, label);
    if (meta) {
      metaMap.set(id, meta);
    }
  }

  return { labelMap, metaMap };
}

function getAgentLabel(labelMap, agentId) {
  return labelMap.get(agentId) || agentId;
}

function resolveAgentId({ label, activeAgents = [], labelMap = new Map(), lookupNickname = null }) {
  if (!label) return null;
  if (activeAgents.includes(label)) return label;

  for (const [id, name] of labelMap.entries()) {
    if (name === label) return id;
  }

  if (typeof lookupNickname === "function") {
    const resolved = lookupNickname(label);
    if (resolved) return resolved;
  }

  return null;
}

function resolveAgentDisplayName({ publisher, labelMap = new Map(), lookupNicknameById = null }) {
  let displayName = publisher;
  if (publisher && publisher.includes(":")) {
    if (labelMap && labelMap.has(publisher)) {
      displayName = labelMap.get(publisher);
    } else if (typeof lookupNicknameById === "function") {
      const resolved = lookupNicknameById(publisher);
      if (resolved) displayName = resolved;
    }
  }
  return displayName;
}

function clampAgentWindowWithSelection({
  activeCount = 0,
  maxWindow = 4,
  windowStart = 0,
  selectionIndex = -1,
}) {
  if (activeCount <= 0) {
    return 0;
  }
  const maxItems = Math.max(1, Math.min(maxWindow, activeCount));
  let nextStart = windowStart;
  if (selectionIndex >= 0) {
    if (selectionIndex < nextStart) {
      nextStart = selectionIndex;
    } else if (selectionIndex >= nextStart + maxItems) {
      nextStart = selectionIndex - maxItems + 1;
    }
  }
  const maxStart = Math.max(0, activeCount - maxItems);
  if (nextStart > maxStart) nextStart = maxStart;
  if (nextStart < 0) nextStart = 0;
  return nextStart;
}

/**
 * Normalize daemon STATUS payload into agents list + footer string.
 * Shared by Ink dashboard and Rust `agents.snapshot`.
 */
function normalizeStatusToAgentsSnapshot(data = {}) {
  const activeIds = Array.isArray(data.active) ? data.active : [];
  const metaList = Array.isArray(data.active_meta) ? data.active_meta : [];
  const { labelMap, metaMap } = buildAgentMaps(activeIds, metaList);
  const agents = activeIds.map((id) => {
    const meta = metaMap.get(id) || {};
    const colon = String(id).indexOf(":");
    const fallbackType = colon > 0 ? String(id).slice(0, colon) : String(id);
    const fallbackId = colon > 0 ? String(id).slice(colon + 1) : "";
    const label = labelMap.get(id) || id;
    const activity = String(meta.activity_state || "").trim();
    return {
      ...meta,
      id,
      fullId: id,
      label,
      type: meta.type || fallbackType,
      agentId: meta.id || fallbackId,
      nickname: label,
      activity_state: activity,
      activity_detail: String(meta.activity_detail || ""),
      launch_mode: meta.launch_mode || meta.launchMode || "",
    };
  });
  const footer = agents.length === 0
    ? "no agents"
    : agents.map((agent) => {
      const mark = agent.activity_state === "working" ? "*"
        : agent.activity_state === "waiting_input" ? "?"
          : agent.activity_state === "blocked" ? "!"
            : "";
      return mark ? `${mark}${agent.label}` : agent.label;
    }).join(" · ");
  return {
    agents,
    footer,
    labelMap,
    metaMap,
    cron: data.cron || null,
    loop: data.loop || null,
  };
}

/**
 * Ink chatReducer expects `id` as the short agent id and `fullId` as the key.
 * Shared so ChatController and ChatApp stay aligned.
 */
function toInkAgentsDispatchList(snapshot = {}) {
  const agents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  return agents.map((row) => ({
    ...row,
    fullId: row.fullId || row.id,
    id: row.agentId || row.id,
    nickname: row.label || row.nickname,
  }));
}

module.exports = {
  buildAgentMaps,
  getAgentLabel,
  resolveAgentId,
  resolveAgentDisplayName,
  clampAgentWindowWithSelection,
  normalizeStatusToAgentsSnapshot,
  toInkAgentsDispatchList,
};

"use strict";

const INTERNAL_AGENT_TYPES = Object.freeze(["codex", "claude", "ucode", "agy"]);

function isAcpAgentType(value = "") {
  const type = String(value || "").trim().toLowerCase();
  return (type.startsWith("acp:") && type.length > 4) || (type.startsWith("acp-") && type.length > 4);
}

function extractAcpAgentId(value = "") {
  const type = String(value || "").trim().toLowerCase();
  if (type.startsWith("acp:")) return type.slice(4).replace(/[^a-z0-9._-]/g, "");
  if (type.startsWith("acp-")) return type.slice(4).replace(/[^a-z0-9._-]/g, "");
  return "";
}

function normalizeInternalAgentType(value = "") {
  const type = String(value || "").trim().toLowerCase();
  if (type === "claude-code") return "claude";
  if (type === "antigravity" || type === "agy-cli" || type === "acp:agy" || type === "acp-agy") return "agy";
  if (INTERNAL_AGENT_TYPES.includes(type)) return type;
  if (isAcpAgentType(type)) {
    const id = extractAcpAgentId(type);
    return id ? `acp-${id}` : "";
  }
  return "";
}

function isInternalAgentMeta(meta = {}) {
  if (!meta || String(meta.launch_mode || meta.launchMode || "").trim().toLowerCase() !== "internal") return false;
  return Boolean(normalizeInternalAgentType(meta.agent_type || meta.type || String(meta.id || "").split(":")[0]));
}

function isInternalDashboardEvent(data = {}, getMeta = () => null) {
  const agentId = data.event === "activity_state_changed"
    ? data.subscriber || data.publisher
    : data.report?.agent_id || data.publisher;
  if (agentId === "ufoo-agent" || String(agentId || "").endsWith(":ufoo-agent")) {
    return !data.target || data.target === "ufoo-agent" || isInternalAgentMeta(getMeta(data.target));
  }
  return isInternalAgentMeta(getMeta(agentId));
}

module.exports = {
  INTERNAL_AGENT_TYPES,
  isAcpAgentType,
  extractAcpAgentId,
  normalizeInternalAgentType,
  isInternalAgentMeta,
  isInternalDashboardEvent,
};

"use strict";

const INTERNAL_AGENT_TYPES = Object.freeze(["codex", "claude", "ucode"]);

function normalizeInternalAgentType(value = "") {
  const type = String(value || "").trim().toLowerCase();
  if (type === "claude-code") return "claude";
  return INTERNAL_AGENT_TYPES.includes(type) ? type : "";
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

module.exports = { INTERNAL_AGENT_TYPES, normalizeInternalAgentType, isInternalAgentMeta, isInternalDashboardEvent };

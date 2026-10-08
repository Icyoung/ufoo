"use strict";

function isInternalAgentMeta(meta = {}) {
  return Boolean(meta) && String(meta.launch_mode || meta.launchMode || "").trim().toLowerCase() === "internal";
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

module.exports = { isInternalAgentMeta, isInternalDashboardEvent };

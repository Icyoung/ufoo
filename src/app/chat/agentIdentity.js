"use strict";

/**
 * Agent label / id resolution for chat (Phase 0B extraction).
 */

function getAgentLabelFor(meta, agentId) {
  if (meta && meta.display_nickname) return meta.display_nickname;
  if (meta && meta.nickname) return meta.nickname;
  if (!agentId) return "";
  const colon = agentId.indexOf(":");
  if (colon < 0) return agentId;
  const head = agentId.slice(0, colon);
  const tail = agentId.slice(colon + 1).slice(0, 6);
  return tail ? `${head}:${tail}` : head;
}

function buildActiveAgentLabelMap(activeAgents = [], activeAgentMeta = new Map()) {
  const out = new Map();
  const metaMap = activeAgentMeta instanceof Map ? activeAgentMeta : new Map();
  for (const id of Array.isArray(activeAgents) ? activeAgents : []) {
    out.set(id, getAgentLabelFor(metaMap.get(id), id));
  }
  return out;
}

function resolveActiveAgentId(label, activeAgents = [], activeAgentMeta = new Map()) {
  const { resolveAgentId } = require("./agentDirectory");
  const metaMap = activeAgentMeta instanceof Map ? activeAgentMeta : new Map();
  return resolveAgentId({
    label,
    activeAgents: Array.isArray(activeAgents) ? activeAgents : [],
    labelMap: buildActiveAgentLabelMap(activeAgents, metaMap),
    lookupNickname: (nickname) => {
      for (const [id, meta] of metaMap.entries()) {
        if (!meta) continue;
        if (meta.nickname === nickname || meta.scoped_nickname === nickname || meta.display_nickname === nickname) {
          return id;
        }
      }
      return null;
    },
  });
}

module.exports = {
  getAgentLabelFor,
  buildActiveAgentLabelMap,
  resolveActiveAgentId,
};

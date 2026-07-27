"use strict";

/**
 * Agent enter / dashboard navigation helpers (Phase 0B extraction).
 */

const path = require("path");

function resolveInjectSockPathForAgent(projectRoot, agentId) {
  const { getUfooPaths } = require("../../coordination/state/paths");
  const { subscriberToSafeName } = require("../../coordination/bus/utils");
  const safeName = subscriberToSafeName(agentId);
  return path.join(getUfooPaths(projectRoot || process.cwd()).busQueuesDir, safeName, "inject.sock");
}

function resolveAgentEnterRequest({
  agentId,
  projectRoot = "",
  activeAgentMeta = new Map(),
  settings = {},
} = {}) {
  const id = String(agentId || "").trim();
  if (!id) return null;

  const metaMap = activeAgentMeta instanceof Map ? activeAgentMeta : new Map();
  const meta = metaMap.get(id) || {};
  const configuredLaunchMode = settings && settings.launchMode && settings.launchMode !== "auto"
    ? settings.launchMode
    : "";
  const launchMode = String(meta.launch_mode || meta.launchMode || configuredLaunchMode || "").trim();
  const { createTerminalAdapterRouter } = require("../../runtime/terminal/adapterRouter");
  const adapter = createTerminalAdapterRouter().getAdapter({ launchMode, agentId: id, meta });
  const caps = adapter && adapter.capabilities ? adapter.capabilities : {};

  return {
    agentId: id,
    projectRoot: String(projectRoot || ""),
    launchMode,
    useBus: Boolean(caps.supportsInternalQueueLoop && !caps.supportsSocketProtocol),
    supportsSocket: Boolean(caps.supportsSocketProtocol),
    supportsInternalQueue: Boolean(caps.supportsInternalQueueLoop),
    supportsActivate: Boolean(caps.supportsActivate),
  };
}

function resolveDashboardAgentEnterAction(enterRequest = {}) {
  if (!enterRequest || typeof enterRequest !== "object") return "none";
  if (enterRequest.useBus) return "internal";
  if (enterRequest.supportsActivate) return "activate";
  // No PTY mirror fallback — host must expose activate (or use terminal/tmux/internal).
  return "none";
}

function buildEmptyProjectsDownActions(state = {}, displayAgents = []) {
  if (!state.emptyProjectsDownArmed) {
    return [{ type: "projects/armEmptyDown" }];
  }
  const actions = [{ type: "view/set", view: "agents" }];
  if (displayAgents.length > 0 && state.selectedAgentIndex < 0) {
    actions.push({ type: "agents/select", index: 0 });
  }
  return actions;
}

module.exports = {
  resolveInjectSockPathForAgent,
  resolveAgentEnterRequest,
  resolveDashboardAgentEnterAction,
  buildEmptyProjectsDownActions,
};

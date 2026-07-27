"use strict";

/**
 * Chat → daemon IPC request builders (Phase 0B extraction).
 */

const { resolveActiveAgentId } = require("./agentIdentity");

function buildDirectBusSendRequest({
  text,
  targetAgentId = null,
  activeAgents = [],
  activeAgentMeta = new Map(),
} = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (targetAgentId) {
    return {
      target: targetAgentId,
      message: trimmed,
      source: "chat-direct",
    };
  }

  const { parseAtTarget } = require("./commands");
  const atTarget = parseAtTarget(trimmed);
  if (!atTarget || !atTarget.message) return null;
  const target = resolveActiveAgentId(atTarget.target, activeAgents, activeAgentMeta) || atTarget.target;
  return {
    target,
    message: atTarget.message.trim(),
    source: "chat-direct",
  };
}

function buildPromptIpcRequest(text) {
  const { IPC_REQUEST_TYPES } = require("../../runtime/contracts/eventContract");
  return {
    type: IPC_REQUEST_TYPES.PROMPT,
    text,
    request_meta: {
      source: "chat-dialog",
      dispatch_default_injection_mode: "immediate",
      allow_relevance_queue: true,
    },
  };
}

module.exports = {
  buildDirectBusSendRequest,
  buildPromptIpcRequest,
};

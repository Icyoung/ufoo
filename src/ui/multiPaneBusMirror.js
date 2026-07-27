"use strict";

/**
 * Mirror inbound bus events into multi/side internal panes.
 * Rust host uses this so pane VT stays live while the main transcript
 * router still runs.
 */

function parseInternalBusPayload(raw = "") {
  let displayMessage = String(raw || "");
  let streamPayload = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.reply) {
      displayMessage = parsed.reply;
    } else if (parsed && typeof parsed === "object" && parsed.stream) {
      streamPayload = parsed;
    }
  } catch {
    // Plain text.
  }
  return {
    displayMessage: String(displayMessage || "")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n"),
    streamPayload,
  };
}

function internalStatusLabel(value = "") {
  const state = String(value || "").trim().toLowerCase();
  if (state === "waiting" || state === "waiting_input") return "waiting";
  if (state === "blocked" || state === "error") return "blocked";
  if (state === "busy" || state === "processing" || state === "working") return "working";
  if (state === "idle" || state === "ready") return "ready";
  return state || "ready";
}

function buildAgentAliases(agentId, getMeta = () => ({})) {
  const meta = (() => {
    try { return getMeta(agentId) || {}; } catch { return {}; }
  })();
  return new Set([
    agentId,
    meta.nickname,
    meta.scoped_nickname,
    meta.display_nickname,
    meta.fullId,
    meta.id,
  ].filter(Boolean).map(String));
}

/**
 * @param {object} data — bus event payload (msg.data)
 * @param {object} options
 * @param {Iterable<string>|Set<string>} options.agentIds — internal pane agents to mirror
 * @param {(agentId: string) => object} [options.getMeta]
 * @param {(agentId: string, text: string) => boolean|void} options.writeToPane
 * @returns {boolean} true if at least one pane consumed the event
 */
function writeMultiPaneBusEvent(data = {}, options = {}) {
  const {
    agentIds = [],
    getMeta = () => ({}),
    writeToPane = () => false,
  } = options;

  const watched = agentIds instanceof Set
    ? agentIds
    : new Set([...agentIds].map((id) => String(id || "").trim()).filter(Boolean));
  if (!watched.size || typeof writeToPane !== "function") return false;

  let handled = false;
  for (const agentId of watched) {
    const aliases = buildAgentAliases(agentId, getMeta);
    const publisher = String(data.publisher || (data.event === "broadcast" ? "broadcast" : "bus"));
    const target = String(data.target || data.subscriber || "");
    const fromAgent = aliases.has(publisher);
    const toAgent = aliases.has(target) || aliases.has(String(data.subscriber || ""));
    if (!fromAgent && !toAgent) continue;

    if (data.silent) {
      handled = true;
      continue;
    }
    // Echo of chat→agent sends already shown as local "> " input.
    if ((data.source === "chat-internal-agent-view" || data.source === "rust-multi-window"
      || data.source === "chat-direct") && toAgent && !fromAgent) {
      handled = true;
      continue;
    }
    if (data.event === "activity_state_changed") {
      const state = internalStatusLabel(data.state || data.activity_state || "");
      const detail = String(data.detail || (data.data && data.data.detail) || data.message || "").trim();
      try {
        writeToPane(agentId, `\r\n[${state}${detail ? ` · ${detail}` : ""}]\r\n`);
      } catch { /* ignore */ }
      handled = true;
      continue;
    }

    const { displayMessage, streamPayload } = parseInternalBusPayload(data.message || "");
    if (streamPayload) {
      if (!fromAgent) {
        handled = true;
        continue;
      }
      const delta = typeof streamPayload.delta === "string"
        ? streamPayload.delta.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\r/g, "\n")
        : "";
      try {
        if (delta) writeToPane(agentId, delta);
        if (streamPayload.done) writeToPane(agentId, "\r\n");
      } catch { /* ignore */ }
      handled = true;
      continue;
    }
    if (!displayMessage) {
      handled = true;
      continue;
    }
    const prefix = fromAgent ? "* " : "> ";
    try {
      writeToPane(agentId, `${prefix}${displayMessage.replace(/\n/g, "\r\n  ")}\r\n`);
    } catch { /* ignore */ }
    handled = true;
  }
  return handled;
}

module.exports = {
  parseInternalBusPayload,
  internalStatusLabel,
  buildAgentAliases,
  writeMultiPaneBusEvent,
};

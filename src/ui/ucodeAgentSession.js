"use strict";

const { createRustMultiSession } = require("./rustMultiSession");
const { loadAgentsData } = require("../coordination/state/agentsStore");
const { getUfooPaths } = require("../coordination/state/paths");
const { isMetaActive } = require("../coordination/bus/utils");
const { isInternalAgentMeta } = require("../runtime/contracts/agentMode");
const { dispatchMessageHandler } = require("../tools/handlers/dispatchMessage");

function createUcodeAgentSession({ projectRoot, getSubscriber, publish, send = dispatchMessageHandler,
  requestDaemon = require("../app/chat/transport").requestDaemon } = {}) {
  let selected = "";
  const meta = (id) => loadAgentsData(getUfooPaths(projectRoot).agentsFile).agents?.[id];
  const active = (id) => id && id !== getSubscriber() && id !== "ufoo-agent" && isMetaActive(meta(id));
  const label = (id) => { const row = meta(id); return row?.display_nickname || row?.nickname || id; };
  async function sendMessage(id, text) {
    if (!active(id)) return { ok: false, error: "Unknown or inactive target" };
    const result = await send({ projectRoot, subscriber: getSubscriber() }, { target: id, message: text });
    if (!result?.ok) throw new Error(result?.error || "Message delivery failed");
    return result;
  }
  const multi = createRustMultiSession({ projectRoot,
    getActiveAgents: () => Object.keys(loadAgentsData(getUfooPaths(projectRoot).agentsFile).agents || {}).filter(active),
    getAgentMeta: meta, getLabel: label, publish,
    resolvePaneOptions: id => ({ mode: "internal", initialEntries:
      require("../app/chat/internalAgentLogHistory").loadInternalAgentTranscript(projectRoot, id, { maxEvents: 200, maxEntries: 200 }) || [] }),
    onInternalSubmit: async (id, text) => {
      const result = await sendMessage(id, text);
      if (!result.ok) throw new Error(result.error);
      return result;
    },
  });
  function select(id) {
    if (id && !active(id)) return { ok: false, error: "Unknown or inactive target" };
    selected = id;
    if (id) multi.handleFocus({ target: "chat" });
    publish("prompt.set_prefix", { prefix: id ? `›@${label(id)} ` : "› " });
    return { ok: true, agent_id: id, mode: "message" };
  }
  function open(id) {
    if (!active(id)) return { ok: false, error: "Unknown or inactive target" };
    if (!isInternalAgentMeta(meta(id))) return select(id);
    const result = multi.start({ kind: "side", agentIds: [id], focus: { target: "agent", agent_id: id } });
    if (result.ok) select("");
    return result;
  }
  async function handleCommand(name, payload = {}) {
    const id = String(payload.agent_id || payload.agentId || "").trim();
    if (name === "agent.select") return select(id);
    if (name === "agent.open") return open(id);
    if (name === "agent.close") {
      if (!active(id) || !isInternalAgentMeta(meta(id))) return { ok: false, error: "Unknown active internal agent" };
      try {
        const response = await requestDaemon(projectRoot, { type: "close_agent", agent_id: id }, {
          retries: 1, timeoutMs: 10000, fullResponse: true,
        });
        const result = response?.opsResults?.find(row => row.action === "close");
        if (!result || result.ok === false) return { ok: false, error: result?.error || response?.data?.reply || "Agent close was not confirmed" };
        if (selected === id) select("");
        multi.syncAgents();
        return { ok: true, agent_id: id };
      } catch (error) { return { ok: false, error: error.message || "Agent close failed" }; }
    }
    if (name === "window.set" || name === "window.cycle") {
      if (payload.session_id && payload.session_id !== multi.getSessionId()) return { ok: false, error: "stale session_id" };
      return multi.setLayout(name === "window.cycle" ? "cycle" : payload.mode);
    }
    const methods = { "multi.focus": "handleFocus", "multi.raw": "handleRaw", "multi.viewport": "handleViewport",
      "multi.scroll": "handleScroll", "multi.expand": "handleExpand", "multi.cancel": "handleCancel" };
    if (methods[name]) return multi[methods[name]](payload);
    return null;
  }
  async function submit(payload = {}) {
    const explicit = String(payload.target_agent || payload.targetAgent || "").trim();
    const target = explicit || (payload.input_target === "main" ? "" : selected);
    if (payload.has_target && !explicit) return { ok: false, error: "Unknown or inactive target" };
    if (!target) return null;
    if (!active(target)) return { ok: false, error: "Unknown or inactive target" };
    const text = String(payload.text || "").trim();
    if (!text) return open(target);
    const result = await sendMessage(target, text);
    return { ...result, routed: "agent", agent_id: target };
  }
  return { handleCommand, submit, getSnapshot: multi.getSnapshot, refresh: () => multi.syncAgents(),
    publishFrames: multi.publishFrames, stop: () => multi.stop({ clearDrafts: true }) };
}

module.exports = { createUcodeAgentSession };

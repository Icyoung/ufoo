"use strict";

const { loadConfig } = require("../config");
const { listAgentModels, confirmAgentModel } = require("../agents/providers/modelSettings");
const { suggestThinkingLevels, normalizeThinkingLevel } = require("../agents/providers/thinkingLevels");

const MODEL_COMMAND = "/settings agent model";
const THINKING_COMMAND = "/settings agent thinking";

function createAgentSettingsController({ getProjectRoot, applyPatch, publish, focusMain = () => {}, logMessage = () => {},
  listModels = listAgentModels, confirmModel = confirmAgentModel } = {}) {
  let draft = null;
  function ask(stage) {
    draft.stage = stage;
    const config = loadConfig(draft.root);
    const prompts = {
      url: `Custom API URL${config.agentBaseUrl ? ` (Enter keeps ${config.agentBaseUrl})` : ""}`,
      key: "Custom API key (hidden; Enter keeps the saved key, '-' clears it)",
      model: "Model ID for the current provider",
    };
    publish("interaction.request", { id: `settings-${stage}`, kind: "settings", prompt: prompts[stage],
      secret: stage === "key", lines: [prompts[stage], "Enter save · Esc cancel"] });
  }
  function open(section) {
    focusMain();
    if (section === "custom" || section === "manual") {
      draft = { root: getProjectRoot(), values: {} };
      ask(section === "custom" ? "url" : "model");
    } else {
      publish("prompt.set_text", { text: `${section === "thinking" ? THINKING_COMMAND : MODEL_COMMAND} `, preserve_draft: true });
    }
    return { ok: true };
  }
  async function applyModel(model, thinking = "") {
    if (!model) return { ok: false, error: "Model ID is required" };
    if (model === "<manual>") return open("manual");
    if (thinking && !normalizeThinkingLevel(thinking)) return { ok: false, error: "Unknown thinking level" };
    const root = getProjectRoot();
    let confirmation;
    try { confirmation = await confirmModel(root, model); }
    catch (error) { return { ok: false, error: error.message }; }
    if (root !== getProjectRoot()) return { ok: false, error: "The active workspace changed. Try again." };
    if (!confirmation.allowed) return { ok: false, error: confirmation.error };
    const result = await applyPatch({ agent_model: model, ...(thinking ? { agent_thinking: thinking } : {}) });
    if (result.ok) {
      if (confirmation.warning) logMessage("system", "Model catalog unavailable; saved the supplied model ID.");
      publish("prompt.restore", {});
    }
    return result;
  }
  async function respond(payload) {
    if (!draft) return null;
    if (draft.root !== getProjectRoot() || payload.cancelled) {
      draft = null;
      publish("interaction.clear", {});
      return { ok: true, cancelled: true };
    }
    if (payload.id !== `settings-${draft.stage}`) return { ok: false, error: "Stale settings input" };
    const text = String(payload.text || "").trim();
    if (draft.stage === "url") {
      const urlText = text || loadConfig(draft.root).agentBaseUrl;
      try {
        const url = new URL(urlText);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
      } catch {
        logMessage("error", "Enter an http(s) API URL without embedded credentials.");
        ask("url");
        return { ok: false, error: "Invalid API URL" };
      }
      draft.values.agent_base_url = urlText;
      ask("key");
      return { ok: true };
    }
    if (draft.stage === "key") {
      const patch = { ...draft.values, agent_provider: "custom" };
      if (text) patch.agent_api_key = text === "-" ? "" : text;
      const result = await applyPatch(patch);
      if (!result.ok) { ask("key"); return result; }
      draft = null;
      publish("interaction.clear", {});
      return open("model");
    }
    const result = await applyModel(text);
    if (!result.ok) { logMessage("error", result.error); ask("model"); return result; }
    draft = null;
    publish("interaction.clear", {});
    return open("thinking");
  }
  async function completions(text) {
    const query = text.trimStart();
    const modelCommand = /^\/model(?:\s|$)/.test(query) ? "/model"
      : /^\/settings\s+agent\s+model(?:\s|$)/.test(query) ? MODEL_COMMAND : "";
    if (!modelCommand && !/^\/settings\s+agent\s+thinking(?:\s|$)/.test(query)) return {};
    const root = getProjectRoot();
    const config = loadConfig(root);
    const thinking = suggestThinkingLevels({ current: config.agentThinking });
    const lists = { [THINKING_COMMAND]: thinking };
    if (modelCommand) {
      lists[`${modelCommand}/thinking`] = thinking;
      const listed = await listModels(root).catch((error) => ({ ok: false, error: error.message }));
      const ids = listed.ok ? listed.models.slice() : [];
      if (config.agentModel && (!listed.ok || listed.allowUnlistedModels) && !ids.includes(config.agentModel)) {
        ids.unshift(config.agentModel);
      }
      lists[modelCommand] = ids.map((id) => ({ id, hasChildren: true, desc: id === config.agentModel ? "current · choose thinking" : "choose thinking" }));
      lists[modelCommand].push({ id: "<manual>", label: "Enter model ID", hasChildren: false,
        desc: listed.ok ? "Configure a model by ID" : "Catalog unavailable · enter model ID" });
    }
    return lists;
  }
  return { open, respond, completions, applyModel };
}

module.exports = { createAgentSettingsController, MODEL_COMMAND, THINKING_COMMAND };

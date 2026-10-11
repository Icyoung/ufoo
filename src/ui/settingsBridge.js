"use strict";

/**
 * Dashboard settings snapshots never carry provider credentials.
 */

const PROVIDER_OPTIONS = Object.freeze([
  { label: "codex", value: "codex-cli" },
  { label: "claude", value: "claude-cli" },
  { label: "agy", value: "agy-cli" },
  { label: "kimi", value: "kimi-cli" },
  { label: "grok", value: "grok-cli" },
  { label: "custom", value: "custom" },
]);

function buildSettingsSnapshot(settings = {}) {
  const { normalizeAgentProvider } = require("../config");
  const agentProvider = normalizeAgentProvider(settings.agentProvider || "codex-cli");
  return {
    agent_provider: agentProvider,
    agent_model: settings.agentModel || "",
    agent_thinking: settings.agentThinking || "medium",
    custom_base_url: settings.agentBaseUrl || "",
    custom_key_set: Boolean(settings.agentApiKey),
    provider_options: PROVIDER_OPTIONS.map((opt) => ({ ...opt })),
  };
}

function applySettingsPatch(projectRoot, patch = {}) {
  const { loadConfig, saveConfig, normalizeAgentProvider, defaultAgentModelForProvider } = require("../config");
  const { normalizeThinkingLevel } = require("../agents/providers/thinkingLevels");
  const current = loadConfig(projectRoot);
  const next = {};
  if (patch.agent_provider != null || patch.agentProvider != null) {
    next.agentProvider = normalizeAgentProvider(patch.agent_provider || patch.agentProvider);
    if (next.agentProvider !== current.agentProvider) next.agentModel = defaultAgentModelForProvider(next.agentProvider);
  }
  for (const [snake, camel] of [["agent_model", "agentModel"], ["agent_base_url", "agentBaseUrl"], ["agent_api_key", "agentApiKey"]]) {
    if (patch[snake] != null || patch[camel] != null) next[camel] = String(patch[snake] ?? patch[camel]).trim();
  }
  if (next.agentBaseUrl) {
    try {
      const url = new URL(next.agentBaseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { return { ok: false, error: "API URL must be an http(s) URL without embedded credentials" }; }
  }
  if (next.agentProvider === "custom" && !(next.agentBaseUrl ?? current.agentBaseUrl)) {
    return { ok: false, error: "Configure the custom API URL first" };
  }
  if (patch.agent_thinking != null || patch.agentThinking != null) {
    next.agentThinking = normalizeThinkingLevel(patch.agent_thinking ?? patch.agentThinking);
    if (!next.agentThinking) return { ok: false, error: "Thinking must be off, low, medium, high, xhigh or max" };
  }
  if (next.agentModel != null && next.agentModel !== current.agentModel) next.agentModelRevision = (Number(current.agentModelRevision) || 0) + 1;
  if (Object.keys(next).length === 0) {
    return { ok: false, error: "empty settings patch" };
  }
  if (next.agentProvider && next.agentProvider !== current.agentProvider) {
    next.agentConversationId = `main-${require("crypto").randomUUID()}`;
  }
  const saved = saveConfig(projectRoot, next);
  return { ok: true, providerChanged: current.agentProvider !== saved.agentProvider, settings: buildSettingsSnapshot(loadConfig(projectRoot)) };
}

module.exports = {
  PROVIDER_OPTIONS,
  buildSettingsSnapshot,
  applySettingsPatch,
};

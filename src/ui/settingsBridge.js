"use strict";

/**
 * Shared launch-mode / agent-provider options for Ink + Rust chat hosts.
 */

const MODE_OPTIONS = Object.freeze(["internal"]);

const PROVIDER_OPTIONS = Object.freeze([
  { label: "codex", value: "codex-cli" },
  { label: "claude", value: "claude-cli" },
  { label: "agy", value: "agy-cli" },
  { label: "kimi", value: "kimi-cli" },
]);

function buildSettingsSnapshot(settings = {}) {
  const { normalizeAgentProvider } = require("../config");
  const launchMode = "internal";
  const agentProvider = normalizeAgentProvider(settings.agentProvider || "codex-cli");
  return {
    launch_mode: launchMode,
    agent_provider: agentProvider,
    mode_options: MODE_OPTIONS.slice(),
    provider_options: PROVIDER_OPTIONS.map((opt) => ({ ...opt })),
  };
}

function applySettingsPatch(projectRoot, patch = {}) {
  const { saveConfig, normalizeLaunchMode, normalizeAgentProvider } = require("../config");
  const next = {};
  if (patch.launch_mode != null || patch.launchMode != null) {
    if (normalizeLaunchMode(patch.launch_mode || patch.launchMode) !== "internal") {
      return { ok: false, error: "ufoo dashboard uses internal agents only" };
    }
    next.launchMode = "internal";
  }
  if (patch.agent_provider != null || patch.agentProvider != null) {
    next.agentProvider = normalizeAgentProvider(patch.agent_provider || patch.agentProvider);
  }
  if (Object.keys(next).length === 0) {
    return { ok: false, error: "empty settings patch" };
  }
  saveConfig(projectRoot, next);
  return { ok: true, settings: buildSettingsSnapshot({ ...patch, ...next }) };
}

module.exports = {
  MODE_OPTIONS,
  PROVIDER_OPTIONS,
  buildSettingsSnapshot,
  applySettingsPatch,
};

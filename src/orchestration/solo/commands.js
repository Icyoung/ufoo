"use strict";

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveSoloAgentType(config = {}, requestedAgent = "") {
  const requested = asTrimmedString(requestedAgent).toLowerCase();
  if (requested === "claude" || requested === "uclaude" || requested === "claude-code") return "claude";
  if (requested === "codex" || requested === "ucodex" || requested === "openai") return "codex";
  if (requested === "ucode" || requested === "ufoo" || requested === "ufoo-code") return "ucode";

  const provider = asTrimmedString(config && config.agentProvider).toLowerCase();
  if (provider === "claude-cli") return "claude";
  if (provider === "ucode") return "ucode";
  return "codex";
}

function buildPromptProfileCandidates(registry = null) {
  const profiles = Array.isArray(registry && registry.profiles) ? registry.profiles : [];
  return profiles.map((item) => ({
    cmd: item.id,
    desc: [item.summary || "", item.source || ""].filter(Boolean).join(" · "),
    source: item.source || "",
  }));
}

module.exports = {
  resolveSoloAgentType,
  buildPromptProfileCandidates,
};

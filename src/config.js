const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  launchMode: "terminal",
  agentProvider: "codex-cli",
  agentModel: "",
};

function normalizeLaunchMode(value) {
  if (value === "internal") return "internal";
  if (value === "tmux") return "tmux";
  return "terminal";
}

function normalizeAgentProvider(value) {
  return value === "claude-cli" ? "claude-cli" : "codex-cli";
}

function configPath(projectRoot) {
  return path.join(projectRoot, ".ufoo", "config.json");
}

function loadConfig(projectRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(projectRoot), "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      launchMode: normalizeLaunchMode(raw.launchMode),
      agentProvider: normalizeAgentProvider(raw.agentProvider),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(projectRoot, config) {
  const target = configPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
  };
  merged.launchMode = normalizeLaunchMode(merged.launchMode);
  merged.agentProvider = normalizeAgentProvider(merged.agentProvider);
  fs.writeFileSync(target, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = { loadConfig, saveConfig, normalizeLaunchMode, normalizeAgentProvider };

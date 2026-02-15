const fs = require("fs");
const path = require("path");

const DEFAULT_CONFIG = {
  launchMode: "auto",
  agentProvider: "codex-cli",
  agentModel: "",
  assistantEngine: "auto",
  assistantModel: "",
  assistantUfooCmd: "",
  ucodeProvider: "",
  ucodeModel: "",
  ucodeBaseUrl: "",
  ucodeApiKey: "",
  ucodeAgentDir: "",
  autoResume: false,
};

function normalizeLaunchMode(value) {
  if (value === "auto") return "auto";
  if (value === "internal") return "internal";
  if (value === "tmux") return "tmux";
  if (value === "terminal") return "terminal";
  return "auto";
}

function normalizeAgentProvider(value) {
  if (value === "claude-cli") return "claude-cli";
  if (value === "ucode" || value === "ufoo" || value === "ufoo-code") return "ucode";
  return "codex-cli";
}

function normalizeAssistantEngine(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "auto") return "auto";
  if (raw === "codex" || raw === "codex-cli" || raw === "codex-code") return "codex";
  if (raw === "claude" || raw === "claude-cli" || raw === "claude-code") return "claude";
  if (raw === "ufoo") return "ufoo";
  return "auto";
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
      assistantEngine: normalizeAssistantEngine(raw.assistantEngine),
      assistantModel: typeof raw.assistantModel === "string" ? raw.assistantModel : "",
      assistantUfooCmd: typeof raw.assistantUfooCmd === "string" ? raw.assistantUfooCmd : "",
      ucodeProvider: typeof raw.ucodeProvider === "string" ? raw.ucodeProvider : "",
      ucodeModel: typeof raw.ucodeModel === "string" ? raw.ucodeModel : "",
      ucodeBaseUrl: typeof raw.ucodeBaseUrl === "string" ? raw.ucodeBaseUrl : "",
      ucodeApiKey: typeof raw.ucodeApiKey === "string" ? raw.ucodeApiKey : "",
      ucodeAgentDir: typeof raw.ucodeAgentDir === "string" ? raw.ucodeAgentDir : "",
      autoResume: raw.autoResume !== false,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(projectRoot, config) {
  const target = configPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    existing = {};
  }
  const merged = {
    ...DEFAULT_CONFIG,
    ...existing,
    ...config,
  };
  merged.launchMode = normalizeLaunchMode(merged.launchMode);
  merged.agentProvider = normalizeAgentProvider(merged.agentProvider);
  merged.assistantEngine = normalizeAssistantEngine(merged.assistantEngine);
  merged.assistantModel = typeof merged.assistantModel === "string" ? merged.assistantModel : "";
  merged.assistantUfooCmd = typeof merged.assistantUfooCmd === "string" ? merged.assistantUfooCmd : "";
  merged.ucodeProvider = typeof merged.ucodeProvider === "string" ? merged.ucodeProvider : "";
  merged.ucodeModel = typeof merged.ucodeModel === "string" ? merged.ucodeModel : "";
  merged.ucodeBaseUrl = typeof merged.ucodeBaseUrl === "string" ? merged.ucodeBaseUrl : "";
  merged.ucodeApiKey = typeof merged.ucodeApiKey === "string" ? merged.ucodeApiKey : "";
  merged.ucodeAgentDir = typeof merged.ucodeAgentDir === "string" ? merged.ucodeAgentDir : "";
  merged.autoResume = merged.autoResume !== false;
  fs.writeFileSync(target, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  loadConfig,
  saveConfig,
  normalizeLaunchMode,
  normalizeAgentProvider,
  normalizeAssistantEngine,
};

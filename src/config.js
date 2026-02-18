const fs = require("fs");
const os = require("os");
const path = require("path");

const UCODE_FIELDS = ["ucodeProvider", "ucodeModel", "ucodeBaseUrl", "ucodeApiKey", "ucodeAgentDir"];

const DEFAULT_CONFIG = {
  launchMode: "auto",
  agentProvider: "codex-cli",
  agentModel: "",
  assistantEngine: "auto",
  assistantModel: "",
  assistantUfooCmd: "",
  autoResume: false,
};

const DEFAULT_UCODE_CONFIG = {
  ucodeProvider: "",
  ucodeModel: "",
  ucodeBaseUrl: "",
  ucodeApiKey: "",
  ucodeAgentDir: "",
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

function globalConfigPath() {
  return path.join(os.homedir(), ".ufoo", "config.json");
}

function configPath(projectRoot) {
  return path.join(projectRoot, ".ufoo", "config.json");
}

function loadJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function loadConfig(projectRoot) {
  try {
    const raw = loadJsonSafe(configPath(projectRoot));
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      launchMode: normalizeLaunchMode(raw.launchMode),
      agentProvider: normalizeAgentProvider(raw.agentProvider),
      assistantEngine: normalizeAssistantEngine(raw.assistantEngine),
      assistantModel: typeof raw.assistantModel === "string" ? raw.assistantModel : "",
      assistantUfooCmd: typeof raw.assistantUfooCmd === "string" ? raw.assistantUfooCmd : "",
      autoResume: raw.autoResume !== false,
      // Merge ucode fields from global config so callers still see them
      ...loadGlobalUcodeConfig(),
    };
  } catch {
    return { ...DEFAULT_CONFIG, ...DEFAULT_UCODE_CONFIG };
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
  // Strip ucode fields — they belong in global config only
  const projectUpdates = {};
  for (const [k, v] of Object.entries(config)) {
    if (!UCODE_FIELDS.includes(k)) {
      projectUpdates[k] = v;
    }
  }
  const merged = {
    ...DEFAULT_CONFIG,
    ...existing,
    ...projectUpdates,
  };
  // Remove any stale ucode fields from project config
  for (const f of UCODE_FIELDS) {
    delete merged[f];
  }
  merged.launchMode = normalizeLaunchMode(merged.launchMode);
  merged.agentProvider = normalizeAgentProvider(merged.agentProvider);
  merged.assistantEngine = normalizeAssistantEngine(merged.assistantEngine);
  merged.assistantModel = typeof merged.assistantModel === "string" ? merged.assistantModel : "";
  merged.assistantUfooCmd = typeof merged.assistantUfooCmd === "string" ? merged.assistantUfooCmd : "";
  merged.autoResume = merged.autoResume !== false;
  fs.writeFileSync(target, JSON.stringify(merged, null, 2));
  return merged;
}

function loadGlobalUcodeConfig() {
  const raw = loadJsonSafe(globalConfigPath());
  return {
    ucodeProvider: typeof raw.ucodeProvider === "string" ? raw.ucodeProvider : "",
    ucodeModel: typeof raw.ucodeModel === "string" ? raw.ucodeModel : "",
    ucodeBaseUrl: typeof raw.ucodeBaseUrl === "string" ? raw.ucodeBaseUrl : "",
    ucodeApiKey: typeof raw.ucodeApiKey === "string" ? raw.ucodeApiKey : "",
    ucodeAgentDir: typeof raw.ucodeAgentDir === "string" ? raw.ucodeAgentDir : "",
  };
}

function saveGlobalUcodeConfig(updates = {}) {
  const target = globalConfigPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const existing = loadJsonSafe(target);
  const merged = { ...existing };
  for (const [k, v] of Object.entries(updates)) {
    if (UCODE_FIELDS.includes(k)) {
      merged[k] = typeof v === "string" ? v : "";
    }
  }
  fs.writeFileSync(target, JSON.stringify(merged, null, 2));
  return merged;
}

module.exports = {
  loadConfig,
  saveConfig,
  loadGlobalUcodeConfig,
  saveGlobalUcodeConfig,
  normalizeLaunchMode,
  normalizeAgentProvider,
  normalizeAssistantEngine,
};

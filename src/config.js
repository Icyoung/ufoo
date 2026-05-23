const fs = require("fs");
const os = require("os");
const path = require("path");

const UCODE_FIELDS = ["ucodeProvider", "ucodeModel", "ucodeBaseUrl", "ucodeApiKey", "ucodeAgentDir"];

const SETTINGS_MODEL_DEFAULTS = Object.freeze({
  agent: Object.freeze({
    codex: "gpt-5.5",
    claude: "opus-4.7",
    // agy (Antigravity CLI) only supports model selection via in-REPL
    // `/model` slash command, which persists across launches. There is no
    // command-line flag for model, so the value here is a placeholder for
    // display; we never pass it on the agy command line.
    agy: "",
  }),
  router: Object.freeze({
    codex: "gpt-5.3-codex-spark",
    claude: "sonnet-4.7",
    agy: "",
  }),
});

const DEFAULT_CONFIG = {
  launchMode: "auto",
  agentProvider: "codex-cli",
  controllerMode: "main",
  codexInternalThreadMode: "api",
  codexAuthPath: "",
  codexOauthRefreshWindowSec: 300,
  claudeOauthProfile: "",
  claudeOauthTokenPath: "",
  claudeOauthRefreshWindowSec: 300,
  agentModel: "",
  routerProvider: "",
  routerModel: "",
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
  if (value === "host") return "host";
  return "auto";
}

function normalizeAgentProvider(value) {
  if (value === "claude-cli") return "claude-cli";
  if (value === "agy-cli" || value === "agy" || value === "antigravity") return "agy-cli";
  return "codex-cli";
}

function providerKey(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "claude" || text === "claude-cli" || text === "claude-code" || text === "anthropic") return "claude";
  if (text === "agy" || text === "agy-cli" || text === "antigravity") return "agy";
  return "codex";
}

function sameModelProvider(left = "", right = "") {
  return providerKey(left) === providerKey(right);
}

function defaultAgentModelForProvider(value = "") {
  return SETTINGS_MODEL_DEFAULTS.agent[providerKey(value)] || SETTINGS_MODEL_DEFAULTS.agent.codex;
}

function defaultRouterProviderForAgentProvider(value = "") {
  const key = providerKey(value);
  if (key === "claude") return "claude";
  // agy has no router-model API; fall back to codex (the controller still
  // routes via codex/claude regardless of which agent provider runs).
  if (key === "agy") return "codex";
  return "codex";
}

function defaultRouterModelForProvider(value = "") {
  return SETTINGS_MODEL_DEFAULTS.router[providerKey(value)] || SETTINGS_MODEL_DEFAULTS.router.codex;
}

function normalizeModel(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeControllerMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "shadow") return "shadow";
  if (raw === "router-api") return "main";
  if (raw === "main") return "main";
  if (raw === "loop") return "loop";
  return "legacy";
}

function normalizeCodexInternalThreadMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "api" || raw === "direct" || raw === "direct-api" || raw === "upstream") return "api";
  if (raw === "sdk") return "api";
  return "legacy";
}

function normalizeCodexAuthPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCodexOauthRefreshWindowSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 300;
  return Math.floor(num);
}

function normalizeClaudeOauthProfile(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeClaudeOauthTokenPath(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeClaudeOauthRefreshWindowSec(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 300;
  return Math.floor(num);
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
    const agentProvider = normalizeAgentProvider(raw.agentProvider);
    const routerProvider = normalizeModel(
      raw.routerProvider,
      defaultRouterProviderForAgentProvider(agentProvider)
    );
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      launchMode: normalizeLaunchMode(raw.launchMode),
      agentProvider,
      agentModel: normalizeModel(raw.agentModel, defaultAgentModelForProvider(agentProvider)),
      routerProvider,
      routerModel: normalizeModel(raw.routerModel, defaultRouterModelForProvider(routerProvider)),
      controllerMode: Object.prototype.hasOwnProperty.call(raw, "controllerMode")
        ? normalizeControllerMode(raw.controllerMode)
        : DEFAULT_CONFIG.controllerMode,
      codexInternalThreadMode: Object.prototype.hasOwnProperty.call(raw, "codexInternalThreadMode")
        ? normalizeCodexInternalThreadMode(raw.codexInternalThreadMode)
        : DEFAULT_CONFIG.codexInternalThreadMode,
      codexAuthPath: normalizeCodexAuthPath(raw.codexAuthPath),
      codexOauthRefreshWindowSec: normalizeCodexOauthRefreshWindowSec(raw.codexOauthRefreshWindowSec),
      claudeOauthProfile: normalizeClaudeOauthProfile(raw.claudeOauthProfile),
      claudeOauthTokenPath: normalizeClaudeOauthTokenPath(raw.claudeOauthTokenPath),
      claudeOauthRefreshWindowSec: normalizeClaudeOauthRefreshWindowSec(raw.claudeOauthRefreshWindowSec),
      autoResume: raw.autoResume !== false,
      // Merge ucode fields from global config so callers still see them
      ...loadGlobalUcodeConfig(),
    };
  } catch {
    const agentProvider = DEFAULT_CONFIG.agentProvider;
    const routerProvider = defaultRouterProviderForAgentProvider(agentProvider);
    return {
      ...DEFAULT_CONFIG,
      agentModel: defaultAgentModelForProvider(agentProvider),
      routerProvider,
      routerModel: defaultRouterModelForProvider(routerProvider),
      ...DEFAULT_UCODE_CONFIG,
    };
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
  merged.agentModel = typeof merged.agentModel === "string" ? merged.agentModel.trim() : "";
  merged.routerProvider = typeof merged.routerProvider === "string" ? merged.routerProvider.trim() : "";
  merged.routerModel = typeof merged.routerModel === "string" ? merged.routerModel.trim() : "";
  merged.controllerMode = normalizeControllerMode(merged.controllerMode);
  merged.codexInternalThreadMode = normalizeCodexInternalThreadMode(merged.codexInternalThreadMode);
  merged.codexAuthPath = normalizeCodexAuthPath(merged.codexAuthPath);
  merged.codexOauthRefreshWindowSec = normalizeCodexOauthRefreshWindowSec(merged.codexOauthRefreshWindowSec);
  merged.claudeOauthProfile = normalizeClaudeOauthProfile(merged.claudeOauthProfile);
  merged.claudeOauthTokenPath = normalizeClaudeOauthTokenPath(merged.claudeOauthTokenPath);
  merged.claudeOauthRefreshWindowSec = normalizeClaudeOauthRefreshWindowSec(merged.claudeOauthRefreshWindowSec);
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
  SETTINGS_MODEL_DEFAULTS,
  loadConfig,
  saveConfig,
  loadGlobalUcodeConfig,
  saveGlobalUcodeConfig,
  normalizeLaunchMode,
  normalizeAgentProvider,
  providerKey,
  sameModelProvider,
  defaultAgentModelForProvider,
  defaultRouterProviderForAgentProvider,
  defaultRouterModelForProvider,
  normalizeControllerMode,
  normalizeCodexInternalThreadMode,
  normalizeCodexAuthPath,
  normalizeCodexOauthRefreshWindowSec,
  normalizeClaudeOauthProfile,
  normalizeClaudeOauthTokenPath,
  normalizeClaudeOauthRefreshWindowSec,
};

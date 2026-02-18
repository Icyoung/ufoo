const fs = require("fs");
const path = require("path");
const { loadGlobalUcodeConfig } = require("../config");

function readJson(filePath = "", fallback = {}) {
  if (!filePath) return fallback;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function writeJson(filePath = "", data = {}) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function resolveRuntimeValues({
  env = process.env,
  config = {},
  projectRoot = process.cwd(),
} = {}) {
  const root = path.resolve(projectRoot);
  const provider = String(env.UFOO_UCODE_PROVIDER || config.ucodeProvider || "").trim();
  const model = String(env.UFOO_UCODE_MODEL || config.ucodeModel || "").trim();
  const apiKey = String(env.UFOO_UCODE_API_KEY || config.ucodeApiKey || "").trim();
  const baseUrl = String(env.UFOO_UCODE_BASE_URL || config.ucodeBaseUrl || "").trim();
  const os = require("os");
  const globalDefault = path.join(os.homedir(), ".ufoo", "agent", "ucode", "config");
  const projectDefault = path.join(root, ".ufoo", "agent", "ucode", "config");
  const legacyDefault = path.join(root, ".ufoo", "agent", "ucode", "pi-agent");
  const agentDir = path.resolve(
    String(
      env.UFOO_UCODE_CONFIG_DIR
        || env.PI_CODING_AGENT_DIR
        || env.UFOO_UCODE_AGENT_DIR
        || config.ucodeAgentDir
        || (fs.existsSync(legacyDefault) ? legacyDefault
          : fs.existsSync(projectDefault) ? projectDefault
          : globalDefault)
    ).trim()
  );
  return {
    projectRoot: root,
    provider,
    model,
    apiKey,
    baseUrl,
    agentDir,
  };
}

function inspectUcodeRuntimeConfig({
  projectRoot = process.cwd(),
  env = process.env,
  loadConfigImpl = loadGlobalUcodeConfig,
} = {}) {
  const root = path.resolve(projectRoot);
  const config = loadConfigImpl();
  const resolved = resolveRuntimeValues({
    env,
    config,
    projectRoot: root,
  });
  const settingsFile = path.join(resolved.agentDir, "settings.json");
  const authFile = path.join(resolved.agentDir, "auth.json");
  const modelsFile = path.join(resolved.agentDir, "models.json");
  return {
    ...resolved,
    settingsFile,
    authFile,
    modelsFile,
    settingsExists: fs.existsSync(settingsFile),
    authExists: fs.existsSync(authFile),
    modelsExists: fs.existsSync(modelsFile),
  };
}

function prepareUcodeRuntimeConfig({
  projectRoot = process.cwd(),
  env = process.env,
  loadConfigImpl = loadGlobalUcodeConfig,
} = {}) {
  const inspection = inspectUcodeRuntimeConfig({
    projectRoot,
    env,
    loadConfigImpl,
  });

  const settings = readJson(inspection.settingsFile, {});
  if (inspection.provider) settings.defaultProvider = inspection.provider;
  if (inspection.model) settings.defaultModel = inspection.model;
  writeJson(inspection.settingsFile, settings);

  if (inspection.provider && inspection.apiKey) {
    const auth = readJson(inspection.authFile, {});
    auth[inspection.provider] = {
      type: "api_key",
      key: inspection.apiKey,
    };
    writeJson(inspection.authFile, auth);
  }

  if (inspection.provider && inspection.baseUrl) {
    const models = readJson(inspection.modelsFile, {});
    if (!models.providers || typeof models.providers !== "object" || Array.isArray(models.providers)) {
      models.providers = {};
    }
    const providerConfig = models.providers[inspection.provider];
    const nextProviderConfig = (providerConfig && typeof providerConfig === "object" && !Array.isArray(providerConfig))
      ? { ...providerConfig }
      : {};
    nextProviderConfig.baseUrl = inspection.baseUrl;
    models.providers[inspection.provider] = nextProviderConfig;
    writeJson(inspection.modelsFile, models);
  }

  return {
    ...inspection,
    env: {
      UFOO_UCODE_CONFIG_DIR: inspection.agentDir,
      PI_CODING_AGENT_DIR: inspection.agentDir,
    },
  };
}

module.exports = {
  resolveRuntimeValues,
  inspectUcodeRuntimeConfig,
  prepareUcodeRuntimeConfig,
};


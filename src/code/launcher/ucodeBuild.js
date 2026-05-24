const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../../config");
const {
  resolveNativeFallbackCommand,
} = require("./ucode");

function resolveCoreRoot({
  env = process.env,
  config = {},
} = {}) {
  void env;
  void config;
  const native = resolveNativeFallbackCommand();
  return native.root || path.resolve(__dirname, "..");
}

function inspectUcodeBuildSetup({
  projectRoot = process.cwd(),
  env = process.env,
  loadConfigImpl = loadConfig,
} = {}) {
  const root = path.resolve(projectRoot);
  const config = loadConfigImpl(root);
  const coreRoot = resolveCoreRoot({ env, config });
  const native = resolveNativeFallbackCommand();
  const workspaceRoot = root;
  const distCliPath = Array.isArray(native.args) && native.args[0] ? path.resolve(native.args[0]) : "";
  const distCliExists = Boolean(distCliPath && fs.existsSync(distCliPath));
  const nodeModulesPath = "";
  return {
    projectRoot: root,
    coreRoot,
    workspaceRoot,
    distCliPath,
    distCliExists,
    nodeModulesPath,
    nodeModulesExists: Boolean(nodeModulesPath && fs.existsSync(nodeModulesPath)),
  };
}

function buildUcodeCore({
  projectRoot = process.cwd(),
  env = process.env,
  loadConfigImpl = loadConfig,
  installIfMissing = true,
  stdio = "inherit",
} = {}) {
  const before = inspectUcodeBuildSetup({
    projectRoot,
    env,
    loadConfigImpl,
  });
  void installIfMissing;
  void stdio;
  void env;
  if (!before.distCliExists) {
    throw new Error(`ucode native core entry missing: ${before.distCliPath || "(unknown)"}`);
  }
  return { ...before, steps: ["native-check"] };
}

module.exports = {
  inspectUcodeBuildSetup,
  buildUcodeCore,
  resolveCoreRoot,
};

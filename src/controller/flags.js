const fs = require("fs");
const path = require("path");
const { loadConfig, normalizeControllerMode } = require("../config");

const CONTROLLER_MODES = Object.freeze({
  LEGACY: "legacy",
  SHADOW: "shadow",
  MAIN: "main",
  LOOP: "loop",
});

const CONTROLLER_MODE_HISTORY_LIMIT = 16;

const appliedControllerModes = new Map();
const appliedControllerModeHistory = new Map();

function readProcessControllerMode(env = process.env) {
  const normalized = normalizeControllerMode(env.UFOO_CONTROLLER_MODE);
  if (normalized !== CONTROLLER_MODES.LEGACY || String(env.UFOO_CONTROLLER_MODE || "").trim().toLowerCase() === CONTROLLER_MODES.LEGACY) {
    return normalized;
  }
  return CONTROLLER_MODES.MAIN;
}

function resolveControllerMode({
  projectRoot,
  requestedMode = "",
  env = process.env,
  config = null,
} = {}) {
  const explicit = normalizeControllerMode(requestedMode);
  if (explicit !== CONTROLLER_MODES.LEGACY || String(requestedMode || "").trim().toLowerCase() === CONTROLLER_MODES.LEGACY) {
    return explicit;
  }

  const hasExplicitConfig = config && typeof config === "object"
    ? Object.prototype.hasOwnProperty.call(config, "controllerMode")
    : Boolean(projectRoot) && fs.existsSync(path.join(projectRoot, ".ufoo", "config.json"));
  const loadedConfig = hasExplicitConfig
    ? (config && typeof config === "object" ? config : loadConfig(projectRoot))
    : null;
  if (loadedConfig) {
    const projectMode = normalizeControllerMode(loadedConfig.controllerMode);
    if (projectMode !== CONTROLLER_MODES.LEGACY || String(loadedConfig.controllerMode || "").trim().toLowerCase() === CONTROLLER_MODES.LEGACY) {
      return projectMode;
    }
    return CONTROLLER_MODES.MAIN;
  }

  return readProcessControllerMode(env);
}

function getControllerModeStateKey(projectRoot = "") {
  const text = String(projectRoot || "").trim();
  return text || "__default__";
}

function pushModeHistory(key, previousMode, normalizedMode, messageId) {
  if (!previousMode || previousMode === normalizedMode) return;
  const list = appliedControllerModeHistory.get(key) || [];
  list.push({
    from_mode: previousMode,
    to_mode: normalizedMode,
    applied_from_msg_id: String(messageId || "").trim(),
  });
  while (list.length > CONTROLLER_MODE_HISTORY_LIMIT) list.shift();
  appliedControllerModeHistory.set(key, list);
}

function applyControllerModeForMessage({
  projectRoot,
  nextMode = CONTROLLER_MODES.MAIN,
  messageId = "",
} = {}) {
  const key = getControllerModeStateKey(projectRoot);
  const normalizedMode = normalizeControllerMode(nextMode);
  const previousMode = appliedControllerModes.get(key) || null;
  appliedControllerModes.set(key, normalizedMode);

  if (!previousMode || previousMode === normalizedMode) {
    return {
      mode: normalizedMode,
      transition: null,
    };
  }

  pushModeHistory(key, previousMode, normalizedMode, messageId);

  return {
    mode: normalizedMode,
    transition: {
      from_mode: previousMode,
      to_mode: normalizedMode,
      applied_from_msg_id: String(messageId || "").trim(),
    },
  };
}

function rollbackControllerModeForMessage({
  projectRoot,
  messageId = "",
} = {}) {
  const key = getControllerModeStateKey(projectRoot);
  const list = appliedControllerModeHistory.get(key) || [];
  const lastTransition = list.length > 0 ? list[list.length - 1] : null;
  const currentMode = appliedControllerModes.get(key) || CONTROLLER_MODES.MAIN;

  if (!lastTransition) {
    return {
      mode: currentMode,
      transition: null,
      rolled_back: false,
    };
  }

  list.pop();
  appliedControllerModeHistory.set(key, list);

  const nextMode = normalizeControllerMode(lastTransition.from_mode);
  appliedControllerModes.set(key, nextMode);

  if (nextMode === currentMode) {
    return {
      mode: nextMode,
      transition: null,
      rolled_back: true,
    };
  }

  return {
    mode: nextMode,
    rolled_back: true,
    transition: {
      from_mode: currentMode,
      to_mode: nextMode,
      applied_from_msg_id: String(messageId || "").trim(),
      rolled_back: true,
      restored_from_msg_id: String(lastTransition.applied_from_msg_id || "").trim(),
    },
  };
}

function getAppliedControllerMode(projectRoot) {
  const key = getControllerModeStateKey(projectRoot);
  return appliedControllerModes.get(key) || CONTROLLER_MODES.MAIN;
}

function getControllerModeHistoryForTests(projectRoot) {
  const key = getControllerModeStateKey(projectRoot);
  return (appliedControllerModeHistory.get(key) || []).slice();
}

function resetAppliedControllerModesForTests() {
  appliedControllerModes.clear();
  appliedControllerModeHistory.clear();
}

module.exports = {
  CONTROLLER_MODES,
  applyControllerModeForMessage,
  getAppliedControllerMode,
  getControllerModeHistoryForTests,
  readProcessControllerMode,
  resetAppliedControllerModesForTests,
  resolveControllerMode,
  rollbackControllerModeForMessage,
};

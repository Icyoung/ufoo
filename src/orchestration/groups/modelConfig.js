"use strict";

const { normalizeProvider } = require("../../agents/providers/providerId");

const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const text = value => typeof value === "string" ? value.trim() : "";
const object = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function validateModelConfig(config, basePath) {
  const errors = [];
  const error = (path, message) => errors.push({ path, message });
  if (config === undefined) return errors;
  if (!object(config)) return [{ path: basePath, message: "model_config must be an object" }];
  for (const [key, setting] of Object.entries(config)) {
    const prefix = `${basePath}.${key}`;
    if (!["codex", "claude", "agy", "override"].includes(key)) {
      error(prefix, "model_config supports codex, claude, agy and override");
      continue;
    }
    if (!object(setting)) { error(prefix, "model setting must be an object"); continue; }
    for (const field of Object.keys(setting)) {
      if (!["model", "reasoning_effort"].includes(field)) error(`${prefix}.${field}`, "unknown model setting");
    }
    if (setting.model !== undefined && typeof setting.model !== "string") error(`${prefix}.model`, "model must be a string");
    if (setting.reasoning_effort !== undefined && (typeof setting.reasoning_effort !== "string"
        || (text(setting.reasoning_effort) && !EFFORTS.has(text(setting.reasoning_effort))))) {
      error(`${prefix}.reasoning_effort`, "invalid reasoning_effort");
    }
    if (key === "override" && text(setting.reasoning_effort) && !text(setting.model)) {
      error(`${prefix}.model`, "override model is required when overriding reasoning_effort");
    }
  }
  return errors;
}

function resolveGroupModelConfig(config, type, provider = "") {
  const nativeProvider = type === "ucode" ? normalizeProvider(provider) : "";
  const modelProvider = nativeProvider === "anthropic" ? "claude" : nativeProvider || type;
  if (!config || (!["codex", "claude", "agy"].includes(modelProvider) && !nativeProvider)) return {};
  const source = text(config.override?.model) ? "override" : modelProvider;
  const setting = config[source] || {};
  const model = text(setting.model);
  const effort = text(setting.reasoning_effort);
  return model || effort ? { model, reasoning_effort: effort, model_source: source,
    ...(nativeProvider ? { model_provider: nativeProvider } : {}) } : {};
}

function buildGroupModelArgs(type, setting = {}) {
  const native = type === "ucode";
  if (!["codex", "claude", "agy"].includes(type) && !native) return [];
  const args = [];
  if (text(setting.model)) args.push("--model", text(setting.model));
  if (text(setting.reasoning_effort) && !native) {
    if (type === "codex") args.push("-c", `model_reasoning_effort=${JSON.stringify(text(setting.reasoning_effort))}`);
    else args.push("--effort", text(setting.reasoning_effort));
  }
  return args;
}

function buildGroupModelEnv(type, setting = {}) {
  if (type !== "ucode") return {};
  return { ...(text(setting.model_provider) ? { UFOO_UCODE_PROVIDER: text(setting.model_provider) } : {}),
    ...(text(setting.reasoning_effort) ? { UFOO_UCODE_THINKING: text(setting.reasoning_effort) } : {}) };
}

module.exports = { validateModelConfig, resolveGroupModelConfig, buildGroupModelArgs, buildGroupModelEnv };

const { loadConfig } = require("../../config");
const path = require("path");
const fs = require("fs");

function isReadableFile(filePath = "") {
  const target = String(filePath || "").trim();
  if (!target) return false;
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasAnyArg(args = [], names = []) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const flags = new Set((Array.isArray(names) ? names : []).filter(Boolean));
  return args.some((arg) => {
    const text = String(arg || "").trim();
    if (!text) return false;
    if (flags.has(text)) return true;
    const eqIdx = text.indexOf("=");
    if (eqIdx <= 0) return false;
    const key = text.slice(0, eqIdx).trim();
    return flags.has(key);
  });
}

function normalizeAppendSystemPromptMode(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (text === "always" || text === "force" || text === "on" || text === "1" || text === "true") return "always";
  if (text === "never" || text === "off" || text === "0" || text === "false" || text === "disable") return "never";
  return "auto";
}

function readLastArgValue(args = [], flag = "") {
  if (!Array.isArray(args) || !flag) return "";
  let value = "";
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || "").trim();
    if (!item) continue;
    if (item === flag) {
      const next = String(args[i + 1] || "").trim();
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
      continue;
    }
    if (item.startsWith(`${flag}=`)) {
      const inlineValue = item.slice(flag.length + 1).trim();
      if (inlineValue) value = inlineValue;
    }
  }
  return value;
}

function resolveNativeFallbackCommand({ env = process.env } = {}) {
  void env;
  const entry = path.resolve(__dirname, "..", "agent.js");
  try {
    if (isReadableFile(entry)) {
      return {
        command: process.execPath,
        args: [entry],
        root: path.resolve(__dirname, ".."),
        kind: "native",
        available: true,
        resolvedPath: entry,
      };
    }
  } catch {
    // ignore
  }
  return {
    command: process.execPath,
    args: [entry],
    root: path.resolve(__dirname, ".."),
    kind: "native",
    available: false,
    resolvedPath: "",
    missingReason: "src/code/agent.js not found",
  };
}

function resolveUcodeLaunch({
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  loadConfigImpl = loadConfig,
} = {}) {
  const config = loadConfigImpl(cwd);
  const configuredProvider = String(
    env.UFOO_UCODE_PROVIDER
      || config.ucodeProvider
      || ""
  ).trim();
  const configuredModel = String(
    env.UFOO_UCODE_MODEL
      || config.ucodeModel
      || ""
  ).trim();

  const nativeCore = resolveNativeFallbackCommand({ env });
  const command = nativeCore.command;
  const baseArgs = Array.isArray(nativeCore.args) ? nativeCore.args.slice() : [];
  const passthrough = Array.isArray(argv) ? argv.slice() : [];
  const finalArgs = [...baseArgs, ...passthrough];
  const hasProviderArg = hasAnyArg(finalArgs, ["--provider"]);
  const hasModelArg = hasAnyArg(finalArgs, ["--model"]);
  if (!hasProviderArg && configuredProvider) finalArgs.push("--provider", configuredProvider);
  if (!hasModelArg && configuredModel) finalArgs.push("--model", configuredModel);
  const promptFile = String(
    env.UFOO_UCODE_PROMPT_FILE
      || config.ucodePromptFile
      || ""
  ).trim();
  const bootstrapFile = String(
    env.UFOO_UCODE_BOOTSTRAP_FILE
      || config.ucodeBootstrapFile
      || path.join(cwd || process.cwd(), ".ufoo", "agent", "ucode", "bootstrap.md")
  ).trim();
  const appendSystemPrompt = String(
    env.UFOO_UCODE_APPEND_SYSTEM_PROMPT
      || config.ucodeAppendSystemPrompt
      || bootstrapFile
  ).trim();
  const appendSystemPromptMode = normalizeAppendSystemPromptMode(
    env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE
      || config.ucodeAppendSystemPromptMode
      || "auto"
  );
  // Native-only mode: the bundled native core always supports
  // --append-system-prompt, so only mode=never suppresses injection.
  const hasSystemPromptArg = hasAnyArg(finalArgs, ["--system-prompt", "--append-system-prompt"]);
  if (!hasSystemPromptArg && appendSystemPrompt && appendSystemPromptMode !== "never") {
    finalArgs.push("--append-system-prompt", appendSystemPrompt);
  }
  const effectiveProvider = readLastArgValue(finalArgs, "--provider");
  const effectiveModel = readLastArgValue(finalArgs, "--model");

  return {
    agentType: "ufoo-code",
    command,
    args: finalArgs,
    env: {
      UFOO_UCODE_PROMPT_FILE: promptFile,
      UFOO_UCODE_PROJECT_ROOT: String(cwd || process.cwd()),
      UFOO_UCODE_MODE: "coding-agent",
      UFOO_UCODE_PROTOCOL_VERSION: "1",
      UFOO_UCODE_PROVIDER: effectiveProvider,
      UFOO_UCODE_MODEL: effectiveModel,
      UFOO_UCODE_CORE_ROOT: nativeCore.root || "",
      UFOO_UCODE_CORE_KIND: "native",
      UFOO_UCODE_CORE_AVAILABLE: nativeCore.available === false ? "0" : "1",
      UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
      UFOO_UCODE_APPEND_SYSTEM_PROMPT: appendSystemPrompt,
      UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: appendSystemPromptMode,
    },
  };
}

module.exports = {
  hasAnyArg,
  normalizeAppendSystemPromptMode,
  readLastArgValue,
  resolveNativeFallbackCommand,
  resolveUcodeLaunch,
};

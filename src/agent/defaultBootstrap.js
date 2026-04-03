"use strict";

const fs = require("fs");
const path = require("path");
const { SHARED_UFOO_PROTOCOL } = require("../group/bootstrap");
const { getUfooPaths } = require("../ufoo/paths");

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasArg(args = [], names = []) {
  if (!Array.isArray(args) || args.length === 0) return false;
  const known = new Set((Array.isArray(names) ? names : []).map((item) => asTrimmedString(item)).filter(Boolean));
  return args.some((item) => {
    const text = asTrimmedString(item);
    if (!text) return false;
    if (known.has(text)) return true;
    const eqIndex = text.indexOf("=");
    if (eqIndex <= 0) return false;
    return known.has(text.slice(0, eqIndex).trim());
  });
}

function hasMetaCommandArgs(args = []) {
  return hasArg(args, ["-h", "--help", "-v", "--version"]);
}

function buildDefaultStartupBootstrapPrompt({ agentType = "" } = {}) {
  const normalizedAgent = asTrimmedString(agentType).toLowerCase();
  const displayAgent = normalizedAgent === "claude-code"
    ? "Claude"
    : (normalizedAgent === "codex" ? "Codex" : "agent");
  return [
    `Session bootstrap for ${displayAgent}.`,
    "Adopt the following ufoo coordination protocol silently.",
    "Do not reply to this bootstrap message unless the user explicitly asks about it. After applying it, continue the active task or wait for user input.",
    SHARED_UFOO_PROTOCOL,
  ].join("\n\n");
}

function defaultBootstrapFile(projectRoot, agentType = "") {
  const safeAgentType = asTrimmedString(agentType).replace(/[^a-zA-Z0-9._-]/g, "-") || "agent";
  return path.join(getUfooPaths(projectRoot).agentDir, safeAgentType, "default-bootstrap.md");
}

function prepareDefaultBootstrapFile({
  projectRoot,
  agentType = "",
  promptText = "",
  targetFile = "",
} = {}) {
  const root = asTrimmedString(projectRoot) || process.cwd();
  const file = asTrimmedString(targetFile) || defaultBootstrapFile(root, agentType);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(promptText || ""), "utf8");
  return { ok: true, file };
}

function resolveDefaultManualBootstrap({
  projectRoot,
  agentType = "",
  args = [],
  env = process.env,
} = {}) {
  const normalizedAgent = asTrimmedString(agentType).toLowerCase();
  const currentEnv = env && typeof env === "object" ? env : {};
  const currentArgs = Array.isArray(args) ? args.slice() : [];
  if (
    currentEnv.UFOO_SKIP_DEFAULT_BOOTSTRAP === "1"
    || currentEnv.UFOO_STARTUP_BOOTSTRAP_TEXT
    || hasMetaCommandArgs(currentArgs)
  ) {
    return { args: currentArgs, env: {}, mode: "skip" };
  }

  if (normalizedAgent === "claude-code") {
    if (hasArg(currentArgs, ["--append-system-prompt", "--system-prompt"])) {
      return { args: currentArgs, env: {}, mode: "skip" };
    }
    const promptText = buildDefaultStartupBootstrapPrompt({ agentType: normalizedAgent });
    const prepared = prepareDefaultBootstrapFile({
      projectRoot,
      agentType: normalizedAgent,
      promptText,
    });
    return {
      args: [...currentArgs, "--append-system-prompt", prepared.file],
      env: {},
      mode: "system-prompt-file",
      file: prepared.file,
      promptText,
    };
  }

  if (normalizedAgent === "codex") {
    if (currentArgs.length > 0) {
      return { args: currentArgs, env: {}, mode: "skip" };
    }
    const promptText = buildDefaultStartupBootstrapPrompt({ agentType: normalizedAgent });
    return {
      args: currentArgs,
      env: {
        UFOO_STARTUP_BOOTSTRAP_TEXT: promptText,
      },
      mode: "post-launch-inject",
      promptText,
    };
  }

  return { args: currentArgs, env: {}, mode: "skip" };
}

module.exports = {
  hasArg,
  hasMetaCommandArgs,
  buildDefaultStartupBootstrapPrompt,
  defaultBootstrapFile,
  prepareDefaultBootstrapFile,
  resolveDefaultManualBootstrap,
};

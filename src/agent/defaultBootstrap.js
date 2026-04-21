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

function readOptionalFile(filePath) {
  const target = asTrimmedString(filePath);
  if (!target) return "";
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return "";
  }
}

/**
 * Load the team activity timeline for prompt injection.
 * The daemon syncs manual inputs every ~30s; bus messages are appended in real-time.
 * Agent startup only reads — no build triggered here.
 */
function loadTeamActivityContext(projectRoot) {
  try {
    const { renderTimelineForPrompt } = require("../history/inputTimeline");
    return renderTimelineForPrompt(projectRoot, 20) || "";
  } catch {
    return "";
  }
}

function buildDefaultStartupBootstrapPrompt({ agentType = "", projectRoot = "" } = {}) {
  const normalizedAgent = asTrimmedString(agentType).toLowerCase();
  const displayAgent = normalizedAgent === "claude-code"
    ? "Claude"
    : (normalizedAgent === "codex" ? "Codex" : "agent");

  const segments = [
    `Session bootstrap for ${displayAgent}.`,
    "Adopt the following ufoo coordination protocol silently.",
    "Do not reply to this bootstrap message unless the user explicitly asks about it. After applying it, continue the active task or wait for user input.",
    SHARED_UFOO_PROTOCOL,
  ];

  const root = asTrimmedString(projectRoot) || process.cwd();
  const teamActivity = loadTeamActivityContext(root);
  if (teamActivity) {
    segments.push(teamActivity);
  }

  return segments.join("\n\n");
}

function defaultBootstrapFile(projectRoot, agentType = "") {
  const safeAgentType = asTrimmedString(agentType).replace(/[^a-zA-Z0-9._-]/g, "-") || "agent";
  return path.join(getUfooPaths(projectRoot).agentDir, safeAgentType, "default-bootstrap.md");
}

function mergedBootstrapFile(projectRoot, agentType = "") {
  const safeAgentType = asTrimmedString(agentType).replace(/[^a-zA-Z0-9._-]/g, "-") || "agent";
  return path.join(getUfooPaths(projectRoot).agentDir, safeAgentType, "merged-bootstrap.md");
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

function mergePromptSegments(...segments) {
  return segments
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function mergeClaudePromptArgs({
  projectRoot,
  agentType = "claude-code",
  args = [],
  bootstrapText = "",
} = {}) {
  const currentArgs = Array.isArray(args) ? args.slice() : [];
  for (let index = 0; index < currentArgs.length; index += 1) {
    const item = asTrimmedString(currentArgs[index]);
    if (!item) continue;

    if (item === "--append-system-prompt") {
      const existingFile = asTrimmedString(currentArgs[index + 1]);
      const mergedText = mergePromptSegments(readOptionalFile(existingFile), bootstrapText);
      const prepared = prepareDefaultBootstrapFile({
        projectRoot,
        agentType,
        targetFile: mergedBootstrapFile(projectRoot, agentType),
        promptText: mergedText,
      });
      currentArgs[index + 1] = prepared.file;
      return { args: currentArgs, file: prepared.file, promptText: mergedText };
    }

    if (item.startsWith("--append-system-prompt=")) {
      const existingFile = item.slice("--append-system-prompt=".length);
      const mergedText = mergePromptSegments(readOptionalFile(existingFile), bootstrapText);
      const prepared = prepareDefaultBootstrapFile({
        projectRoot,
        agentType,
        targetFile: mergedBootstrapFile(projectRoot, agentType),
        promptText: mergedText,
      });
      currentArgs[index] = `--append-system-prompt=${prepared.file}`;
      return { args: currentArgs, file: prepared.file, promptText: mergedText };
    }

    if (item === "--system-prompt") {
      const existingPrompt = String(currentArgs[index + 1] || "");
      currentArgs[index + 1] = mergePromptSegments(existingPrompt, bootstrapText);
      return { args: currentArgs, file: "", promptText: String(currentArgs[index + 1] || "") };
    }

    if (item.startsWith("--system-prompt=")) {
      const existingPrompt = item.slice("--system-prompt=".length);
      const mergedText = mergePromptSegments(existingPrompt, bootstrapText);
      currentArgs[index] = `--system-prompt=${mergedText}`;
      return { args: currentArgs, file: "", promptText: mergedText };
    }
  }
  return null;
}

function mergeCodexPromptArgs({ args = [], bootstrapText = "" } = {}) {
  const currentArgs = Array.isArray(args) ? args.slice() : [];
  const lastIndex = currentArgs.length - 1;
  if (lastIndex < 0) return null;
  const lastItem = asTrimmedString(currentArgs[lastIndex]);
  const promptIndex = lastItem && !lastItem.startsWith("-") ? lastIndex : -1;

  if (promptIndex < 0) return null;

  currentArgs[promptIndex] = mergePromptSegments(bootstrapText, currentArgs[promptIndex]);
  return {
    args: currentArgs,
    promptText: String(currentArgs[promptIndex] || ""),
    promptIndex,
  };
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
    const promptText = buildDefaultStartupBootstrapPrompt({ agentType: normalizedAgent, projectRoot });
    const merged = mergeClaudePromptArgs({
      projectRoot,
      agentType: normalizedAgent,
      args: currentArgs,
      bootstrapText: promptText,
    });
    if (merged) {
      return {
        args: merged.args,
        env: {},
        mode: "merged-system-prompt",
        file: merged.file,
        promptText: merged.promptText,
      };
    }
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
    const promptText = buildDefaultStartupBootstrapPrompt({ agentType: normalizedAgent, projectRoot });
    const merged = mergeCodexPromptArgs({
      args: currentArgs,
      bootstrapText: promptText,
    });
    if (merged) {
      return {
        args: merged.args,
        env: {},
        mode: "initial-prompt-arg",
        promptText: merged.promptText,
      };
    }
    if (currentArgs.length > 0) {
      return {
        args: currentArgs,
        env: {
          UFOO_STARTUP_BOOTSTRAP_TEXT: promptText,
        },
        mode: "post-launch-inject",
        promptText,
      };
    }
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

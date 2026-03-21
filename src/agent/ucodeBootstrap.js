const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");

function readFileSafe(filePath = "") {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function resolveProjectRules(projectRoot = "") {
  const rules = [];
  const agentsFile = path.join(projectRoot, "AGENTS.md");
  const claudeFile = path.join(projectRoot, "CLAUDE.md");

  if (fs.existsSync(agentsFile)) {
    rules.push({ path: agentsFile, content: readFileSafe(agentsFile) });
  } else if (fs.existsSync(claudeFile)) {
    rules.push({ path: claudeFile, content: readFileSafe(claudeFile) });
  }
  return rules.filter((item) => item.content.trim());
}

function defaultBootstrapPath(projectRoot = "") {
  const dir = path.join(getUfooPaths(projectRoot).agentDir, "ucode");
  return path.join(dir, "bootstrap.md");
}

function buildBootstrapContent({
  projectRoot = "",
  promptFile = "",
  promptText = "",
  rules = [],
} = {}) {
  const lines = [];
  lines.push("# ucode Bootstrap");
  lines.push("");
  lines.push(`Generated at: ${new Date().toISOString()}`);
  lines.push(`Project root: ${projectRoot}`);
  lines.push("");
  if (promptFile) {
    lines.push(`Source prompt: ${promptFile}`);
    lines.push("");
  }

  if (promptText.trim()) {
    lines.push("## Core Prompt");
    lines.push("");
    lines.push(promptText.trim());
    lines.push("");
  }

  if (rules.length > 0) {
    lines.push("## Project Rules");
    lines.push("");
    for (const rule of rules) {
      lines.push(`### ${rule.path}`);
      lines.push("");
      lines.push(rule.content.trim());
      lines.push("");
    }
  }

  if (rules.length === 0) {
    lines.push("## Project Rules");
    lines.push("");
    lines.push("No AGENTS.md/CLAUDE.md rules detected.");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function prepareUcodeBootstrap({
  projectRoot = process.cwd(),
  promptFile = "",
  promptText = "",
  targetFile = "",
} = {}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedPrompt = String(promptFile || "").trim();
  const resolvedTarget = String(targetFile || "").trim() || defaultBootstrapPath(resolvedProjectRoot);

  const inlinePromptText = String(promptText || "").trim();
  const resolvedPromptText = inlinePromptText || readFileSafe(resolvedPrompt);
  const rules = resolveProjectRules(resolvedProjectRoot);
  const content = buildBootstrapContent({
    projectRoot: resolvedProjectRoot,
    promptFile: resolvedPrompt,
    promptText: resolvedPromptText,
    rules,
  });

  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  fs.writeFileSync(resolvedTarget, content, "utf8");

  return {
    ok: true,
    file: resolvedTarget,
    promptFile: resolvedPrompt,
    hasPrompt: Boolean(resolvedPromptText.trim()),
    rulesCount: rules.length,
  };
}

module.exports = {
  readFileSafe,
  resolveProjectRules,
  defaultBootstrapPath,
  buildBootstrapContent,
  prepareUcodeBootstrap,
};

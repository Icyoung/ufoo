"use strict";

const { execSync } = require("child_process");
const os = require("os");

function getIsGit(workspaceRoot) {
  try {
    const result = execSync("git rev-parse --is-inside-work-tree", {
      cwd: workspaceRoot || process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000,
    });
    return String(result).trim() === "true";
  } catch {
    return false;
  }
}

function getShellName() {
  const shell = process.env.SHELL || "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("bash")) return "bash";
  if (shell.includes("fish")) return "fish";
  return shell || "unknown";
}

function getEnvironmentSection({ workspaceRoot = "", model = "", provider = "" } = {}) {
  const cwd = workspaceRoot || process.cwd();
  const isGit = getIsGit(cwd);
  const platform = process.platform;
  const shell = getShellName();
  const osInfo = `${os.type()} ${os.release()}`;
  const date = new Date().toISOString().slice(0, 10);

  const lines = [
    `Working directory: ${cwd}`,
    `Is git repository: ${isGit ? "yes" : "no"}`,
    `Platform: ${platform}`,
    `Shell: ${shell}`,
    `OS: ${osInfo}`,
    `Date: ${date}`,
  ];

  if (provider) lines.push(`Provider: ${provider}`);
  if (model) lines.push(`Model: ${model}`);

  return `# Environment\n${lines.map((l) => ` - ${l}`).join("\n")}`;
}

module.exports = { getEnvironmentSection, getIsGit };

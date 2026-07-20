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

  // Tell the model who it is on the bus. Without this, the only identities
  // it ever sees are other agents' records in shared context — and it
  // adopts them (observed in the wild: ucode-3 introducing itself as
  // claude-6, then accepting a wrong name from the user).
  const subscriberId = String(process.env.UFOO_SUBSCRIBER_ID || "").trim();
  const nickname = String(process.env.UFOO_NICKNAME || "").trim();
  if (subscriberId || nickname) {
    const label = nickname ? `${subscriberId || "unknown"} (nickname: ${nickname})` : subscriberId;
    lines.push(`Bus identity: ${label}`);
  }

  return `# Environment\n${lines.map((l) => ` - ${l}`).join("\n")}`;
}

module.exports = { getEnvironmentSection, getIsGit };

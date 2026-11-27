"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfig } = require("../../config");

const BUILTIN_ACP_AGENTS = Object.freeze([
  Object.freeze({
    id: "gemini",
    label: "Gemini CLI (ACP)",
    command: "gemini",
    args: ["--acp"],
    description: "Google Gemini CLI via Agent Client Protocol",
  }),
  Object.freeze({
    id: "opencode",
    label: "OpenCode (ACP)",
    command: "opencode",
    args: ["acp"],
    description: "OpenCode coding agent via Agent Client Protocol",
  }),
  Object.freeze({
    id: "kimi",
    label: "Kimi Code (ACP)",
    command: "kimi",
    args: ["acp"],
    description: "Kimi Code CLI via Agent Client Protocol",
  }),
  Object.freeze({
    id: "goose",
    label: "Goose (ACP)",
    command: "goose",
    args: ["acp"],
    description: "Block Goose agent via Agent Client Protocol",
  }),
  Object.freeze({
    id: "grok",
    label: "Grok Build (ACP)",
    command: "grok",
    args: ["--acp"],
    description: "xAI Grok Build via Agent Client Protocol",
  }),
]);

function normalizeAcpId(raw = "") {
  const value = String(raw || "").trim().toLowerCase();
  const stripped = value.startsWith("acp:") ? value.slice(4) : value;
  return stripped.replace(/[^a-z0-9._-]/g, "");
}

function isCommandExecutable(command = "") {
  const cmd = String(command || "").trim();
  if (!cmd) return false;
  if (cmd.includes(path.sep) || cmd.includes("/")) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    const res = spawnSync(checker, [cmd], {
      stdio: "ignore",
      timeout: 1500,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function normalizeCustomAcpEntry(raw = {}) {
  if (!raw || typeof raw !== "object") return null;
  const id = normalizeAcpId(raw.id || raw.name);
  const command = String(raw.command || "").trim();
  if (!id || !command) return null;
  return {
    id,
    label: String(raw.label || raw.displayName || `${id} (ACP)`).trim(),
    command,
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
    env: raw.env && typeof raw.env === "object" ? { ...raw.env } : {},
    description: String(raw.description || "Custom ACP Agent").trim(),
    source: "custom",
  };
}

function listConfiguredAcpAgents(projectRoot = process.cwd(), options = {}) {
  const config = options.config || (() => {
    try {
      return loadConfig(projectRoot) || {};
    } catch {
      return {};
    }
  })();

  const byId = new Map();
  for (const preset of BUILTIN_ACP_AGENTS) {
    byId.set(preset.id, {
      ...preset,
      args: preset.args.slice(),
      env: {},
      source: "builtin",
    });
  }

  const customList = Array.isArray(config.acpAgents) ? config.acpAgents : [];
  for (const item of customList) {
    const normalized = normalizeCustomAcpEntry(item);
    if (normalized) {
      byId.set(normalized.id, normalized);
    }
  }

  return Array.from(byId.values()).map((entry) => ({
    ...entry,
    agentType: `acp:${entry.id}`,
  }));
}

function detectInstalledAcpAgents(projectRoot = process.cwd(), options = {}) {
  const probe = typeof options.isExecutable === "function"
    ? options.isExecutable
    : isCommandExecutable;
  return listConfiguredAcpAgents(projectRoot, options).map((entry) => ({
    ...entry,
    available: Boolean(probe(entry.command)),
  }));
}

function resolveAcpAgentSpec(agentSpec = "", projectRoot = process.cwd(), options = {}) {
  const id = normalizeAcpId(agentSpec);
  if (!id) return null;
  const all = listConfiguredAcpAgents(projectRoot, options);
  return all.find((entry) => entry.id === id) || null;
}

module.exports = {
  BUILTIN_ACP_AGENTS,
  normalizeAcpId,
  isCommandExecutable,
  listConfiguredAcpAgents,
  detectInstalledAcpAgents,
  resolveAcpAgentSpec,
};

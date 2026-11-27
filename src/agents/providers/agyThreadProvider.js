"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { createAcpThreadProvider } = require("./acpThreadProvider");
const { isCommandExecutable } = require("./acpRegistry");

const AGY_MODELS_CACHE_TTL_MS = 60_000;
let agyModelsCache = { at: 0, models: [] };

function parseAgyModelsOutput(stdout = "") {
  const seen = new Set();
  const models = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching\b/i.test(line)) continue;
    const id = line.split(/\t|\s{2,}/)[0].trim();
    if (!id || !/^[a-z0-9][a-z0-9._:-]{1,80}$/i.test(id)) continue;
    if (!seen.has(id)) {
      seen.add(id);
      models.push(id);
    }
  }
  return models;
}

async function listAgyCliModels(options = {}) {
  const now = Date.now();
  if (!options.force && agyModelsCache.models.length > 0 && now - agyModelsCache.at < AGY_MODELS_CACHE_TTL_MS) {
    return { ok: true, models: agyModelsCache.models.slice(), cached: true };
  }
  const bin = String(options.command || "").trim() || resolveAgyBinary(options);
  if (!bin) return { ok: false, models: [], error: "agy binary not found" };
  return new Promise((resolve) => {
    execFile(bin, ["models"], {
      timeout: Number(options.timeoutMs) || 6000,
      maxBuffer: 512 * 1024,
      env: options.env || process.env,
    }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, models: [], error: err.message || "agy models failed" });
        return;
      }
      const models = parseAgyModelsOutput(stdout);
      if (models.length > 0) {
        agyModelsCache = { at: Date.now(), models };
      }
      resolve({ ok: models.length > 0, models, cached: false });
    });
  });
}

function resolveAgyBinary(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const isExec = typeof options.isExecutable === "function" ? options.isExecutable : isCommandExecutable;

  const candidates = [
    String(env.UFOO_AGY_BIN || "").trim(),
    path.join(homeDir, ".local", "bin", "agy"),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "agy",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.includes("/")) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }
    if (isExec(candidate)) return candidate;
  }
  return "";
}

function isAgyAvailable(options = {}) {
  return Boolean(resolveAgyBinary(options));
}

function buildAgyAcpArgs({ permissionMode = "", extraArgs = [] } = {}) {
  const args = ["acp", "--process-per-session"];
  const perm = String(permissionMode || "").trim().toLowerCase();
  if (perm === "full_access") {
    args.push("--dangerously-skip-permissions");
  }
  const extra = Array.isArray(extraArgs) ? extraArgs : [];
  for (let i = 0; i < extra.length; i += 1) {
    const token = String(extra[i] || "").trim();
    if (!token) continue;
    if (token === "--sandbox" || token === "--dangerously-skip-permissions") {
      if (!args.includes(token)) args.push(token);
    }
  }
  return args;
}

function createAgyThreadProvider(options = {}) {
  const command = String(options.command || "").trim() || resolveAgyBinary(options);
  if (!command) {
    throw new Error("Antigravity CLI (`agy`) was not found. Install `agy` or set UFOO_AGY_BIN.");
  }

  const args = Array.isArray(options.args)
    ? options.args.slice()
    : buildAgyAcpArgs({
      permissionMode: options.permissionMode,
      extraArgs: options.extraArgs,
    });

  return createAcpThreadProvider({
    agentId: "agy",
    command,
    args,
    env: options.env || {},
    cwd: options.cwd || process.cwd(),
    mcpServers: options.mcpServers || [],
    model: options.model || "",
    thinkingLevel: options.thinkingLevel || "",
    permissionMode: options.permissionMode || "auto_edit",
    systemPrompt: options.systemPrompt || "",
    preferNativeSystemPrompt: true,
    onPermissionRequest: options.onPermissionRequest,
    connectionFactory: options.connectionFactory,
  });
}

module.exports = {
  resolveAgyBinary,
  isAgyAvailable,
  buildAgyAcpArgs,
  parseAgyModelsOutput,
  listAgyCliModels,
  createAgyThreadProvider,
};

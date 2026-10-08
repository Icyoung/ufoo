const { spawnSync } = require("child_process");

// These are the oldest versions verified by our real-CLI smoke tests, not a
// claim about the vendor's first release of each experimental API.
const TESTED_BASELINES = { codex: "0.160.1", "claude-code": "2.1.204" };
const cache = new Map();

function atLeast(version, baseline) {
  const left = version.split(".").map(Number);
  const right = baseline.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return true;
}

function probeNativeCapabilities({ agentType, command, env = process.env, spawnSyncImpl = spawnSync } = {}) {
  const baseline = TESTED_BASELINES[agentType];
  if (!baseline) return { supported: false, reason: "unsupported_provider" };
  const executable = command || (agentType === "codex" ? "codex" : "claude");
  const key = `${agentType}:${executable}:${env.PATH}`;
  const cached = cache.get(key);
  if (spawnSyncImpl === spawnSync && cached && Date.now() - cached.at < 60000) return cached.result;
  const output = spawnSyncImpl(executable, ["--version"], {
    env, encoding: "utf8", timeout: 4000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  const version = String(output?.stdout || "").match(/\b(\d+\.\d+\.\d+)\b/)?.[1] || "";
  let result = { supported: output?.status === 0 && Boolean(version) && atLeast(version, baseline), version, baseline };
  if (!result.supported) result.reason = output?.error?.code === "ENOENT" ? "cli_missing" : `requires_tested_version_${baseline}`;
  if (result.supported && agentType === "codex") {
    const help = spawnSyncImpl(executable, ["--help"], { env, encoding: "utf8", timeout: 4000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    if (help?.status !== 0 || !String(help.stdout).includes("--remote") || !String(help.stdout).includes("app-server")) {
      result = { ...result, supported: false, reason: "missing_remote_app_server" };
    }
  }
  if (spawnSyncImpl === spawnSync) cache.set(key, { at: Date.now(), result });
  return result;
}

module.exports = { TESTED_BASELINES, probeNativeCapabilities };

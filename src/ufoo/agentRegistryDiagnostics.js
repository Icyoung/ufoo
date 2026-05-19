const fs = require("fs");
const path = require("path");

const MAX_DIAGNOSTIC_LOG_BYTES = 5 * 1024 * 1024;
const emittedDiagnostics = new Set();

function isAgentsFile(filePath) {
  return path.basename(filePath || "") === "all-agents.json"
    && path.basename(path.dirname(filePath || "")) === "agent";
}

function getRegistryLogPath(agentsFilePath) {
  const ufooRoot = path.dirname(path.dirname(agentsFilePath));
  return path.join(ufooRoot, "run", "agent-registry-diagnostics.log");
}

function summarizeFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch (err) {
    return {
      exists: false,
      error: err && err.code ? err.code : String(err || "unknown"),
    };
  }
}

function summarizeAgents(data) {
  const agents = data && typeof data === "object" && data.agents && typeof data.agents === "object"
    ? data.agents
    : {};
  const ids = Object.keys(agents).sort();
  const statuses = {};
  const nicknames = {};
  for (const id of ids) {
    const meta = agents[id] || {};
    const status = typeof meta.status === "string" && meta.status ? meta.status : "unknown";
    statuses[status] = (statuses[status] || 0) + 1;
    if (typeof meta.nickname === "string" && meta.nickname) {
      nicknames[id] = meta.nickname;
    }
  }
  return {
    count: ids.length,
    ids,
    statuses,
    nicknames,
  };
}

function safePayload(payload = {}) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (/token|secret|password|credential|auth/i.test(key)) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = value;
    }
  }
  return out;
}

function diagnosticKey(agentsFilePath, event, payload = {}) {
  if (event === "queue_entry_not_recovered") {
    return [
      agentsFilePath,
      event,
      payload.subscriber || "",
      payload.reason || "",
    ].join("\0");
  }
  return "";
}

function shouldSuppressDiagnostic(agentsFilePath, event, payload = {}) {
  const key = diagnosticKey(agentsFilePath, event, payload);
  if (!key) return false;
  if (emittedDiagnostics.has(key)) return true;
  emittedDiagnostics.add(key);
  return false;
}

function enforceLogLimit(logPath) {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= MAX_DIAGNOSTIC_LOG_BYTES) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      event: "diagnostics_log_truncated",
      previous_size: stat.size,
    });
    fs.writeFileSync(logPath, `${line}\n`, "utf8");
  } catch {
    // Missing/unreadable log files are handled by the append path.
  }
}

function appendAgentRegistryDiagnostic(agentsFilePath, event, payload = {}) {
  if (!agentsFilePath || !isAgentsFile(agentsFilePath)) return;
  if (shouldSuppressDiagnostic(agentsFilePath, event, payload)) return;
  try {
    const logPath = getRegistryLogPath(agentsFilePath);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    enforceLogLimit(logPath);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ppid: process.ppid,
      event,
      agents_file: agentsFilePath,
      file: summarizeFile(agentsFilePath),
      ...safePayload(payload),
    });
    fs.appendFileSync(logPath, `${line}\n`, "utf8");
  } catch {
    // Diagnostics must never affect agent liveness paths.
  }
}

module.exports = {
  appendAgentRegistryDiagnostic,
  summarizeAgents,
  summarizeFile,
  isAgentsFile,
  getRegistryLogPath,
  MAX_DIAGNOSTIC_LOG_BYTES,
};

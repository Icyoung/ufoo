const fs = require("fs");
const path = require("path");

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

function appendAgentRegistryDiagnostic(agentsFilePath, event, payload = {}) {
  if (!agentsFilePath || !isAgentsFile(agentsFilePath)) return;
  try {
    const logPath = getRegistryLogPath(agentsFilePath);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
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
};

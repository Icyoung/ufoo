const fs = require("fs");
const os = require("os");
const path = require("path");
const { canonicalProjectRoot, buildProjectId, trimTrailingSlashes } = require("./projectId");
const { getUfooPaths } = require("../ufoo/paths");

const DEFAULT_STALE_TTL_MS = 30 * 1000;
const DEFAULT_TMP_CLEANUP_AGE_MS = 5 * 60 * 1000;

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function canonicalizeForRecord(projectRoot) {
  const input = String(projectRoot || "").trim();
  if (!input) throw new Error("projectRoot is required");
  try {
    return canonicalProjectRoot(input);
  } catch (err) {
    if (!err || err.code === "ENOENT") {
      // Keep stale records readable when project path was deleted or moved.
      return trimTrailingSlashes(path.resolve(input));
    }
    // Unexpected IO errors should be visible, but keep fallback behavior.
    // eslint-disable-next-line no-console
    console.warn(`[projects] canonicalize fallback for ${input}: ${err.message || err}`);
    // Keep stale records readable even when project path no longer exists.
    return trimTrailingSlashes(path.resolve(input));
  }
}

function resolveRuntimeDir(options = {}) {
  if (options.runtimeDir) return options.runtimeDir;
  return path.join(os.homedir(), ".ufoo", "projects", "runtime");
}

function normalizeIsoTimestamp(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function runtimeFilePathByProjectId(projectId, options = {}) {
  const runtimeDir = resolveRuntimeDir(options);
  return path.join(runtimeDir, `${projectId}.json`);
}

function runtimeFilePathByProjectRoot(projectRoot, options = {}) {
  return runtimeFilePathByProjectId(buildProjectId(projectRoot), options);
}

function readJsonFileSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function cleanupRuntimeTmpFiles(runtimeDir, options = {}) {
  if (!fs.existsSync(runtimeDir)) return;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const minAgeMs = Number.isFinite(options.tmpCleanupAgeMs)
    ? options.tmpCleanupAgeMs
    : DEFAULT_TMP_CLEANUP_AGE_MS;
  const files = fs.readdirSync(runtimeDir).filter((name) => name.endsWith(".tmp"));
  for (const file of files) {
    const target = path.join(runtimeDir, file);
    try {
      const stat = fs.statSync(target);
      const ageMs = Math.max(0, nowMs - stat.mtimeMs);
      if (ageMs < minAgeMs) continue;
      fs.unlinkSync(target);
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}

function parseDaemonPid(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

function isSocketAlive(socketPath) {
  if (!socketPath || typeof socketPath !== "string") return false;
  if (!fs.existsSync(socketPath)) return false;
  try {
    const stat = fs.statSync(socketPath);
    return stat.isSocket();
  } catch {
    return false;
  }
}

function normalizeStatus(value, fallback = "running") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "running" || raw === "stale" || raw === "stopped") return raw;
  return fallback;
}

function normalizeRuntimeEntry(entry = {}, fallbackProjectRoot = "") {
  const canonicalRoot = canonicalizeForRecord(entry.project_root || fallbackProjectRoot);
  const knownProjectId = String(entry.project_id || "").trim();
  const projectId = /^[a-f0-9]{12}$/.test(knownProjectId)
    ? knownProjectId
    : buildProjectId(canonicalRoot);
  const paths = getUfooPaths(canonicalRoot);
  return {
    version: 1,
    project_id: projectId,
    project_root: canonicalRoot,
    project_name: String(entry.project_name || path.basename(canonicalRoot) || canonicalRoot),
    daemon_pid: parseDaemonPid(entry.daemon_pid, null),
    socket_path: String(entry.socket_path || paths.ufooSock),
    status: normalizeStatus(entry.status, "running"),
    last_seen: normalizeIsoTimestamp(entry.last_seen),
    last_switch_at: entry.last_switch_at ? normalizeIsoTimestamp(entry.last_switch_at) : undefined,
  };
}

function readProjectRuntimeByRoot(projectRoot, options = {}) {
  const filePath = runtimeFilePathByProjectRoot(projectRoot, options);
  if (!fs.existsSync(filePath)) return null;
  const parsed = readJsonFileSafe(filePath);
  if (!parsed || typeof parsed !== "object") return null;
  try {
    return normalizeRuntimeEntry(parsed, projectRoot);
  } catch {
    return null;
  }
}

function upsertProjectRuntime(entry = {}, options = {}) {
  const projectRoot = entry.projectRoot || entry.project_root;
  if (!projectRoot) throw new Error("projectRoot is required");

  const existing = readProjectRuntimeByRoot(projectRoot, options) || {};
  const normalized = normalizeRuntimeEntry({
    ...existing,
    ...entry,
    project_root: projectRoot,
    project_name: entry.projectName || entry.project_name || existing.project_name,
    daemon_pid: parseDaemonPid(entry.daemonPid ?? entry.daemon_pid, existing.daemon_pid),
    socket_path: entry.socketPath || entry.socket_path || existing.socket_path,
    status: normalizeStatus(entry.status, existing.status || "running"),
    last_seen: normalizeIsoTimestamp(entry.lastSeen || entry.last_seen || new Date().toISOString()),
    last_switch_at: entry.lastSwitchAt || entry.last_switch_at || existing.last_switch_at,
  }, projectRoot);

  const filePath = runtimeFilePathByProjectId(normalized.project_id, options);
  writeJsonAtomic(filePath, normalized);
  return normalized;
}

function markProjectStopped(projectRoot, options = {}) {
  if (!projectRoot) return null;
  const existing = readProjectRuntimeByRoot(projectRoot, options);
  const paths = getUfooPaths(canonicalizeForRecord(projectRoot));
  return upsertProjectRuntime({
    projectRoot,
    projectName: existing ? existing.project_name : path.basename(projectRoot),
    daemonPid: existing ? existing.daemon_pid : null,
    socketPath: existing ? existing.socket_path : paths.ufooSock,
    status: "stopped",
    lastSeen: new Date().toISOString(),
    lastSwitchAt: existing ? existing.last_switch_at : undefined,
  }, options);
}

function validateProjectRuntime(entry = {}, options = {}) {
  if (!entry || typeof entry !== "object") return null;
  const staleTtlMs = Number.isFinite(options.staleTtlMs) ? options.staleTtlMs : DEFAULT_STALE_TTL_MS;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const pidAlive = isPidAlive(parseDaemonPid(entry.daemon_pid, null));
  const socketAlive = isSocketAlive(entry.socket_path);
  const running = pidAlive && socketAlive;

  const parsedLastSeen = new Date(entry.last_seen);
  const lastSeenMs = Number.isNaN(parsedLastSeen.getTime()) ? null : parsedLastSeen.getTime();
  const ageMs = lastSeenMs === null ? null : Math.max(0, nowMs - lastSeenMs);

  let status = normalizeStatus(entry.status, "running");
  if (running) {
    status = "running";
  } else if (status === "stopped") {
    // Respect explicit stop state even if pid/socket checks are unavailable.
    status = "stopped";
  } else if (ageMs === null || ageMs > staleTtlMs) {
    status = "stale";
  }

  return {
    ...entry,
    status,
    validation: {
      pid_alive: pidAlive,
      socket_alive: socketAlive,
      stale_ttl_ms: staleTtlMs,
      age_ms: ageMs,
      validated_at: new Date(nowMs).toISOString(),
    },
  };
}

function listProjectRuntimes(options = {}) {
  const runtimeDir = resolveRuntimeDir(options);
  if (!fs.existsSync(runtimeDir)) return [];
  if (options.cleanupTmp === true) {
    cleanupRuntimeTmpFiles(runtimeDir, options);
  }

  const files = fs.readdirSync(runtimeDir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  const rows = [];
  for (const file of files) {
    const parsed = readJsonFileSafe(path.join(runtimeDir, file));
    if (!parsed || typeof parsed !== "object") continue;
    try {
      const normalized = normalizeRuntimeEntry(parsed);
      rows.push(options.validate === false ? normalized : validateProjectRuntime(normalized, options));
    } catch {
      // Ignore malformed runtime entries.
    }
  }

  rows.sort((a, b) => {
    const aSeen = Date.parse(a.last_seen || 0) || 0;
    const bSeen = Date.parse(b.last_seen || 0) || 0;
    return bSeen - aSeen;
  });

  return rows;
}

function getCurrentProjectRuntime(projectRoot, options = {}) {
  const runtime = readProjectRuntimeByRoot(projectRoot, options);
  if (!runtime) return null;
  if (options.validate === false) return runtime;
  return validateProjectRuntime(runtime, options);
}

module.exports = {
  DEFAULT_STALE_TTL_MS,
  resolveRuntimeDir,
  runtimeFilePathByProjectId,
  runtimeFilePathByProjectRoot,
  upsertProjectRuntime,
  markProjectStopped,
  listProjectRuntimes,
  getCurrentProjectRuntime,
  validateProjectRuntime,
};

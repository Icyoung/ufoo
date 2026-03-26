const fs = require("fs");
const os = require("os");
const path = require("path");
const EventBus = require("../bus");
const { loadAgentsData, saveAgentsData } = require("../ufoo/agentsStore");
const { getUfooPaths } = require("../ufoo/paths");

/**
 * Build probe marker using nickname (e.g., "claude-47")
 * Simpler than the old token format, easier to search
 */
function buildProbeMarker(nickname) {
  return nickname || "";
}

/**
 * Build probe command:
 * - claude-code: /ufoo <nickname>
 * - codex: $ufoo <nickname>
 */
function buildProbeCommand(agentType, nickname) {
  const marker = String(nickname || "").trim();
  if (agentType === "claude-code") {
    return `/ufoo ${marker}`;
  }
  return `$ufoo ${marker}`;
}

function readLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function escapeRegExp(value = "") {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsProbeCommand(text, marker) {
  if (!text || !marker) return false;
  const escapedMarker = escapeRegExp(marker);
  const pattern = `(?:^|[\\s"'\\\`])(?:\\/ufoo|\\$ufoo|ufoo)\\s+${escapedMarker}(?=$|[\\s"'\\\`.,:;!?\\]\\)\\}])`;
  const re = new RegExp(pattern);
  return re.test(String(text));
}

/**
 * Check if a history record contains our probe marker
 * Searches for probe marker command patterns:
 * - "/ufoo <marker>" (claude)
 * - "$ufoo <marker>" (codex)
 * - "ufoo <marker>" (legacy compatibility)
 */
function recordContainsMarker(record, marker, rawLine) {
  if (!marker) return false;

  // Check raw line first (fastest)
  if (containsProbeCommand(rawLine, marker)) return true;

  if (!record || typeof record !== "object") return false;

  // Check common fields where user input might appear
  const fields = [
    record.display,     // history.jsonl uses "display" for user input
    record.text,
    record.prompt,
    record.input,
    record.message,
    record.query,
    record.content,
  ];

  for (const field of fields) {
    if (containsProbeCommand(field, marker)) return true;
  }
  return false;
}

function extractSessionId(record, rawLine) {
  if (record && typeof record === "object") {
    return record.session_id || record.sessionId || record.session || "";
  }
  if (typeof rawLine === "string") {
    const match = rawLine.match(/"session(?:_id|Id)"\s*:\s*"([^"]+)"/);
    if (match && match[1]) return match[1];
  }
  return "";
}

/**
 * Find session ID in a history file by searching for the probe marker
 */
function findSessionInFile(filePath, marker) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const lines = readLines(filePath);

  // Search from end (most recent first)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];

    // Quick check: line must contain the marker string
    if (!line.includes(marker)) continue;

    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      record = null;
    }

    if (!recordContainsMarker(record, marker, line)) continue;

    const sessionId = extractSessionId(record, line);
    if (sessionId) {
      return { sessionId, source: filePath };
    }
  }
  return null;
}

function getClaudeHistoryPath() {
  return path.join(os.homedir(), ".claude", "history.jsonl");
}

function getCodexHistoryPath() {
  return path.join(os.homedir(), ".codex", "history.jsonl");
}

/**
 * Search provider history for the probe marker and return session ID
 */
function resolveProviderSession(agentType, marker) {
  if (agentType === "codex") {
    return findSessionInFile(getCodexHistoryPath(), marker);
  }
  if (agentType === "claude-code") {
    return findSessionInFile(getClaudeHistoryPath(), marker);
  }
  return null;
}

/**
 * Save probe marker to agents data (for debugging/tracking)
 */
function persistProbeMarker(projectRoot, subscriberId, marker) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const data = loadAgentsData(filePath);
  const meta = data.agents[subscriberId] || {};
  data.agents[subscriberId] = {
    ...meta,
    provider_session_probe: marker,
    provider_session_updated_at: new Date().toISOString(),
  };
  saveAgentsData(filePath, data);
}

function persistProviderSession(projectRoot, subscriberId, payload) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const data = loadAgentsData(filePath);
  const meta = data.agents[subscriberId] || {};
  data.agents[subscriberId] = {
    ...meta,
    provider_session_id: payload.sessionId || "",
    provider_session_source: payload.source || "",
    provider_session_updated_at: new Date().toISOString(),
  };
  saveAgentsData(filePath, data);
}

/**
 * Retry searching for session ID with the given marker
 */
async function resolveWithRetries(agentType, marker, attempts = 12, intervalMs = 2000) {
  for (let i = 0; i < attempts; i += 1) {
    const resolved = resolveProviderSession(agentType, marker);
    if (resolved && resolved.sessionId) return resolved;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}


function loadProviderSessionCache(projectRoot) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const data = loadAgentsData(filePath);
  const cache = new Map();
  for (const [id, meta] of Object.entries(data.agents || {})) {
    if (meta && meta.provider_session_id) {
      cache.set(id, {
        sessionId: meta.provider_session_id,
        source: meta.provider_session_source || "",
        updated_at: meta.provider_session_updated_at || "",
      });
    }
  }
  return cache;
}

/**
 * Execute probe: inject command and search for session ID
 */
async function executeProbe({
  projectRoot,
  subscriberId,
  agentType,
  nickname,
  attempts = 15,
  intervalMs = 2000,
  onResolved = null,
}) {
  const marker = buildProbeMarker(nickname);

  try {
    const command = buildProbeCommand(agentType, nickname);
    const bus = new EventBus(projectRoot);
    bus.ensureBus();
    await bus.inject(subscriberId, command);
  } catch {
    // ignore injection failures
  }

  const resolved = await resolveWithRetries(agentType, marker, attempts, intervalMs);
  if (resolved && resolved.sessionId) {
    persistProviderSession(projectRoot, subscriberId, resolved);
    if (typeof onResolved === "function") {
      onResolved(subscriberId, resolved);
    }
  }
}

/**
 * Resolve Claude Code session ID directly from session file.
 * Claude writes ~/.claude/sessions/<pid>.json with { sessionId, pid, cwd, ... }
 */
function resolveClaudeSessionFromFile(pid) {
  if (!pid) return null;
  const filePath = path.join(os.homedir(), ".claude", "sessions", `${pid}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const sessionId = data.sessionId || data.session_id || "";
    if (!sessionId) return null;
    return { sessionId, source: filePath };
  } catch {
    return null;
  }
}

/**
 * Resolve Codex session ID from session rollout files.
 * Codex writes ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
 * First line contains { type: "session_meta", payload: { id, cwd, ... } }
 */
function resolveCodexSessionFromFile(cwd) {
  if (!cwd) return null;
  try {
    const now = new Date();
    // Check today and yesterday (session may have started before midnight)
    const dates = [now];
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    dates.push(yesterday);

    let bestMatch = null;
    let bestMtime = 0;

    for (const d of dates) {
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const dir = path.join(os.homedir(), ".codex", "sessions", yyyy, mm, dd);
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));

      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs <= bestMtime) continue;

          // Read first line for session_meta
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(4096);
          const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
          fs.closeSync(fd);
          const firstLine = buf.toString("utf8", 0, bytesRead).split("\n")[0];
          if (!firstLine) continue;

          const record = JSON.parse(firstLine);
          const payload = record.payload || record;
          const sessionCwd = payload.cwd || "";
          const sessionId = payload.id || "";

          if (sessionId && sessionCwd === cwd && stat.mtimeMs > bestMtime) {
            bestMatch = { sessionId, source: filePath };
            bestMtime = stat.mtimeMs;
          }
        } catch {
          continue;
        }
      }
    }
    return bestMatch;
  } catch {
    return null;
  }
}

/**
 * Resolve provider session ID directly from session files (no probe needed).
 * @param {string} agentType - "claude-code" or "codex"
 * @param {object} opts - { pid, cwd }
 */
function resolveSessionFromFile(agentType, opts = {}) {
  if (agentType === "claude-code") {
    return resolveClaudeSessionFromFile(opts.pid);
  }
  if (agentType === "codex") {
    return resolveCodexSessionFromFile(opts.cwd);
  }
  return null;
}

/**
 * Retry reading session file (agent may not have written it yet)
 */
async function resolveSessionFromFileWithRetries(agentType, opts = {}, attempts = 10, intervalMs = 1000) {
  for (let i = 0; i < attempts; i += 1) {
    const resolved = resolveSessionFromFile(agentType, opts);
    if (resolved && resolved.sessionId) return resolved;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * Schedule provider session resolution.
 * Tries direct file read first (fast, non-invasive), falls back to probe if needed.
 *
 * @param {Object} options
 * @param {string} options.projectRoot - Project root directory
 * @param {string} options.subscriberId - Subscriber ID (e.g., "claude-code:abc123")
 * @param {string} options.agentType - Agent type ("claude-code" or "codex")
 * @param {string} options.nickname - Agent nickname (e.g., "claude-47")
 * @param {number} options.agentPid - Agent child process PID (for claude-code)
 * @param {string} options.agentCwd - Agent working directory (for codex)
 * @param {number} options.delayMs - Delay before starting resolution
 * @param {number} options.fileAttempts - File read retry attempts
 * @param {number} options.fileIntervalMs - File read retry interval
 * @param {number} options.probeAttempts - Probe retry attempts (fallback)
 * @param {number} options.probeIntervalMs - Probe retry interval (fallback)
 * @param {Function} options.onResolved - Callback when session ID is found
 */
function scheduleProviderSessionResolve({
  projectRoot,
  subscriberId,
  agentType,
  nickname,
  agentPid = 0,
  agentCwd = "",
  delayMs = 3000,
  fileAttempts = 10,
  fileIntervalMs = 1000,
  probeAttempts = 15,
  probeIntervalMs = 2000,
  onResolved = null,
}) {
  if (!subscriberId || !agentType) return null;
  if (agentType !== "codex" && agentType !== "claude-code") return null;

  const marker = nickname ? buildProbeMarker(nickname) : "";
  if (marker) {
    persistProbeMarker(projectRoot, subscriberId, marker);
  }

  let executed = false;
  let cancelled = false;
  let timer = null;

  const execute = async () => {
    if (executed || cancelled) return;
    executed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    // 1. Try direct file read (fast, non-invasive)
    const fileOpts = { pid: agentPid, cwd: agentCwd || projectRoot };
    const fileResolved = await resolveSessionFromFileWithRetries(
      agentType, fileOpts, fileAttempts, fileIntervalMs,
    );
    if (cancelled) return;
    if (fileResolved && fileResolved.sessionId) {
      persistProviderSession(projectRoot, subscriberId, fileResolved);
      if (typeof onResolved === "function") {
        onResolved(subscriberId, fileResolved);
      }
      return;
    }

    // 2. Fallback to probe (inject command + search history)
    // Re-check cancelled: AGENT_READY may have resolved session while we were retrying
    if (cancelled) return;
    if (nickname) {
      await executeProbe({
        projectRoot,
        subscriberId,
        agentType,
        nickname,
        attempts: probeAttempts,
        intervalMs: probeIntervalMs,
        onResolved,
      });
    }
  };

  // Schedule delayed execution
  timer = setTimeout(execute, delayMs);

  // Return handle for early trigger or cancellation
  return {
    subscriberId,
    marker,
    triggerNow: execute,
    cancel: () => {
      cancelled = true;
      executed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * Schedule a provider session probe (legacy wrapper)
 */
function scheduleProviderSessionProbe({
  projectRoot,
  subscriberId,
  agentType,
  nickname,
  delayMs = 8000,
  attempts = 15,
  intervalMs = 2000,
  onResolved = null,
  agentPid = 0,
  agentCwd = "",
}) {
  // Delegate to new resolve function which tries file read first
  return scheduleProviderSessionResolve({
    projectRoot,
    subscriberId,
    agentType,
    nickname,
    agentPid,
    agentCwd,
    delayMs: agentPid || agentCwd ? 3000 : delayMs,
    probeAttempts: attempts,
    probeIntervalMs: intervalMs,
    onResolved,
  });
}

module.exports = {
  scheduleProviderSessionProbe,
  scheduleProviderSessionResolve,
  resolveSessionFromFile,
  persistProviderSession,
  loadProviderSessionCache,
  __private: {
    buildProbeCommand,
    recordContainsMarker,
    containsProbeCommand,
    escapeRegExp,
    resolveClaudeSessionFromFile,
    resolveCodexSessionFromFile,
  },
};

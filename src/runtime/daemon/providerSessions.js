const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadAgentsData, updateAgentsData } = require("../../coordination/state/agentsStore");
const { getUfooPaths } = require("../../coordination/state/paths");

function persistProviderSession(projectRoot, subscriberId, payload) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  return updateAgentsData(filePath, (data) => {
    const meta = data.agents[subscriberId] || {};
    if (meta.status === "inactive") return false;
    if (Object.entries(data.agents).some(([id, other]) => id !== subscriberId
      && other.status === "active" && other.provider_session_id === payload.sessionId)) return false;
    data.agents[subscriberId] = {
      ...meta,
      provider_session_id: payload.sessionId || "",
      provider_session_source: payload.source || "",
      provider_session_updated_at: new Date().toISOString(),
    };
    return true;
  });
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
function readFirstJsonLine(filePath) {
  const fd = fs.openSync(filePath, "r");
  const chunks = [];
  let total = 0;
  try {
    // Modern session_meta includes base instructions and can exceed 4 KB.
    // Bound memory while reading the complete first JSON record.
    while (total < 2 * 1024 * 1024) {
      const buffer = Buffer.alloc(64 * 1024);
      const size = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!size) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const newline = buffer.subarray(0, size).indexOf(10);
      chunks.push(buffer.subarray(0, newline === -1 ? size : newline));
      total += size;
      if (newline !== -1) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    return null;
  } finally { fs.closeSync(fd); }
}

function resolveCodexSessionFromFile(cwd, options = {}) {
  if (!cwd) return null;
  try {
    let expectedSession = String(options.sessionId || "");
    let startedAt = options.startedAt || "";
    let claimedSessions = new Set();
    if (options.projectRoot && options.subscriberId) {
      const data = loadAgentsData(getUfooPaths(options.projectRoot).agentsFile);
      const own = data.agents[options.subscriberId];
      if (!own || own.status !== "active") return null;
      expectedSession = expectedSession || own.provider_session_id || "";
      startedAt = startedAt || own.joined_at || "";
      const peers = Object.entries(data.agents).filter(([id, meta]) => id !== options.subscriberId
        && meta.status === "active" && meta.agent_type === "codex");
      // Cwd is not a process identity. Parallel launches must bind through an
      // exact provider session id instead of racing for the newest rollout.
      if (!expectedSession && peers.length) return null;
      claimedSessions = new Set(peers.map(([, meta]) => meta.provider_session_id).filter(Boolean));
    }
    const startedAtMs = Date.parse(startedAt);
    const now = new Date();
    // Check today and yesterday (session may have started before midnight)
    const dates = [now];
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    dates.push(yesterday);

    const matches = new Map();

    for (const d of dates) {
      const yyyy = String(d.getFullYear());
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
      const dir = path.join(codexHome, "sessions", yyyy, mm, dd);
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir)
        .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));

      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          const record = readFirstJsonLine(filePath);
          if (!record) continue;
          const payload = record.payload || record;
          const sessionCwd = payload.cwd || "";
          const sessionId = payload.id || "";

          if (!sessionId || sessionCwd !== cwd || claimedSessions.has(sessionId)) continue;
          if (expectedSession && sessionId !== expectedSession) continue;
          const createdAt = Date.parse(payload.timestamp || record.timestamp || "");
          if (!expectedSession && Number.isFinite(startedAtMs)
            && (Number.isFinite(createdAt) ? createdAt : stat.birthtimeMs) < startedAtMs) continue;
          matches.set(sessionId, { sessionId, source: filePath });
        } catch {
          continue;
        }
      }
    }
    return matches.size === 1 ? matches.values().next().value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve Kimi Code session ID from the session index.
 * Kimi writes $KIMI_CODE_HOME/session_index.jsonl (default ~/.kimi-code/)
 * with one JSON line per session: { sessionId, sessionDir, workDir }.
 * The file is append-only, so the last line matching the cwd is the most
 * recent session for that directory.
 */
function resolveKimiSessionFromIndex(cwd) {
  if (!cwd) return null;
  try {
    const kimiHome = String(process.env.KIMI_CODE_HOME || "").trim()
      || path.join(os.homedir(), ".kimi-code");
    const indexPath = path.join(kimiHome, "session_index.jsonl");
    if (!fs.existsSync(indexPath)) return null;
    const lines = fs.readFileSync(indexPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const record = JSON.parse(line);
        const sessionId = record.sessionId || record.session_id || "";
        const workDir = record.workDir || record.work_dir || record.cwd || "";
        if (sessionId && workDir === cwd) {
          return { sessionId, source: indexPath };
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve provider session ID directly from session files.
 * @param {string} agentType - "claude-code", "codex" or "kimi"
 * @param {object} opts - { pid, cwd }
 */
function resolveSessionFromFile(agentType, opts = {}) {
  if (agentType === "claude-code") {
    return resolveClaudeSessionFromFile(opts.pid);
  }
  if (agentType === "codex") {
    return resolveCodexSessionFromFile(opts.cwd, opts);
  }
  if (agentType === "kimi") {
    return resolveKimiSessionFromIndex(opts.cwd);
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
 * Uses provider session files only. This intentionally avoids injecting
 * `/ufoo <nickname>` / `$ufoo <nickname>` into agent terminals.
 *
 * @param {Object} options
 * @param {string} options.projectRoot - Project root directory
 * @param {string} options.subscriberId - Subscriber ID (e.g., "claude-code:abc123")
 * @param {string} options.agentType - Agent type ("claude-code" or "codex")
 * @param {number} options.agentPid - Agent child process PID (for claude-code)
 * @param {string} options.agentCwd - Agent working directory (for codex)
 * @param {number} options.delayMs - Delay before starting resolution
 * @param {number} options.fileAttempts - File read retry attempts
 * @param {number} options.fileIntervalMs - File read retry interval
 * @param {Function} options.onResolved - Callback when session ID is found
 */
function scheduleProviderSessionResolve({
  projectRoot,
  subscriberId,
  agentType,
  agentPid = 0,
  agentCwd = "",
  delayMs = 3000,
  fileAttempts = 10,
  fileIntervalMs = 1000,
  onResolved = null,
}) {
  if (!subscriberId || !agentType) return null;
  if (agentType !== "codex" && agentType !== "claude-code" && agentType !== "kimi") return null;

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
    const fileOpts = { pid: agentPid, cwd: agentCwd || projectRoot, projectRoot, subscriberId };
    const fileResolved = await resolveSessionFromFileWithRetries(
      agentType, fileOpts, fileAttempts, fileIntervalMs,
    );
    if (cancelled) return;
    if (fileResolved && fileResolved.sessionId) {
      if (!persistProviderSession(projectRoot, subscriberId, fileResolved)) return;
      if (typeof onResolved === "function") {
        onResolved(subscriberId, fileResolved);
      }
      return;
    }

    // No terminal injection fallback. Session IDs are resolved from provider files only.
  };

  // Schedule delayed execution
  timer = setTimeout(execute, delayMs);

  // Return handle for early trigger or cancellation
  return {
    subscriberId,
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

module.exports = {
  scheduleProviderSessionResolve,
  resolveSessionFromFile,
  persistProviderSession,
  loadProviderSessionCache,
  __private: {
    resolveClaudeSessionFromFile,
    resolveCodexSessionFromFile,
    resolveKimiSessionFromIndex,
  },
};

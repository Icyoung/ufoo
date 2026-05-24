const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadAgentsData, saveAgentsData } = require("../../coordination/state/agentsStore");
const { getUfooPaths } = require("../../coordination/state/paths");

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
 * Resolve provider session ID directly from session files.
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
  if (agentType !== "codex" && agentType !== "claude-code") return null;

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
  },
};

const fs = require("fs");

/**
 * Centralized helper for writing activity_state to all-agents.json.
 * Used by both ptyRunner and notifier to avoid duplicated read-modify-write logic.
 *
 * - Only writes when state actually changes (monotonic activity_since).
 * - Respects priority: won't overwrite working/waiting_input/blocked with idle
 *   unless explicitly requested via `force` option.
 */
function writeActivityState(agentsFilePath, subscriber, state, options = {}) {
  const { since, force = false } = options;
  try {
    if (!agentsFilePath || !fs.existsSync(agentsFilePath)) return false;
    const data = JSON.parse(fs.readFileSync(agentsFilePath, "utf8"));
    if (!data.agents || !data.agents[subscriber]) return false;

    const current = data.agents[subscriber].activity_state;

    // Skip if state unchanged (monotonic update)
    if (current === state) return false;

    // Don't overwrite higher-priority states with lower-priority states
    // unless force is set (e.g. explicit markIdle from ptyRunner/launcher)
    if (!force && (current === "working" || current === "waiting_input" || current === "blocked")) {
      if (state === "idle" || state === "ready") return false;
    }

    data.agents[subscriber].activity_state = state;
    data.agents[subscriber].activity_since = since
      ? new Date(since).toISOString()
      : new Date().toISOString();
    fs.writeFileSync(agentsFilePath, JSON.stringify(data, null, 2));
    return true;
  } catch {
    return false;
  }
}

module.exports = { writeActivityState };

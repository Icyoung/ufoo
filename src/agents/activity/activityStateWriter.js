const fs = require("fs");
const { readJSON, writeJSON } = require("../../coordination/bus/utils");
const { appendAgentRegistryDiagnostic } = require("../../coordination/state/agentRegistryDiagnostics");

/**
 * Centralized helper for writing activity_state to all-agents.json.
 *
 * - Writes when `state` OR `detail` changes (state change refreshes `activity_since`,
 *   detail-only change keeps the existing `activity_since` so the "busy duration"
 *   shown in dashboards stays continuous across e.g. `working · thinking` →
 *   `working · tool bash`).
 * - Respects priority: won't overwrite working/waiting_input/blocked with idle
 *   unless explicitly requested via `force` option. Detail-only updates within
 *   the same state are always allowed.
 */
function writeActivityState(agentsFilePath, subscriber, state, options = {}) {
  const { since, force = false } = options;
  const detail = typeof options.detail === "string" ? options.detail : "";
  try {
    if (!agentsFilePath || !fs.existsSync(agentsFilePath)) return false;
    const data = readJSON(agentsFilePath, null);
    if (!data) return false;
    if (!data.agents || !data.agents[subscriber]) {
      appendAgentRegistryDiagnostic(agentsFilePath, "activity_state_subscriber_missing", {
        source: "agent.activityStateWriter.writeActivityState",
        subscriber,
        state,
        known_ids: Object.keys(data.agents || {}).sort(),
      });
      return false;
    }

    const agent = data.agents[subscriber];
    const currentState = agent.activity_state;
    const currentDetail = typeof agent.activity_detail === "string" ? agent.activity_detail : "";

    if (currentState === state && currentDetail === detail) return false;

    if (
      currentState !== state
      && !force
      && (currentState === "working" || currentState === "waiting_input" || currentState === "blocked")
    ) {
      if (state === "idle" || state === "ready") return false;
    }

    agent.activity_state = state;
    if (detail) {
      agent.activity_detail = detail;
    } else {
      delete agent.activity_detail;
    }
    if (currentState !== state) {
      agent.activity_since = since
        ? new Date(since).toISOString()
        : new Date().toISOString();
    } else if (!agent.activity_since) {
      agent.activity_since = new Date().toISOString();
    }
    writeJSON(agentsFilePath, data);
    return true;
  } catch {
    return false;
  }
}

module.exports = { writeActivityState };

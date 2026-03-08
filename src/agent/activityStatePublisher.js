const fs = require("fs");
const path = require("path");
const { writeActivityState } = require("./activityStateWriter");

/**
 * Unified activity state publisher.
 * Encapsulates the "write to disk + broadcast event" pattern used by
 * ptyRunner, launcher, notifier, and internalRunner.
 *
 * @param {object} options
 * @param {string} options.agentsFile  - Path to all-agents.json
 * @param {string} options.subscriber  - Subscriber ID (e.g. "claude-code:abc123")
 * @param {string} options.projectRoot - Project root (unused, kept for API compat)
 * @param {boolean} [options.force=true] - Force overwrite priority-protected states
 */
function createActivityStatePublisher(options = {}) {
  const {
    agentsFile,
    subscriber,
    force = true,
  } = options;

  let lastState = "";

  function publish(state, extra = {}) {
    if (state === lastState) return false;
    const since = extra.since || undefined;
    const changed = writeActivityState(agentsFile, subscriber, state, { since, force });
    if (!changed) return false;
    lastState = state;
    // Write to bus events directory for daemon bridge to pick up.
    // Writes directly to events dir to avoid queueing into subscriber pending files.
    try {
      const eventsDir = path.join(
        path.dirname(path.dirname(agentsFile)),
        "bus", "events"
      );
      const date = new Date().toISOString().slice(0, 10);
      const eventFile = path.join(eventsDir, `${date}.jsonl`);
      const entry = {
        timestamp: new Date().toISOString(),
        type: "status/agent",
        event: "activity_state_changed",
        publisher: subscriber,
        target: "*",
        data: {
          subscriber,
          state,
          previous: extra.previous || "",
          ...extra.detail ? { detail: extra.detail } : {},
        },
      };
      fs.appendFileSync(eventFile, JSON.stringify(entry) + "\n");
    } catch {
      // ignore event write errors — dashboard polling is the fallback
    }
    return true;
  }

  function getLastState() {
    return lastState;
  }

  return { publish, getLastState };
}

module.exports = { createActivityStatePublisher };

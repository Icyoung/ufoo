"use strict";

const fs = require("fs");
const path = require("path");
const { readJSON } = require("../../coordination/bus/utils");
const { writeActivityState } = require("./activityStateWriter");

/**
 * Unified activity state publisher.
 * Encapsulates the "write to disk + broadcast event" pattern used by
 * launcher, notifier, and internalRunner.
 *
 * Dedupe key is `state|detail` so that within the same canonical state
 * (e.g. `working`) callers can publish detail transitions like
 * `thinking` → `tool bash` and have them propagate to the dashboard.
 *
 * @param {object} options
 * @param {string} options.agentsFile  - Path to all-agents.json
 * @param {string} options.subscriber  - Subscriber ID (e.g. "claude-code:abc123")
 * @param {string} options.projectRoot - Project root (unused, kept for API compat)
 * @param {boolean} [options.force=true] - Force overwrite priority-protected states
 * publish(state, extra, { force, reconcile }) can override defaults for one
 * transition. `reconcile: true` skips in-memory dedupe when disk disagrees
 * (daemon inject stamp / lost-update healing).
 */
function createActivityStatePublisher(options = {}) {
  const {
    agentsFile,
    subscriber,
    force = true,
  } = options;

  let lastState = "";
  let lastDetail = "";

  function readDiskActivity() {
    try {
      if (!agentsFile || !fs.existsSync(agentsFile)) return null;
      const data = readJSON(agentsFile, null);
      const meta = data && data.agents && data.agents[subscriber];
      if (!meta || typeof meta !== "object") return null;
      return {
        state: typeof meta.activity_state === "string" ? meta.activity_state : "",
        detail: typeof meta.activity_detail === "string" ? meta.activity_detail : "",
      };
    } catch {
      return null;
    }
  }

  function publish(state, extra = {}, publishOptions = {}) {
    const detail = typeof extra.detail === "string" ? extra.detail : "";
    const reconcile = publishOptions.reconcile === true;
    if (!reconcile && state === lastState && detail === lastDetail) return false;
    if (reconcile) {
      const disk = readDiskActivity();
      if (disk && disk.state === state && disk.detail === detail) {
        lastState = state;
        lastDetail = detail;
        return false;
      }
    }
    const since = extra.since || undefined;
    const effectiveForce = typeof publishOptions.force === "boolean"
      ? publishOptions.force
      : force;
    const changed = writeActivityState(agentsFile, subscriber, state, {
      since,
      force: effectiveForce,
      detail,
    });
    if (!changed) return false;
    lastState = state;
    lastDetail = detail;
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
          ...detail ? { detail } : {},
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

  function getLastDetail() {
    return lastDetail;
  }

  return { publish, getLastState, getLastDetail };
}

module.exports = { createActivityStatePublisher };

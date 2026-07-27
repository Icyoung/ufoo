"use strict";

const fs = require("fs");
const { readJSON } = require("../../coordination/bus/utils");

const DEFAULT_GRACE_MS = 5000;
const BUSY_DISK_STATES = new Set(["working", "waiting_input", "blocked"]);
const DELIVERABLE_LOCAL_STATES = new Set(["idle", "ready"]);

function asState(value = "") {
  return String(value || "").trim().toLowerCase();
}

function resolveGraceMs(detector, options = {}) {
  if (Number.isFinite(options.graceMs) && options.graceMs > 0) {
    return options.graceMs;
  }
  const quiet = Number(detector && detector.quietWindowMs);
  const base = Number.isFinite(quiet) && quiet > 0 ? quiet : DEFAULT_GRACE_MS;
  // Cap so internal-pty (30s quiet) does not leave inject stamps stuck that long.
  return Math.min(base, DEFAULT_GRACE_MS);
}

function readDiskMeta(agentsFile, subscriber) {
  if (!agentsFile || !subscriber || !fs.existsSync(agentsFile)) return null;
  try {
    const data = readJSON(agentsFile, null);
    const meta = data && data.agents && data.agents[subscriber];
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

/**
 * Heal false `working` when the in-process ActivityDetector already believes
 * the agent is deliverable (idle/ready) but all-agents.json still says busy.
 *
 * Typical cause: DeliveryScheduler stamps `working` (detail=inject) after
 * inject while the detector never saw meaningful PTY output, so it never
 * re-publishes idle (publisher dedupe + no state transition).
 *
 * Waits `graceMs` (≤ quiet window, capped at 5s) after disk `activity_since`
 * so the inject stamp can still close the mid-turn double-inject race.
 *
 * Does not clear `waiting_input` / `blocked` — those need explicit recovery.
 *
 * @returns {{ ok: boolean, reconciled: boolean, reason: string }}
 */
function reconcileDetectorOwnedActivity(options = {}) {
  const {
    detector,
    publisher,
    agentsFile,
    subscriber,
    now = Date.now(),
  } = options;

  if (!detector || !publisher || !agentsFile || !subscriber) {
    return { ok: false, reconciled: false, reason: "missing" };
  }

  const snap = typeof detector.getState === "function"
    ? detector.getState()
    : { state: "", since: now, detail: "" };
  const local = asState(snap.state);
  if (!DELIVERABLE_LOCAL_STATES.has(local)) {
    return { ok: true, reconciled: false, reason: "local_busy" };
  }

  const diskMeta = readDiskMeta(agentsFile, subscriber);
  if (!diskMeta) {
    return { ok: false, reconciled: false, reason: "missing_agent" };
  }

  const diskState = asState(diskMeta.activity_state);
  if (diskState !== "working") {
    return { ok: true, reconciled: false, reason: BUSY_DISK_STATES.has(diskState) ? "disk_gated" : "disk_ok" };
  }

  const graceMs = resolveGraceMs(detector, options);
  const sinceMs = Date.parse(String(diskMeta.activity_since || ""));
  const diskAge = Number.isFinite(sinceMs) ? Math.max(0, now - sinceMs) : graceMs;
  if (diskAge < graceMs) {
    return { ok: true, reconciled: false, reason: "grace" };
  }

  const publishState = local === "ready" ? "idle" : local;
  const changed = publisher.publish(publishState, {
    since: snap.since,
    previous: diskState,
    detail: "",
  }, { force: true, reconcile: true });

  return {
    ok: true,
    reconciled: Boolean(changed),
    reason: changed ? "cleared" : "unchanged",
  };
}

module.exports = {
  DEFAULT_GRACE_MS,
  reconcileDetectorOwnedActivity,
  resolveGraceMs,
};

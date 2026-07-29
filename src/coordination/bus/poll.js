"use strict";

const fs = require("fs");
const path = require("path");

function eventIdentity(event = {}) {
  const seq = Number(event && event.seq);
  if (Number.isFinite(seq) && seq > 0) {
    return `seq:${seq}`;
  }
  return `event:${JSON.stringify(event || {})}`;
}

function enumerateEventKeys(events = []) {
  const occurrences = new Map();
  return events.map((event) => {
    const identity = eventIdentity(event);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    return {
      event,
      key: `${identity}#${occurrence}`,
    };
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

function acquirePollLease(pidFile, options = {}) {
  const pid = Number(options.pid) || process.pid;
  const operation = String(options.operation || "poll --follow");
  const isAlive = typeof options.isAlive === "function"
    ? options.isAlive
    : defaultIsPidAlive;

  fs.mkdirSync(path.dirname(pidFile), { recursive: true });

  if (fs.existsSync(pidFile)) {
    let existing = 0;
    try {
      existing = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    } catch {
      existing = 0;
    }
    if (Number.isFinite(existing) && existing > 0 && isAlive(existing)) {
      throw new Error(`${operation} is already running (pid=${existing})`);
    }
    fs.rmSync(pidFile, { force: true });
  }

  let fd;
  try {
    fd = fs.openSync(pidFile, "wx");
    fs.writeFileSync(fd, `${pid}\n`, "utf8");
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new Error(`${operation} is already starting for this subscriber`);
    }
    throw err;
  } finally {
    if (typeof fd === "number") fs.closeSync(fd);
  }

  return { pid, pidFile };
}

function releasePollLease(lease) {
  if (!lease || !lease.pidFile) return false;
  try {
    const existing = Number.parseInt(
      fs.readFileSync(lease.pidFile, "utf8").trim(),
      10
    );
    if (existing !== lease.pid) return false;
    fs.rmSync(lease.pidFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function runPendingPoll(options = {}) {
  const readPending = options.readPending;
  const onEvents = options.onEvents;
  const sleep = options.sleep || defaultSleep;
  const signal = options.signal || null;
  const intervalMs = Math.max(250, Number(options.intervalMs) || 2000);
  const maxIterations = Number.isFinite(options.maxIterations)
    ? Math.max(0, Math.floor(options.maxIterations))
    : Infinity;

  if (typeof readPending !== "function") {
    throw new Error("runPendingPoll requires readPending");
  }
  if (typeof onEvents !== "function") {
    throw new Error("runPendingPoll requires onEvents");
  }
  if (maxIterations === 0) {
    return { iterations: 0 };
  }

  let inFlightKeys = new Set();
  let iterations = 0;

  while (!signal || !signal.aborted) {
    // eslint-disable-next-line no-await-in-loop
    const pending = await readPending();
    const keyed = enumerateEventKeys(Array.isArray(pending) ? pending : []);
    const currentKeys = new Set(keyed.map((entry) => entry.key));
    const hasUnacknowledgedBatch = Array.from(inFlightKeys)
      .some((key) => currentKeys.has(key));

    if (!hasUnacknowledgedBatch) {
      inFlightKeys = new Set();
    }

    if (inFlightKeys.size === 0 && keyed.length > 0) {
      const batch = keyed.map((entry) => entry.event);
      // eslint-disable-next-line no-await-in-loop
      await onEvents(batch);
      inFlightKeys = currentKeys;
    }

    iterations += 1;
    if (iterations >= maxIterations || (signal && signal.aborted)) break;

    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }

  return { iterations };
}

module.exports = {
  acquirePollLease,
  enumerateEventKeys,
  eventIdentity,
  releasePollLease,
  runPendingPoll,
};

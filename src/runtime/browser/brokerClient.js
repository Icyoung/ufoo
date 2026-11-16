"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const lockfile = require("proper-lockfile");
const { resolveNodeExecutable } = require("../process/nodeExecutable");
const {
  brokerSocketPath,
  brokerLockPath,
  privateDir,
} = require("./paths");

function requestBroker(op, params = {}, { env = process.env, timeoutMs = 10000 } = {}) {
  const sockPath = brokerSocketPath(env);
  if (!fs.existsSync(sockPath)) {
    return Promise.resolve({ ok: false, code: "broker_not_running", error: "Browser broker is not running" });
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(sockPath);
    let buffer = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish({ ok: false, code: "broker_timeout", error: `Browser broker request timed out (${op})` });
    }, timeoutMs);
    timer.unref?.();
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ op, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx).trim();
      try {
        finish(JSON.parse(line));
      } catch {
        finish({ ok: false, code: "broker_invalid_response", error: "Malformed broker response" });
      }
    });
    socket.on("error", (err) => {
      finish({ ok: false, code: "broker_unreachable", error: err?.message || "Browser broker unreachable" });
    });
  });
}

async function pingBroker({ env = process.env } = {}) {
  const res = await requestBroker("ping", {}, { env, timeoutMs: 1500 });
  return Boolean(res && res.ok);
}

/**
 * Ensure the user-scoped browser broker is running, starting a detached user-level
 * broker process on demand if neither GlobalDaemon nor a standalone broker is up.
 */
async function ensureBrokerRunning({ env = process.env, waitTimeoutMs = 6000 } = {}) {
  if (await pingBroker({ env })) return { ok: true, started: false };
  fs.mkdirSync(privateDir(env), { recursive: true, mode: 0o700 });
  const lockPath = brokerLockPath(env);
  let release;
  try {
    release = await lockfile.lock(lockPath, { realpath: false, stale: 15000, retries: { retries: 5, minTimeout: 100, maxTimeout: 300 } });
  } catch {
    // Another process may be starting it; fall through to wait loop.
  }
  try {
    if (await pingBroker({ env })) return { ok: true, started: false };
    const cliEntry = path.resolve(__dirname, "..", "..", "..", "bin", "ufoo.js");
    const child = spawn(resolveNodeExecutable(), [cliEntry, "browser", "broker-serve"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env, UFOO_BROWSER_BROKER_CHILD: "1" },
    });
    child.unref();

    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      if (await pingBroker({ env })) return { ok: true, started: true };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 120));
    }
    return { ok: false, code: "broker_start_failed", error: "Timed out waiting for user browser broker to start" };
  } finally {
    if (release) await release().catch(() => {});
  }
}

async function notifyBrokerConfigChanged({ env = process.env } = {}) {
  if (!(await pingBroker({ env }))) return { ok: false, notified: false };
  const res = await requestBroker("config_changed", {}, { env });
  return { ok: Boolean(res && res.ok), notified: true, ...res };
}

module.exports = {
  requestBroker,
  pingBroker,
  ensureBrokerRunning,
  notifyBrokerConfigChanged,
};

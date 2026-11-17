"use strict";

const { randomUUID } = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const lockfile = require("proper-lockfile");
const {
  macPrivateDir,
  macDaemonLockPath,
  macDaemonInfoPath,
  macInputLockPath,
  macHelperSocketPath,
} = require("./paths");
const {
  ensureHelperCompiled,
  resolveCachedHelperBinary,
} = require("./helperCompiler");

function sendRawSocketRpc(socketPath, method, params = {}, {
  timeoutMs = 15000,
  signal = null,
  mutating = false,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("Mac operation cancelled before execution"), { code: "cancelled" }));
      return;
    }
    const id = randomUUID();
    let settled = false;
    let dispatched = false;
    let buffer = "";

    const socket = net.createConnection(socketPath);

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      try { socket.destroy(); } catch {}
      if (err) reject(err);
      else resolve(data);
    };

    const failTransport = (message, fallbackCode = "mac_helper_unavailable") => {
      if (dispatched && mutating) {
        finish(Object.assign(
          new Error(`${message}. The Mac GUI action outcome is uncertain; inspect screen/window state before retrying.`),
          { code: "mac_action_uncertain" },
        ));
      } else {
        finish(Object.assign(new Error(message), { code: fallbackCode }));
      }
    };

    const onAbort = () => {
      failTransport("Mac operation cancelled", "cancelled");
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      failTransport(`Mac helper RPC '${method}' timed out after ${timeoutMs}ms`, "mac_timeout");
    }, timeoutMs);

    socket.on("connect", () => {
      const line = `${JSON.stringify({ id, method, params })}\n`;
      socket.write(line, "utf8", (err) => {
        if (!err) dispatched = true;
      });
      dispatched = true;
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const rawLine = buffer.slice(0, nl).trim();
      try {
        const parsed = JSON.parse(rawLine);
        finish(null, parsed);
      } catch (err) {
        failTransport(`Invalid JSON from Mac helper: ${err.message}`, "mac_protocol_error");
      }
    });

    socket.on("error", (err) => {
      failTransport(err.message || "Mac helper socket error", "mac_helper_unavailable");
    });

    socket.on("close", () => {
      if (!settled) {
        failTransport("Mac helper connection closed unexpectedly", "mac_helper_unavailable");
      }
    });
  });
}

async function pingHelperDaemon({ env = process.env, timeoutMs = 900, throwOnTimeout = false } = {}) {
  const socketPath = macHelperSocketPath(env);
  if (!fs.existsSync(socketPath)) return null;
  try {
    const res = await sendRawSocketRpc(socketPath, "ping", {}, { timeoutMs, mutating: false });
    if (res && res.ok && res.result) return res.result;
    return null;
  } catch (err) {
    // RPCs are serialized by the helper. A slow action can delay a healthy
    // daemon's ping; never unlink its socket or spawn a competing controller.
    if (throwOnTimeout && err.code === "mac_timeout") {
      throw Object.assign(new Error("Mac helper is busy or unresponsive; wait for the current operation before retrying."), {
        code: "mac_helper_busy",
      });
    }
    return null;
  }
}

function readDaemonInfo(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(macDaemonInfoPath(env), "utf8"));
  } catch {
    return null;
  }
}

function writeDaemonInfo(info, env = process.env) {
  fs.mkdirSync(macPrivateDir(env), { recursive: true, mode: 0o700 });
  fs.writeFileSync(macDaemonInfoPath(env), JSON.stringify(info, null, 2), { mode: 0o600 });
}

async function stopHelperDaemon({ env = process.env } = {}) {
  const socketPath = macHelperSocketPath(env);
  let stopped = false;
  if (fs.existsSync(socketPath)) {
    try {
      const res = await sendRawSocketRpc(socketPath, "shutdown", {}, { timeoutMs: 1500, mutating: false });
      stopped = Boolean(res && res.ok);
    } catch {
      // Fall through to PID check
    }
  }
  const info = readDaemonInfo(env);
  if (!stopped && info && Number.isInteger(info.pid) && info.pid > 1) {
    try {
      process.kill(info.pid, "SIGTERM");
      stopped = true;
    } catch {
      // Already exited
    }
  }
  try { fs.unlinkSync(socketPath); } catch {}
  try { fs.unlinkSync(macDaemonInfoPath(env)); } catch {}
  return { ok: true, stopped };
}

async function ensureHelperDaemon({
  env = process.env,
  platform = process.platform,
  idleMs = 600000,
  ensureCompiledImpl = ensureHelperCompiled,
} = {}) {
  const compiled = await ensureCompiledImpl({ env, platform });
  const socketPath = macHelperSocketPath(env);

  const live = await pingHelperDaemon({ env, throwOnTimeout: true });
  const info = readDaemonInfo(env);
  if (live && (!info?.hash || info.hash === compiled.hash)) {
    return { ok: true, socketPath, binaryPath: compiled.binaryPath, status: live, spawned: false };
  }

  fs.mkdirSync(macPrivateDir(env), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  const release = await lockfile.lock(macDaemonLockPath(env), {
    realpath: false,
    stale: 30000,
    update: 10000,
    retries: { retries: 15, minTimeout: 80, maxTimeout: 300 },
  });

  try {
    const secondPing = await pingHelperDaemon({ env, throwOnTimeout: true });
    const secondInfo = readDaemonInfo(env);
    if (secondPing && (!secondInfo?.hash || secondInfo.hash === compiled.hash)) {
      return { ok: true, socketPath, binaryPath: compiled.binaryPath, status: secondPing, spawned: false };
    }
    if (secondPing) {
      await stopHelperDaemon({ env });
    } else {
      try { fs.unlinkSync(socketPath); } catch {}
    }

    const child = spawn(
      compiled.binaryPath,
      ["daemon", "--socket", socketPath, "--idle-ms", String(idleMs)],
      {
        detached: true,
        stdio: "ignore",
        env,
      },
    );
    child.unref();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60));
      const ready = await pingHelperDaemon({ env, timeoutMs: 600 });
      if (ready) {
        writeDaemonInfo({
          pid: ready.pid || child.pid,
          socketPath,
          binaryPath: compiled.binaryPath,
          hash: compiled.hash,
          startedAt: new Date().toISOString(),
        }, env);
        return { ok: true, socketPath, binaryPath: compiled.binaryPath, status: ready, spawned: true };
      }
    }

    throw Object.assign(
      new Error("Failed to start ufoo-mac-helper daemon within 5s"),
      { code: "mac_daemon_start_failed" },
    );
  } finally {
    await release().catch(() => {});
  }
}

async function callHelperRpc(method, params = {}, {
  env = process.env,
  platform = process.platform,
  timeoutMs = 20000,
  signal = null,
  mutating = false,
  ensureDaemonImpl = ensureHelperDaemon,
} = {}) {
  const daemon = await ensureDaemonImpl({ env, platform });
  try {
    return await sendRawSocketRpc(daemon.socketPath, method, params, { timeoutMs, signal, mutating });
  } catch (err) {
    if (!mutating && err.code === "mac_helper_unavailable") {
      const restarted = await ensureDaemonImpl({ env, platform });
      return sendRawSocketRpc(restarted.socketPath, method, params, { timeoutMs, signal, mutating: false });
    }
    throw err;
  }
}

async function acquireMacInputLease({ env = process.env } = {}) {
  fs.mkdirSync(macPrivateDir(env), { recursive: true, mode: 0o700 });
  try {
    return await lockfile.lock(macInputLockPath(env), {
      realpath: false,
      stale: 20000,
      update: 5000,
      retries: { retries: 25, minTimeout: 60, maxTimeout: 200 },
    });
  } catch (err) {
    if (err && err.code === "ELOCKED") {
      throw Object.assign(
        new Error("Another ufoo/ucode agent is currently operating the Mac mouse/keyboard. Wait briefly and retry."),
        { code: "mac_input_busy" },
      );
    }
    throw err;
  }
}

module.exports = {
  sendRawSocketRpc,
  pingHelperDaemon,
  ensureHelperDaemon,
  stopHelperDaemon,
  callHelperRpc,
  acquireMacInputLease,
  resolveCachedHelperBinary,
};

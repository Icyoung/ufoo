#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const UfooInit = require("../src/init");
const { socketPath, isRunning } = require("../src/daemon");
const { connectWithRetry } = require("../src/chat/transport");
const { createDaemonTransport } = require("../src/chat/daemonTransport");
const { createDaemonCoordinator } = require("../src/chat/daemonCoordinator");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntArg(argv, flag, fallback) {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return fallback;
  const parsed = Number.parseInt(String(argv[idx + 1] || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStringArg(argv, flag, fallback) {
  const idx = argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= argv.length) return fallback;
  const value = String(argv[idx + 1] || "").trim();
  return value || fallback;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return 0;
  const clamped = Math.max(0, Math.min(1, p));
  const idx = Math.ceil(clamped * sortedValues.length) - 1;
  const safeIdx = Math.max(0, Math.min(sortedValues.length - 1, idx));
  return sortedValues[safeIdx];
}

function summarizeDurations(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
    };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, n) => sum + n, 0);
  return {
    count: values.length,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    avgMs: total / values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function normalizeProjectRootForCompare(projectRoot) {
  const raw = String(projectRoot || "").trim();
  if (!raw) return "";
  try {
    return fs.realpathSync.native(raw);
  } catch {
    return path.resolve(raw);
  }
}

async function waitForDaemonReady(projectRoot, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (isRunning(projectRoot)) {
      const client = await connectWithRetry(socketPath(projectRoot), 1, 0);
      if (client) {
        try {
          client.end();
          client.destroy();
        } catch {
          // ignore
        }
        return true;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);
  }
  return false;
}

async function waitForDaemonStopped(projectRoot, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isRunning(projectRoot)) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(120);
  }
  return !isRunning(projectRoot);
}

function createStatusWaiter() {
  let latestProjectRoot = "";
  const waiting = new Set();
  const seen = [];

  function settle(targetRoot, ok, error) {
    for (const waiter of Array.from(waiting)) {
      if (waiter.targetRoot !== targetRoot) continue;
      waiting.delete(waiter);
      if (ok) waiter.resolve(targetRoot);
      else waiter.reject(error || new Error(`status wait failed: ${targetRoot}`));
    }
  }

  function handleMessage(msg) {
    const type = msg && msg.type ? String(msg.type) : "";
    seen.push({
      ts: Date.now(),
      type: type || "unknown",
      projectRoot: msg && msg.data && msg.data.projectRoot ? String(msg.data.projectRoot) : "",
    });
    if (seen.length > 50) {
      seen.shift();
    }
    if (!msg || msg.type !== "status") return false;
    const rootRaw = msg.data && msg.data.projectRoot ? String(msg.data.projectRoot) : "";
    const root = normalizeProjectRootForCompare(rootRaw);
    if (!root) return false;
    latestProjectRoot = root;
    settle(root, true);
    return false;
  }

  function waitForProject(targetRoot, timeoutMs = 5000) {
    const normalizedTarget = normalizeProjectRootForCompare(targetRoot);
    if (!normalizedTarget) {
      return Promise.reject(new Error("invalid target root for status wait"));
    }
    if (latestProjectRoot === normalizedTarget) return Promise.resolve(normalizedTarget);
    return new Promise((resolve, reject) => {
      const waiter = { targetRoot: normalizedTarget, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        waiting.delete(waiter);
        const seenTail = seen.slice(-5)
          .map((entry) => `${entry.type}:${entry.projectRoot || "-"}`)
          .join(", ");
        reject(new Error(`timeout waiting status for ${normalizedTarget}; seen=[${seenTail}]`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(waiter.timer);
        resolve(value);
      };
      const wrappedReject = (err) => {
        clearTimeout(waiter.timer);
        reject(err);
      };
      waiting.add({
        targetRoot: normalizedTarget,
        resolve: wrappedResolve,
        reject: wrappedReject,
      });
    });
  }

  function clearAll(err) {
    for (const waiter of Array.from(waiting)) {
      waiting.delete(waiter);
      waiter.reject(err || new Error("status waiter cleared"));
    }
  }

  return {
    handleMessage,
    waitForProject,
    clearAll,
    getSeen: () => seen.slice(),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const switches = parseIntArg(argv, "--switches", 50);
  const keepTmp = hasFlag(argv, "--keep-tmp");
  const jsonOnly = hasFlag(argv, "--json");
  const tempParent = parseStringArg(argv, "--tmp-root", "/tmp");

  const tempRoot = fs.mkdtempSync(path.join(tempParent, "ufoo-global-switch-bench-"));
  const projectA = path.join(tempRoot, "project-a");
  const projectB = path.join(tempRoot, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  let coordinator = null;
  const statusWaiter = createStatusWaiter();
  const daemonProcesses = new Map();
  let exitCode = 0;
  const errors = [];
  const daemonBin = path.resolve(__dirname, "..", "bin", "ufoo.js");

  function startManagedDaemon(projectRoot) {
    const existing = daemonProcesses.get(projectRoot);
    if (existing && !existing.child.killed && existing.child.exitCode === null) {
      return existing.child;
    }
    const child = spawn(process.execPath, [daemonBin, "daemon", "start"], {
      cwd: projectRoot,
      env: { ...process.env, UFOO_DAEMON_CHILD: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const logs = { stdout: "", stderr: "" };
    child.stdout.on("data", (chunk) => {
      logs.stdout += String(chunk || "");
      if (logs.stdout.length > 8000) logs.stdout = logs.stdout.slice(-8000);
    });
    child.stderr.on("data", (chunk) => {
      logs.stderr += String(chunk || "");
      if (logs.stderr.length > 8000) logs.stderr = logs.stderr.slice(-8000);
    });
    daemonProcesses.set(projectRoot, { child, logs });
    return child;
  }

  function stopManagedDaemon(projectRoot) {
    try {
      spawnSync(process.execPath, [daemonBin, "daemon", "stop"], {
        cwd: projectRoot,
        stdio: "ignore",
      });
    } catch {
      // ignore
    }
  }

  try {
    const init = new UfooInit(path.resolve(__dirname, ".."));
    await init.init({ modules: "context,bus", project: projectA });
    await init.init({ modules: "context,bus", project: projectB });

    startManagedDaemon(projectA);
    startManagedDaemon(projectB);
    const readyA = await waitForDaemonReady(projectA);
    const readyB = await waitForDaemonReady(projectB);
    if (!readyA || !readyB) {
      const aMeta = daemonProcesses.get(projectA);
      const bMeta = daemonProcesses.get(projectB);
      const aErr = aMeta ? aMeta.logs.stderr || aMeta.logs.stdout : "";
      const bErr = bMeta ? bMeta.logs.stderr || bMeta.logs.stdout : "";
      if (aErr) errors.push(`daemon A log: ${aErr.trim().slice(-400)}`);
      if (bErr) errors.push(`daemon B log: ${bErr.trim().slice(-400)}`);
      throw new Error(`daemon readiness failed: A=${readyA} B=${readyB}`);
    }

    const transport = createDaemonTransport({
      projectRoot: projectA,
      sockPath: socketPath(projectA),
      isRunning,
      startDaemon: startManagedDaemon,
      connectWithRetry,
      primaryRetries: 12,
      secondaryRetries: 20,
      retryDelayMs: 80,
      restartDelayMs: 600,
    });

    coordinator = createDaemonCoordinator({
      projectRoot: projectA,
      daemonTransport: transport,
      handleMessage: statusWaiter.handleMessage,
      queueStatusLine: () => {},
      resolveStatusLine: () => {},
      logMessage: () => {},
      stopDaemon: stopManagedDaemon,
      startDaemon: startManagedDaemon,
    });

    const connected = await coordinator.connect();
    if (!connected) {
      throw new Error("initial coordinator.connect() failed");
    }
    coordinator.requestStatus();
    await statusWaiter.waitForProject(projectA, 5000);

    const durations = [];
    let routingChecksPassed = 0;

    for (let i = 0; i < switches; i += 1) {
      const targetRoot = i % 2 === 0 ? projectB : projectA;
      const startedNs = process.hrtime.bigint();
      // eslint-disable-next-line no-await-in-loop
      const result = await coordinator.switchProject({
        projectRoot: targetRoot,
        sockPath: socketPath(targetRoot),
      });
      const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
      durations.push(durationMs);
      if (!result || result.ok !== true) {
        errors.push(`switch ${i + 1} failed: ${(result && result.error) || "unknown"}`);
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await statusWaiter.waitForProject(targetRoot, 5000);
        routingChecksPassed += 1;
      } catch (err) {
        errors.push(`switch ${i + 1} status mismatch: ${err.message || err}`);
      }
    }

    const summary = summarizeDurations(durations);
    const thresholds = {
      p50MsLt500: summary.p50Ms < 500,
      p95MsLt1200: summary.p95Ms < 1200,
    };
    const routeOk = routingChecksPassed === switches;
    const pass = routeOk && thresholds.p50MsLt500 && thresholds.p95MsLt1200 && errors.length === 0;
    exitCode = pass ? 0 : 2;

    const report = {
      switches,
      routingChecksPassed,
      routeOk,
      summary,
      thresholds,
      pass,
      tempRoot,
      errors,
    };

    if (jsonOnly) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write("=== Global Chat Switch Benchmark ===\n");
      process.stdout.write(`tempRoot: ${tempRoot}\n`);
      process.stdout.write(`switches: ${switches}\n`);
      process.stdout.write(`routing checks: ${routingChecksPassed}/${switches} (${routeOk ? "PASS" : "FAIL"})\n`);
      process.stdout.write(
        `latency ms: min=${summary.minMs.toFixed(2)} avg=${summary.avgMs.toFixed(2)} ` +
        `p50=${summary.p50Ms.toFixed(2)} p95=${summary.p95Ms.toFixed(2)} max=${summary.maxMs.toFixed(2)}\n`
      );
      process.stdout.write(
        `thresholds: p50<500=${thresholds.p50MsLt500 ? "PASS" : "FAIL"} ` +
        `p95<1200=${thresholds.p95MsLt1200 ? "PASS" : "FAIL"}\n`
      );
      if (errors.length > 0) {
        process.stdout.write("errors:\n");
        errors.forEach((line) => process.stdout.write(`- ${line}\n`));
      }
      process.stdout.write(`overall: ${pass ? "PASS" : "FAIL"}\n`);
    }
  } finally {
    statusWaiter.clearAll(new Error("benchmark teardown"));
    if (coordinator) {
      try {
        coordinator.close();
      } catch {
        // ignore
      }
    }
    try {
      stopManagedDaemon(projectA);
    } catch {
      // ignore
    }
    try {
      stopManagedDaemon(projectB);
    } catch {
      // ignore
    }
    for (const [projectRoot, meta] of daemonProcesses.entries()) {
      const child = meta && meta.child;
      if (!child || child.exitCode !== null) continue;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // Ensure child cannot leak if SIGTERM is ignored.
      await sleep(80);
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
      daemonProcesses.delete(projectRoot);
    }
    await waitForDaemonStopped(projectA, 8000);
    await waitForDaemonStopped(projectB, 8000);
    if (!keepTmp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

const net = require("net");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const { resolveNodeExecutable } = require("../../runtime/process/nodeExecutable");
const { resolveDaemonEndpoint } = require("../../runtime/daemon/endpoint");
const { routeDaemonRequest } = require("../../runtime/daemon/endpoint");

function connectSocket(sockPath, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : 0;
  return new Promise((resolve, reject) => {
    let timeoutHandle = null;
    const client = net.createConnection(sockPath, () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(client);
    });

    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    };

    client.on("error", (err) => {
      cleanup();
      reject(err);
    });

    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        const err = new Error(`connect timeout after ${timeoutMs}ms`);
        err.code = "ETIMEDOUT";
        try {
          client.destroy(err);
        } catch {
          // ignore
        }
        reject(err);
      }, timeoutMs);
      if (typeof timeoutHandle.unref === "function") {
        timeoutHandle.unref();
      }
    }
  });
}

function resolveProjectFile(projectRoot, relativePath, fallbackRelativePath) {
  const local = path.join(projectRoot, relativePath);
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, "..", "..", fallbackRelativePath);
}

function startDaemon(projectRoot, options = {}) {
  const endpoint = resolveDaemonEndpoint(projectRoot, options);
  const daemonRoot = endpoint.scope === "global"
    ? endpoint.controllerRoot
    : endpoint.projectRoot;
  const daemonBin = resolveProjectFile(daemonRoot, path.join("bin", "ufoo.js"), path.join("bin", "ufoo.js"));
  const env = {
    ...process.env,
    UFOO_DAEMON_TOPOLOGY: endpoint.topology,
    ...(options.forceResume ? { UFOO_FORCE_RESUME: "1" } : {}),
  };
  const child = spawn(resolveNodeExecutable(), [daemonBin, "daemon", "--start"], {
    detached: true,
    stdio: "ignore",
    cwd: daemonRoot,
    env,
  });
  child.on("error", (err) => {
    if (typeof options.onError === "function") {
      options.onError(err);
    }
  });
  child.unref();
  return child;
}

function stopDaemon(projectRoot, options = {}) {
  const endpoint = resolveDaemonEndpoint(projectRoot, options);
  const daemonRoot = endpoint.scope === "global"
    ? endpoint.controllerRoot
    : endpoint.projectRoot;
  const daemonBin = resolveProjectFile(daemonRoot, path.join("bin", "ufoo.js"), path.join("bin", "ufoo.js"));
  const source = String(
    options.source
      || `chat-transport pid=${process.pid} cwd=${process.cwd()} argv=${process.argv.join(" ")}`
  );
  const result = spawnSync(resolveNodeExecutable(), [daemonBin, "daemon", "--stop"], {
    stdio: "ignore",
    cwd: daemonRoot,
    env: {
      ...process.env,
      UFOO_DAEMON_STOP_SOURCE: source,
      UFOO_DAEMON_TOPOLOGY: endpoint.topology,
    },
  });
  return Boolean(result && !result.error && result.status === 0);
}

async function connectWithRetry(sockPath, retries, delayMs, options = {}) {
  for (let i = 0; i < retries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const client = await connectSocket(sockPath, options);
      return client;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

async function requestDaemon(projectRoot, payload, options = {}) {
  const endpoint = resolveDaemonEndpoint(projectRoot, options);
  const client = await connectWithRetry(
    endpoint.socketPath,
    Number(options.retries) || 25,
    Number(options.retryDelayMs) || 200,
    { timeoutMs: Number(options.connectTimeoutMs) || 2000 }
  );
  if (!client) throw new Error("Failed to connect to ufoo daemon");
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeAllListeners();
      try {
        client.end();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error("Daemon request timeout"));
    }, Number(options.timeoutMs) || 10000);
    if (typeof timer.unref === "function") timer.unref();
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          continue;
        }
        if (response.type === "error") {
          const err = new Error(response.error || "Daemon request failed");
          err.code = response.code || "daemon_request_failed";
          finish(err);
          return;
        }
        if (response.type === "response") {
          finish(null, response.data || {});
          return;
        }
      }
    });
    client.once("error", (err) => finish(err));
    client.once("close", () => finish(new Error("Daemon request connection closed")));
    client.write(`${JSON.stringify(routeDaemonRequest(endpoint, payload))}\n`);
  });
}

module.exports = {
  connectSocket,
  connectWithRetry,
  resolveProjectFile,
  startDaemon,
  stopDaemon,
  requestDaemon,
};

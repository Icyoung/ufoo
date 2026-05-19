const net = require("net");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const { resolveNodeExecutable } = require("../utils/nodeExecutable");

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
  const daemonBin = resolveProjectFile(projectRoot, path.join("bin", "ufoo.js"), path.join("bin", "ufoo.js"));
  const env = options.forceResume
    ? { ...process.env, UFOO_FORCE_RESUME: "1" }
    : process.env;
  const child = spawn(resolveNodeExecutable(), [daemonBin, "daemon", "--start"], {
    detached: true,
    stdio: "ignore",
    cwd: projectRoot,
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
  const daemonBin = resolveProjectFile(projectRoot, path.join("bin", "ufoo.js"), path.join("bin", "ufoo.js"));
  const source = String(
    options.source
      || `chat-transport pid=${process.pid} cwd=${process.cwd()} argv=${process.argv.join(" ")}`
  );
  const result = spawnSync(resolveNodeExecutable(), [daemonBin, "daemon", "--stop"], {
    stdio: "ignore",
    cwd: projectRoot,
    env: { ...process.env, UFOO_DAEMON_STOP_SOURCE: source },
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

module.exports = {
  connectSocket,
  connectWithRetry,
  resolveProjectFile,
  startDaemon,
  stopDaemon,
};

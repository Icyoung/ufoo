const net = require("net");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");

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
  const child = spawn(process.execPath, [daemonBin, "daemon", "--start"], {
    detached: true,
    stdio: "ignore",
    cwd: projectRoot,
    env,
  });
  child.unref();
}

function stopDaemon(projectRoot) {
  const daemonBin = resolveProjectFile(projectRoot, path.join("bin", "ufoo.js"), path.join("bin", "ufoo.js"));
  spawnSync(process.execPath, [daemonBin, "daemon", "--stop"], {
    stdio: "ignore",
    cwd: projectRoot,
  });
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

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveNodeExecutable } = require("../process/nodeExecutable");
const { resolveGlobalControllerProjectRoot } = require("../projects");
const { getUfooPaths } = require("../../coordination/state/paths");

const LAUNCHD_LABEL = "dev.ufoo.daemon";
const DEFAULT_THROTTLE_INTERVAL_SEC = 3;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function resolveLaunchdDomain(options = {}) {
  const uid = Number.isInteger(options.uid)
    ? options.uid
    : (typeof process.getuid === "function" ? process.getuid() : 501);
  return `gui/${uid}`;
}

function resolveLaunchdPlistPath(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const label = String(options.label || LAUNCHD_LABEL).trim() || LAUNCHD_LABEL;
  return path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

function buildServicePathEnv(nodeExecutable, envPath = process.env.PATH || "") {
  const parts = [];
  const add = (dir) => {
    const clean = String(dir || "").trim();
    if (!clean) return;
    if (!parts.includes(clean)) parts.push(clean);
  };
  if (nodeExecutable && path.isAbsolute(nodeExecutable)) {
    add(path.dirname(nodeExecutable));
  }
  for (const entry of String(envPath || "").split(":")) {
    add(entry);
  }
  for (const fallback of [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]) {
    add(fallback);
  }
  return parts.join(":");
}

function resolveDefaultCliEntrypoint() {
  return path.resolve(__dirname, "..", "..", "..", "bin", "ufoo.js");
}

function resolveServiceLogPath(controllerRoot) {
  const paths = getUfooPaths(controllerRoot);
  return path.join(paths.runDir, "ufoo-daemon-launchd.log");
}

function readDaemonPid(daemonRoot, fsModule = fs) {
  try {
    const pidFile = getUfooPaths(daemonRoot).ufooDaemonPid;
    if (!fsModule.existsSync(pidFile)) return null;
    const raw = String(fsModule.readFileSync(pidFile, "utf8") || "").trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

function buildLaunchdPlistXml(options = {}) {
  const label = String(options.label || LAUNCHD_LABEL).trim() || LAUNCHD_LABEL;
  const homeDir = options.homeDir || os.homedir();
  const controllerRoot = options.controllerRoot || resolveGlobalControllerProjectRoot();
  const nodeExecutable = options.nodeExecutable || resolveNodeExecutable();
  const cliEntrypoint = options.cliEntrypoint || resolveDefaultCliEntrypoint();
  const logPath = options.logPath || resolveServiceLogPath(controllerRoot);
  const throttleInterval = Number.isInteger(options.throttleInterval) && options.throttleInterval > 0
    ? options.throttleInterval
    : DEFAULT_THROTTLE_INTERVAL_SEC;
  const servicePath = buildServicePathEnv(nodeExecutable, options.envPath);

  const envEntries = {
    HOME: homeDir,
    PATH: servicePath,
    UFOO_DAEMON_CHILD: "1",
    UFOO_DAEMON_TOPOLOGY: "global",
    UFOO_NODE_EXECUTABLE: nodeExecutable,
    ...(options.extraEnv && typeof options.extraEnv === "object" ? options.extraEnv : {}),
  };

  const envXml = Object.entries(envEntries)
    .filter(([, val]) => val !== undefined && val !== null && String(val) !== "")
    .map(([key, val]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(val)}</string>`)
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(label)}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${escapeXml(nodeExecutable)}</string>`,
    `    <string>${escapeXml(cliEntrypoint)}</string>`,
    `    <string>daemon</string>`,
    `    <string>start</string>`,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(controllerRoot)}</string>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    envXml,
    `  </dict>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>ThrottleInterval</key>`,
    `  <integer>${throttleInterval}</integer>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${escapeXml(logPath)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${escapeXml(logPath)}</string>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}

function parseLaunchctlPrintOutput(stdout = "") {
  const text = String(stdout || "");
  const stateMatch = text.match(/^\s*state\s*=\s*([^\n\r]+)/m);
  const pidMatch = text.match(/^\s*pid\s*=\s*(\d+)/m);
  const exitMatch = text.match(/^\s*last exit code\s*=\s*([^\n\r]+)/m);
  const state = stateMatch ? stateMatch[1].trim() : "";
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
  const lastExitCode = exitMatch ? exitMatch[1].trim() : null;
  return {
    state: state || (pid ? "running" : "loaded"),
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    running: state === "running" || (Number.isInteger(pid) && pid > 0),
    lastExitCode,
  };
}

function runLaunchctl(args, spawnSyncImpl = spawnSync) {
  const res = spawnSyncImpl("launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: typeof res?.status === "number" ? res.status : 1,
    stdout: String(res?.stdout || ""),
    stderr: String(res?.stderr || ""),
    error: res?.error || null,
  };
}

function getLaunchdServiceStatus(options = {}) {
  const platform = options.platform || process.platform;
  const label = String(options.label || LAUNCHD_LABEL).trim() || LAUNCHD_LABEL;
  const domain = resolveLaunchdDomain(options);
  const plistPath = options.plistPath || resolveLaunchdPlistPath(options);
  const controllerRoot = options.controllerRoot || resolveGlobalControllerProjectRoot();
  const logPath = options.logPath || resolveServiceLogPath(controllerRoot);
  const fsModule = options.fsModule || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;

  if (platform !== "darwin") {
    return {
      supported: false,
      platform,
      label,
      domain,
      plistPath,
      logPath,
      installed: false,
      loaded: false,
      running: false,
      pid: null,
      state: "unsupported",
    };
  }

  const installed = Boolean(fsModule.existsSync(plistPath));
  const target = `${domain}/${label}`;
  const query = runLaunchctl(["print", target], spawnSyncImpl);
  if (query.error || query.status !== 0) {
    return {
      supported: true,
      platform,
      label,
      domain,
      plistPath,
      logPath,
      installed,
      loaded: false,
      running: false,
      pid: null,
      state: installed ? "unloaded" : "not_installed",
    };
  }

  const parsed = parseLaunchctlPrintOutput(query.stdout);
  return {
    supported: true,
    platform,
    label,
    domain,
    plistPath,
    logPath,
    installed,
    loaded: true,
    running: parsed.running,
    pid: parsed.pid,
    state: parsed.state,
    lastExitCode: parsed.lastExitCode,
  };
}

function installLaunchdService(options = {}) {
  const platform = options.platform || process.platform;
  const label = String(options.label || LAUNCHD_LABEL).trim() || LAUNCHD_LABEL;
  const domain = resolveLaunchdDomain(options);
  const plistPath = options.plistPath || resolveLaunchdPlistPath(options);
  const controllerRoot = options.controllerRoot || resolveGlobalControllerProjectRoot();
  const logPath = options.logPath || resolveServiceLogPath(controllerRoot);
  const fsModule = options.fsModule || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const dryRun = Boolean(options.dryRun);

  if (platform !== "darwin") {
    return {
      ok: false,
      error: "launchd supervisor is only supported on macOS",
      ...getLaunchdServiceStatus(options),
    };
  }

  const plistXml = buildLaunchdPlistXml({
    ...options,
    label,
    controllerRoot,
    logPath,
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      label,
      domain,
      plistPath,
      logPath,
      plistXml,
    };
  }

  const target = `${domain}/${label}`;
  fsModule.mkdirSync(path.dirname(plistPath), { recursive: true });
  fsModule.mkdirSync(path.dirname(logPath), { recursive: true });

  // Unload any prior registration cleanly before rewriting the plist.
  runLaunchctl(["bootout", target], spawnSyncImpl);

  // Stop an unmanaged daemon so launchd becomes the single process supervisor.
  if (options.stopExistingDaemon !== false) {
    const isRunningFn = typeof options.isRunning === "function"
      ? options.isRunning
      : require("./index").isRunning;
    const stopDaemonFn = typeof options.stopDaemon === "function"
      ? options.stopDaemon
      : require("./index").stopDaemon;
    try {
      if (isRunningFn(controllerRoot)) {
        stopDaemonFn(controllerRoot, { source: "launchd-service:install" });
      }
    } catch {
      // ignore stop errors; bootstrap will proceed cleanly
    }
  }

  fsModule.writeFileSync(plistPath, plistXml, { encoding: "utf8", mode: 0o644 });

  let bootstrap = runLaunchctl(["bootstrap", domain, plistPath], spawnSyncImpl);
  if (bootstrap.status !== 0) {
    // Retry once after explicit bootout of plist path (handles stale launchd cache).
    runLaunchctl(["bootout", domain, plistPath], spawnSyncImpl);
    bootstrap = runLaunchctl(["bootstrap", domain, plistPath], spawnSyncImpl);
  }
  if (bootstrap.error || bootstrap.status !== 0) {
    const detail = (bootstrap.stderr || bootstrap.stdout || bootstrap.error?.message || "launchctl bootstrap failed").trim();
    return {
      ok: false,
      error: detail,
      ...getLaunchdServiceStatus(options),
    };
  }

  runLaunchctl(["enable", target], spawnSyncImpl);
  runLaunchctl(["kickstart", "-k", target], spawnSyncImpl);

  return {
    ok: true,
    ...getLaunchdServiceStatus(options),
  };
}

function uninstallLaunchdService(options = {}) {
  const platform = options.platform || process.platform;
  const label = String(options.label || LAUNCHD_LABEL).trim() || LAUNCHD_LABEL;
  const domain = resolveLaunchdDomain(options);
  const plistPath = options.plistPath || resolveLaunchdPlistPath(options);
  const fsModule = options.fsModule || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const dryRun = Boolean(options.dryRun);

  if (platform !== "darwin") {
    return {
      ok: false,
      error: "launchd supervisor is only supported on macOS",
      ...getLaunchdServiceStatus(options),
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      label,
      domain,
      plistPath,
    };
  }

  const target = `${domain}/${label}`;
  runLaunchctl(["bootout", target], spawnSyncImpl);
  if (fsModule.existsSync(plistPath)) {
    runLaunchctl(["bootout", domain, plistPath], spawnSyncImpl);
    try {
      fsModule.unlinkSync(plistPath);
    } catch (err) {
      return {
        ok: false,
        error: err && err.message ? err.message : "Failed to remove launchd plist",
        ...getLaunchdServiceStatus(options),
      };
    }
  }

  return {
    ok: true,
    ...getLaunchdServiceStatus(options),
  };
}

function restartLaunchdService(options = {}) {
  const platform = options.platform || process.platform;
  const label = String(options.label || LAUNCHD_LABEL).trim() || LAUNCHD_LABEL;
  const domain = resolveLaunchdDomain(options);
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;

  if (platform !== "darwin") {
    return {
      ok: false,
      error: "launchd supervisor is only supported on macOS",
      ...getLaunchdServiceStatus(options),
    };
  }

  const status = getLaunchdServiceStatus(options);
  if (!status.loaded) {
    return {
      ok: false,
      error: "launchd service is not loaded",
      ...status,
    };
  }

  const target = `${domain}/${label}`;
  const kick = runLaunchctl(["kickstart", "-k", target], spawnSyncImpl);
  if (kick.error || kick.status !== 0) {
    const detail = (kick.stderr || kick.stdout || kick.error?.message || "launchctl kickstart failed").trim();
    return {
      ok: false,
      error: detail,
      ...getLaunchdServiceStatus(options),
    };
  }

  return {
    ok: true,
    ...getLaunchdServiceStatus(options),
  };
}

module.exports = {
  LAUNCHD_LABEL,
  DEFAULT_THROTTLE_INTERVAL_SEC,
  resolveLaunchdDomain,
  resolveLaunchdPlistPath,
  resolveServiceLogPath,
  readDaemonPid,
  buildServicePathEnv,
  buildLaunchdPlistXml,
  parseLaunchctlPrintOutput,
  getLaunchdServiceStatus,
  installLaunchdService,
  uninstallLaunchdService,
  restartLaunchdService,
};

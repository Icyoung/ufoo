"use strict";

const crypto = require("crypto");
const os = require("os");
const path = require("path");

/**
 * Resolve the user-scoped optional browser home directory (`~/.ufoo/browser/`).
 * Respects `UFOO_BROWSER_HOME` for isolated test environments.
 */
function browserHomeDir(env = process.env) {
  const override = String(env.UFOO_BROWSER_HOME || "").trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".ufoo", "browser");
}

function installStatePath(env = process.env) {
  return path.join(browserHomeDir(env), "install.json");
}

function activeRuntimePath(env = process.env) {
  return path.join(browserHomeDir(env), "active.json");
}

function runtimeVersionsDir(env = process.env) {
  return path.join(browserHomeDir(env), "runtime");
}

function nativeHostDir(env = process.env) {
  return path.join(browserHomeDir(env), "native-host");
}

function nativeHostLauncherPath(env = process.env) {
  return path.join(nativeHostDir(env), "ufoo-browser-host");
}

function nativeHostRunnerPath(env = process.env) {
  return path.join(nativeHostDir(env), "native-host-runner.js");
}

function privateDir(env = process.env) {
  return path.join(browserHomeDir(env), "private");
}

function brokerSocketPath(env = process.env) {
  const candidate = path.join(privateDir(env), "broker.sock");
  if (Buffer.byteLength(candidate) <= 96) return candidate;
  const tag = crypto.createHash("sha256").update(privateDir(env)).digest("hex").slice(0, 16);
  return path.join("/tmp", `ufoo-bb-${tag}.sock`);
}

function brokerLockPath(env = process.env) {
  return path.join(privateDir(env), "broker.lock");
}

function brokerInfoPath(env = process.env) {
  return path.join(privateDir(env), "broker.json");
}

function runtimeLeasesDir(env = process.env) {
  return path.join(privateDir(env), "leases");
}

function setupLockPath(env = process.env) {
  return path.join(browserHomeDir(env), "setup.lock");
}

/**
 * Return Chrome NativeMessagingHosts directories for the current platform.
 * Override with `UFOO_BROWSER_NATIVE_HOST_DIRS` (path.delimiter separated) in tests.
 */
function chromeNativeMessagingHostsDirs(env = process.env, platform = process.platform) {
  const override = String(env.UFOO_BROWSER_NATIVE_HOST_DIRS || "").trim();
  if (override) {
    return override.split(path.delimiter).map((item) => item.trim()).filter(Boolean);
  }
  const home = os.homedir();
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
      path.join(home, "Library", "Application Support", "Google", "Chrome Beta", "NativeMessagingHosts"),
      path.join(home, "Library", "Application Support", "Google", "Chrome Canary", "NativeMessagingHosts"),
      path.join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
    ];
  }
  if (platform === "linux") {
    return [
      path.join(home, ".config", "google-chrome", "NativeMessagingHosts"),
      path.join(home, ".config", "chromium", "NativeMessagingHosts"),
    ];
  }
  return [];
}

/**
 * Return candidate Chrome User Data directories for read-only profile/extension checks.
 */
function chromeUserDataDirs(env = process.env, platform = process.env) {
  const override = String(env.UFOO_BROWSER_CHROME_USER_DATA_DIR || "").trim();
  if (override) return [path.resolve(override)];
  const home = os.homedir();
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Google", "Chrome"),
      path.join(home, "Library", "Application Support", "Google", "Chrome Beta"),
      path.join(home, "Library", "Application Support", "Google", "Chrome Canary"),
    ];
  }
  if (platform === "linux") {
    return [
      path.join(home, ".config", "google-chrome"),
      path.join(home, ".config", "chromium"),
    ];
  }
  return [];
}

module.exports = {
  browserHomeDir,
  installStatePath,
  activeRuntimePath,
  runtimeVersionsDir,
  nativeHostDir,
  nativeHostLauncherPath,
  nativeHostRunnerPath,
  privateDir,
  brokerSocketPath,
  brokerLockPath,
  brokerInfoPath,
  runtimeLeasesDir,
  setupLockPath,
  chromeNativeMessagingHostsDirs,
  chromeUserDataDirs,
};

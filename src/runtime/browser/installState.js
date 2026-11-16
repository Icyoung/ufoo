"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { loadGlobalBrowserConfig } = require("../../config");
const { writeFileAtomic } = require("../../coordination/bus/utils");
const { withFileLock } = require("../../coordination/state/fileLock");
const {
  browserHomeDir,
  installStatePath,
  activeRuntimePath,
  runtimeLeasesDir,
  chromeNativeMessagingHostsDirs,
  chromeUserDataDirs,
} = require("./paths");
const {
  getReleaseManifest,
  isSupportedPlatform,
  NATIVE_HOST_NAME,
  DEV_NATIVE_HOST_NAME,
} = require("./manifest");

function readJsonSafe(filePath, fallback = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readInstallState(env = process.env) {
  const filePath = installStatePath(env);
  const raw = readJsonSafe(filePath, null);
  return {
    schemaVersion: 1,
    state: "not_installed",
    mode: "release",
    runtimeInstalled: false,
    runtimeVersion: "",
    nativeHostRegistered: false,
    devHostRegistered: false,
    lastError: "",
    updatedAt: "",
    ...(raw || {}),
  };
}

function writeInstallState(patch = {}, env = process.env) {
  const target = installStatePath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  return withFileLock(target, () => {
    const current = readInstallState(env);
    const next = {
      ...current,
      ...(typeof patch === "function" ? patch(current) : patch),
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
    };
    writeFileAtomic(target, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  });
}

function readActiveRuntime(env = process.env) {
  const raw = readJsonSafe(activeRuntimePath(env), null);
  if (!raw || typeof raw.entryPath !== "string" || !raw.entryPath.trim()) return null;
  if (!fs.existsSync(raw.entryPath)) return null;
  return raw;
}

function writeActiveRuntimeAtomic(record, env = process.env) {
  const target = activeRuntimePath(env);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeFileAtomic(target, JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

/**
 * Resolve the @playwright/mcp cli.js entrypoint.
 * Production paths resolve strictly from ~/.ufoo/browser/active.json (or UFOO_BROWSER_MCP_CLI).
 * Repo devDependencies fallback is only allowed when `allowBundledFallback` is true (unit/integration tests).
 */
function resolveMcpCliEntrypoint({ env = process.env, allowBundledFallback = false } = {}) {
  const override = String(env.UFOO_BROWSER_MCP_CLI || "").trim();
  if (override && fs.existsSync(override)) {
    return { entryPath: override, version: "override", source: "env" };
  }
  const active = readActiveRuntime(env);
  if (active) {
    return { entryPath: active.entryPath, version: active.version || "", source: "optional-runtime" };
  }
  if (allowBundledFallback) {
    try {
      const pkgPath = require.resolve("@playwright/mcp/package.json");
      const pkg = readJsonSafe(pkgPath, {});
      const cli = path.join(path.dirname(pkgPath), "cli.js");
      if (fs.existsSync(cli)) {
        return { entryPath: cli, version: pkg.version || "", source: "bundled-fallback" };
      }
    } catch {
      // Not available in node_modules
    }
  }
  return null;
}

/**
 * Acquire a lightweight runtime-version lease so concurrent updates don't delete an in-use runtime.
 */
function acquireRuntimeLease(version = "", env = process.env) {
  if (!version) return () => {};
  const dir = runtimeLeasesDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safeVersion = String(version).replace(/[^a-zA-Z0-9._-]/g, "_");
  const file = path.join(dir, `${safeVersion}.${process.pid}.${randomUUID()}.lease`);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, version, createdAt: new Date().toISOString() }), { mode: 0o600 });
  return () => {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  };
}

function listLeasedRuntimeVersions(env = process.env) {
  const dir = runtimeLeasesDir(env);
  const versions = new Set();
  if (!fs.existsSync(dir)) return versions;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".lease")) continue;
    const file = path.join(dir, name);
    const data = readJsonSafe(file, null);
    const pid = Number(data?.pid);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = err && err.code === "EPERM";
      }
    }
    if (alive && data?.version) {
      versions.add(String(data.version));
    } else {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    }
  }
  return versions;
}

function isExtensionPresentInProfileDir(profileDir, extensionId) {
  if (!extensionId) return false;
  if (fs.existsSync(path.join(profileDir, "Extensions", extensionId))) return true;
  for (const fileName of ["Preferences", "Secure Preferences"]) {
    const prefs = readJsonSafe(path.join(profileDir, fileName), null);
    const record = prefs?.extensions?.settings?.[extensionId];
    if (record && typeof record === "object" && Object.keys(record).length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Read-only detection of Chrome installation and whether ufoo extensions appear in Chrome profiles.
 * Never writes to Chrome profile directories or preferences.
 */
function detectChromeEnvironment({ env = process.env, platform = process.platform } = {}) {
  const effectivePlatform = String(env.UFOO_BROWSER_PLATFORM || platform || "").trim();
  const manifest = getReleaseManifest(env);
  const chromeBinaryOverride = String(env.UFOO_BROWSER_CHROME_BIN || "").trim();
  const candidateBins = chromeBinaryOverride
    ? [chromeBinaryOverride]
    : effectivePlatform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          path.join(require("os").homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
          "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        ]
      : [];
  const chromePath = candidateBins.find((candidate) => fs.existsSync(candidate)) || "";
  const userDataDirs = chromeUserDataDirs(env, effectivePlatform).filter((dir) => fs.existsSync(dir));
  const chromeInstalled = Boolean(chromePath) || userDataDirs.length > 0;

  let releaseExtensionInstalled = false;
  let devExtensionInstalled = false;
  const matchedProfiles = [];

  for (const userDataDir of userDataDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(userDataDir);
    } catch {
      entries = [];
    }
    const profiles = entries.filter((name) => name === "Default" || /^Profile \d+$/.test(name));
    for (const profile of profiles) {
      const profileDir = path.join(userDataDir, profile);
      const hasRelease = manifest.releaseExtensionId
        ? isExtensionPresentInProfileDir(profileDir, manifest.releaseExtensionId)
        : false;
      const hasDev = isExtensionPresentInProfileDir(profileDir, manifest.devExtensionId);
      if (hasRelease) releaseExtensionInstalled = true;
      if (hasDev) devExtensionInstalled = true;
      if (hasRelease || hasDev) matchedProfiles.push({ userDataDir, profile, hasRelease, hasDev });
    }
  }

  return {
    platform: effectivePlatform,
    platformSupported: isSupportedPlatform(effectivePlatform, env),
    chromeInstalled,
    chromePath,
    userDataDirs,
    releaseExtensionInstalled,
    devExtensionInstalled,
    extensionInstalled: releaseExtensionInstalled || devExtensionInstalled,
    matchedProfiles,
  };
}

function readNativeHostRegistrations(env = process.env, platform = process.platform) {
  const dirs = chromeNativeMessagingHostsDirs(env, platform);
  const releaseFiles = [];
  const devFiles = [];
  for (const dir of dirs) {
    const rel = path.join(dir, `${NATIVE_HOST_NAME}.json`);
    const dev = path.join(dir, `${DEV_NATIVE_HOST_NAME}.json`);
    if (fs.existsSync(rel)) releaseFiles.push(rel);
    if (fs.existsSync(dev)) devFiles.push(dev);
  }
  return { releaseFiles, devFiles };
}

/**
 * Compute unified browser installation/connection status from disk config, install state, and optional live broker state.
 */
function computeBrowserSetupStatus({ env = process.env, brokerStatus = null } = {}) {
  const config = loadGlobalBrowserConfig();
  const install = readInstallState(env);
  const active = readActiveRuntime(env);
  const manifest = getReleaseManifest(env);
  const chrome = detectChromeEnvironment({ env });
  const hosts = readNativeHostRegistrations(env, chrome.platform);
  const runtimeInstalled = Boolean(active && active.entryPath);
  const nativeHostRegistered = hosts.releaseFiles.length > 0 || hosts.devFiles.length > 0;
  const extensionConnected = Boolean(brokerStatus && brokerStatus.extensionConnected);
  const protocolMismatch = Boolean(brokerStatus && brokerStatus.protocolMismatch);
  const paused = Boolean(brokerStatus && brokerStatus.paused);

  let state = "not_installed";
  if (!chrome.platformSupported && !env.UFOO_BROWSER_CDP_ENDPOINT && config.backend === "ufoo-extension") {
    state = "unsupported_platform";
  } else if (install.state === "installing") {
    state = "installing";
  } else if (protocolMismatch) {
    state = "protocol_mismatch";
  } else if (!runtimeInstalled && config.setupChoice !== "install") {
    state = "not_installed";
  } else if (config.setupChoice === "install" && !runtimeInstalled) {
    state = install.state === "installing" ? "installing" : "not_installed";
  } else if (!config.enabled) {
    state = "disabled";
  } else if (config.backend === "cdp" || env.UFOO_BROWSER_CDP_ENDPOINT) {
    state = "ready";
  } else if (config.backend === "playwright-extension") {
    state = runtimeInstalled ? "waiting_for_browser" : "not_installed";
  } else if (extensionConnected) {
    state = paused ? "waiting_for_browser" : "ready";
  } else if (!nativeHostRegistered) {
    state = "pending_browser_install";
  } else if (install.mode === "dev") {
    state = chrome.devExtensionInstalled ? "waiting_for_browser" : "pending_browser_install";
  } else if (!manifest.storePublished) {
    state = chrome.devExtensionInstalled ? "waiting_for_browser" : "pending_browser_install";
  } else {
    state = chrome.releaseExtensionInstalled ? "waiting_for_browser" : "pending_browser_install";
  }

  return {
    state,
    setupChoice: config.setupChoice,
    enabled: config.enabled,
    backend: config.backend,
    schemaVersion: config.schemaVersion,
    browserHome: browserHomeDir(env),
    runtimeInstalled,
    runtimeVersion: active?.version || install.runtimeVersion || "",
    activeEntryPath: active?.entryPath || "",
    nativeHostRegistered,
    releaseHostRegistered: hosts.releaseFiles.length > 0,
    devHostRegistered: hosts.devFiles.length > 0,
    chromeInstalled: chrome.chromeInstalled,
    platform: chrome.platform,
    platformSupported: chrome.platformSupported,
    extensionInstalled: chrome.extensionInstalled,
    releaseExtensionInstalled: chrome.releaseExtensionInstalled,
    devExtensionInstalled: chrome.devExtensionInstalled,
    storePublished: manifest.storePublished,
    storeUrl: manifest.storeUrl,
    releaseExtensionId: manifest.releaseExtensionId,
    devExtensionId: manifest.devExtensionId,
    devExtensionDir: manifest.devExtensionDir,
    protocolVersion: manifest.protocolVersion,
    protocolCompatible: !protocolMismatch,
    extensionConnected,
    paused,
    brokerRunning: Boolean(brokerStatus && brokerStatus.ok),
    connectedExtension: brokerStatus?.connectedExtension || null,
    activeTabs: brokerStatus?.tabOwners || [],
    installMode: install.mode || "release",
    lastError: install.lastError || brokerStatus?.protocolError || "",
  };
}

module.exports = {
  readJsonSafe,
  readInstallState,
  writeInstallState,
  readActiveRuntime,
  writeActiveRuntimeAtomic,
  resolveMcpCliEntrypoint,
  acquireRuntimeLease,
  listLeasedRuntimeVersions,
  detectChromeEnvironment,
  readNativeHostRegistrations,
  computeBrowserSetupStatus,
};

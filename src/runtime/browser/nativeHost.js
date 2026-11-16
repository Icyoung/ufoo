"use strict";

const fs = require("fs");
const path = require("path");
const { resolveNodeExecutable } = require("../process/nodeExecutable");
const { writeFileAtomic } = require("../../coordination/bus/utils");
const {
  nativeHostDir,
  nativeHostLauncherPath,
  nativeHostRunnerPath,
  chromeNativeMessagingHostsDirs,
} = require("./paths");
const {
  NATIVE_HOST_NAME,
  DEV_NATIVE_HOST_NAME,
  getReleaseManifest,
} = require("./manifest");
const { writeInstallState } = require("./installState");

const RUNNER_SOURCE_PATH = path.join(__dirname, "native-host-runner.js");

function shellEscapeSingle(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

function buildLauncherScript(nodeExecutable, runnerPath) {
  return [
    "#!/bin/sh",
    `exec ${shellEscapeSingle(nodeExecutable)} ${shellEscapeSingle(runnerPath)} "$@"`,
    "",
  ].join("\n");
}

function buildNativeHostManifest({ name, description, launcherPath, allowedOrigins }) {
  return {
    name,
    description,
    path: launcherPath,
    type: "stdio",
    allowed_origins: allowedOrigins,
  };
}

/**
 * Install the stable native-host launcher script and register Chrome NativeMessagingHosts manifests.
 */
function registerNativeHost({
  env = process.env,
  platform = process.platform,
  mode = "release",
  nodeExecutable = resolveNodeExecutable(),
} = {}) {
  const manifest = getReleaseManifest(env);
  const hostDir = nativeHostDir(env);
  const launcherPath = nativeHostLauncherPath(env);
  const runnerPath = nativeHostRunnerPath(env);

  fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(RUNNER_SOURCE_PATH, runnerPath);
  fs.chmodSync(runnerPath, 0o755);
  writeFileAtomic(launcherPath, buildLauncherScript(nodeExecutable, runnerPath), { mode: 0o755 });
  fs.chmodSync(launcherPath, 0o755);

  const dirs = chromeNativeMessagingHostsDirs(env, platform);
  const written = [];
  let releaseRegistered = false;
  let devRegistered = false;

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    if (manifest.releaseExtensionId) {
      const releaseManifestPath = path.join(dir, `${NATIVE_HOST_NAME}.json`);
      const releasePayload = buildNativeHostManifest({
        name: NATIVE_HOST_NAME,
        description: "ufoo Browser Native Messaging Host",
        launcherPath,
        allowedOrigins: [`chrome-extension://${manifest.releaseExtensionId}/`],
      });
      writeFileAtomic(releaseManifestPath, JSON.stringify(releasePayload, null, 2), { mode: 0o644 });
      written.push(releaseManifestPath);
      releaseRegistered = true;
    }
    if (mode === "dev" || !manifest.releaseExtensionId) {
      const devManifestPath = path.join(dir, `${DEV_NATIVE_HOST_NAME}.json`);
      const devPayload = buildNativeHostManifest({
        name: DEV_NATIVE_HOST_NAME,
        description: "ufoo Browser Native Messaging Host (Developer Mode)",
        launcherPath,
        allowedOrigins: [`chrome-extension://${manifest.devExtensionId}/`],
      });
      writeFileAtomic(devManifestPath, JSON.stringify(devPayload, null, 2), { mode: 0o644 });
      written.push(devManifestPath);
      devRegistered = true;
    }
  }

  writeInstallState({
    nativeHostRegistered: releaseRegistered || devRegistered,
    devHostRegistered: devRegistered,
  }, env);

  return {
    ok: written.length > 0,
    launcherPath,
    runnerPath,
    nodeExecutable,
    written,
    releaseRegistered,
    devRegistered,
  };
}

function parseLauncherNodePath(launcherPath) {
  try {
    const content = fs.readFileSync(launcherPath, "utf8");
    const match = content.match(/^exec\s+'([^']+)'/m) || content.match(/^exec\s+"([^"]+)"/m);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function checkNativeHostHealth({ env = process.env, platform = process.platform } = {}) {
  const launcherPath = nativeHostLauncherPath(env);
  const runnerPath = nativeHostRunnerPath(env);
  const issues = [];
  const launcherExists = fs.existsSync(launcherPath);
  const runnerExists = fs.existsSync(runnerPath);
  if (!launcherExists) issues.push("launcher_missing");
  if (!runnerExists) issues.push("runner_missing");

  const configuredNode = launcherExists ? parseLauncherNodePath(launcherPath) : "";
  const nodeExists = Boolean(configuredNode && fs.existsSync(configuredNode));
  if (launcherExists && !nodeExists) issues.push("node_executable_missing");

  let launcherExecutable = false;
  if (launcherExists) {
    try {
      const mode = fs.statSync(launcherPath).mode;
      launcherExecutable = (mode & 0o111) !== 0;
      if (!launcherExecutable) issues.push("launcher_not_executable");
    } catch {
      issues.push("launcher_unreadable");
    }
  }

  const dirs = chromeNativeMessagingHostsDirs(env, platform);
  const manifests = [];
  for (const dir of dirs) {
    for (const hostName of [NATIVE_HOST_NAME, DEV_NATIVE_HOST_NAME]) {
      const file = path.join(dir, `${hostName}.json`);
      if (!fs.existsSync(file)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        const valid = parsed.path === launcherPath && Array.isArray(parsed.allowed_origins) && parsed.allowed_origins.length > 0;
        manifests.push({ file, hostName, valid, allowedOrigins: parsed.allowed_origins || [] });
        if (!valid) issues.push(`manifest_stale:${file}`);
      } catch {
        manifests.push({ file, hostName, valid: false });
        issues.push(`manifest_corrupt:${file}`);
      }
    }
  }
  if (manifests.length === 0) issues.push("no_native_host_manifest");

  return {
    ok: issues.length === 0,
    issues,
    launcherPath,
    runnerPath,
    configuredNode,
    nodeExists,
    launcherExecutable,
    manifests,
  };
}

function repairNativeHost({ env = process.env, platform = process.platform, mode = "release" } = {}) {
  return registerNativeHost({
    env,
    platform,
    mode,
    nodeExecutable: resolveNodeExecutable(),
  });
}

function unregisterNativeHost({ env = process.env, platform = process.platform } = {}) {
  const dirs = chromeNativeMessagingHostsDirs(env, platform);
  const removed = [];
  for (const dir of dirs) {
    for (const hostName of [NATIVE_HOST_NAME, DEV_NATIVE_HOST_NAME]) {
      const file = path.join(dir, `${hostName}.json`);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed.push(file);
      }
    }
  }
  const hostDir = nativeHostDir(env);
  if (fs.existsSync(hostDir)) {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
  return { removed };
}

module.exports = {
  buildLauncherScript,
  registerNativeHost,
  checkNativeHostHealth,
  repairNativeHost,
  unregisterNativeHost,
  parseLauncherNodePath,
};

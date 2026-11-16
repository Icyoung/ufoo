"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { randomUUID } = require("crypto");
const { resolveNodeExecutable } = require("../process/nodeExecutable");
const { getReleaseManifest } = require("./manifest");
const {
  browserHomeDir,
  runtimeVersionsDir,
  activeRuntimePath,
  setupLockPath,
} = require("./paths");
const {
  readActiveRuntime,
  writeActiveRuntimeAtomic,
  readInstallState,
  writeInstallState,
  listLeasedRuntimeVersions,
} = require("./installState");
const lockfile = require("proper-lockfile");

function computeFileSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex").toLowerCase();
}

function resolveNpmCommand(nodeExec = resolveNodeExecutable()) {
  const npmBesideNode = path.join(path.dirname(nodeExec), process.platform === "win32" ? "npm.cmd" : "npm");
  if (fs.existsSync(npmBesideNode)) return npmBesideNode;
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function copyDirectorySync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      fs.symlinkSync(target, destPath);
    } else if (entry.isDirectory()) {
      copyDirectorySync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function runStagedSelfCheck(cliPath, nodeExec = resolveNodeExecutable()) {
  if (!cliPath || !fs.existsSync(cliPath)) {
    throw new Error(`Staged Playwright MCP entrypoint missing: ${cliPath}`);
  }
  const res = spawnSync(nodeExec, [cliPath, "--help"], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const detail = String(res.stderr || res.stdout || "").trim().slice(0, 400);
    throw new Error(`Staged Playwright MCP self-check failed (exit ${res.status})${detail ? `: ${detail}` : ""}`);
  }
}

function pruneUnusedRuntimes({ env = process.env } = {}) {
  const dir = runtimeVersionsDir(env);
  if (!fs.existsSync(dir)) return [];
  const active = readActiveRuntime(env);
  const activeDir = active?.runtimeDir ? path.resolve(active.runtimeDir) : "";
  const leased = listLeasedRuntimeVersions(env);
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".staging-")) continue;
    const full = path.resolve(path.join(dir, entry.name));
    if (full === activeDir) continue;
    const versionPrefix = entry.name.split("+")[0];
    if (leased.has(entry.name) || leased.has(versionPrefix)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      // Ignore busy directories; next prune will collect them.
    }
  }
  return removed;
}

async function downloadToFile(url, destFile) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download component (${response.status} ${response.statusText})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destFile, buffer, { mode: 0o600 });
}

/**
 * Install or update the pinned optional Playwright MCP runtime into ~/.ufoo/browser/runtime/<version>/.
 * Never mutates the active ufoo package directory; rolls back cleanly on failure.
 */
async function installBrowserRuntime({
  env = process.env,
  version = "",
  sourceDir = "",
  tarball = "",
  sha256 = "",
  mode = "release",
  runSelfCheck = runStagedSelfCheck,
  installFromNpm = null,
} = {}) {
  const manifest = getReleaseManifest(env);
  const targetVersion = String(version || manifest.runtimeComponentVersion).trim();
  const homeDir = browserHomeDir(env);
  const versionsDir = runtimeVersionsDir(env);
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(versionsDir, { recursive: true, mode: 0o700 });

  const lockTarget = setupLockPath(env);
  const previousActive = readActiveRuntime(env);
  const previousInstall = readInstallState(env);
  writeInstallState({ state: "installing", mode, lastError: "" }, env);

  const stagingDir = path.join(versionsDir, `.staging-${targetVersion}-${randomUUID().slice(0, 8)}`);
  let releaseLock = null;
  try {
    releaseLock = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: 120000,
      update: 10000,
      retries: { retries: 10, minTimeout: 100, maxTimeout: 500 },
    });
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
      const nodeExec = resolveNodeExecutable();
      const effectiveSource = String(sourceDir || env.UFOO_BROWSER_COMPONENT_SOURCE || "").trim();
      const effectiveTarball = String(tarball || manifest.componentTarballUrl || "").trim();
      const expectedSha = String(sha256 || manifest.componentTarballSha256 || "").trim().toLowerCase();
      let computedSha = "";

      if (effectiveSource) {
        if (!fs.existsSync(effectiveSource)) {
          throw new Error(`Browser component source directory not found: ${effectiveSource}`);
        }
        copyDirectorySync(effectiveSource, stagingDir);
      } else {
        let packageSpec = `${manifest.runtimeComponentName}@${targetVersion}`;
        if (effectiveTarball) {
          let localTarball = effectiveTarball;
          if (/^https?:\/\//i.test(effectiveTarball)) {
            localTarball = path.join(stagingDir, "component.tgz");
            await downloadToFile(effectiveTarball, localTarball);
          } else if (!fs.existsSync(localTarball)) {
            throw new Error(`Browser component tarball not found: ${localTarball}`);
          }
          computedSha = computeFileSha256(localTarball);
          if (expectedSha && computedSha !== expectedSha) {
            throw new Error(`Browser component sha256 mismatch (expected ${expectedSha}, got ${computedSha})`);
          }
          packageSpec = localTarball;
        }
        if (typeof installFromNpm === "function") {
          await installFromNpm({ stagingDir, packageSpec, nodeExec });
        } else {
          fs.writeFileSync(path.join(stagingDir, "package.json"), JSON.stringify({ name: "ufoo-browser-runtime", private: true }, null, 2));
          const npmCmd = resolveNpmCommand(nodeExec);
          const res = spawnSync(
            npmCmd,
            ["install", "--prefix", stagingDir, "--no-save", "--no-audit", "--no-fund", "--omit=dev", packageSpec],
            { encoding: "utf8", timeout: 180000, cwd: stagingDir }
          );
          if (res.error) throw res.error;
          if (res.status !== 0) {
            const detail = String(res.stderr || res.stdout || "").trim().slice(0, 600);
            throw new Error(`npm install of browser component failed (exit ${res.status})${detail ? `: ${detail}` : ""}`);
          }
        }
      }

      const cliCandidates = [
        path.join(stagingDir, "node_modules", "@playwright", "mcp", "cli.js"),
        path.join(stagingDir, "cli.js"),
      ];
      const stagedCli = cliCandidates.find((candidate) => fs.existsSync(candidate));
      if (!stagedCli) {
        throw new Error("Playwright MCP cli.js not found in staged component");
      }
      runSelfCheck(stagedCli, nodeExec);

      const pkgJsonPath = path.join(path.dirname(stagedCli), "package.json");
      let resolvedVersion = targetVersion;
      try {
        const parsedPkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        if (parsedPkg && parsedPkg.version) resolvedVersion = String(parsedPkg.version);
      } catch {
        // Keep requested version
      }

      const leased = listLeasedRuntimeVersions(env);
      const baseTarget = path.join(versionsDir, resolvedVersion);
      const finalRuntimeDir = fs.existsSync(baseTarget) && (leased.has(resolvedVersion) || previousActive?.runtimeDir === path.resolve(baseTarget))
        ? path.join(versionsDir, `${resolvedVersion}+${randomUUID().slice(0, 6)}`)
        : baseTarget;
      if (fs.existsSync(finalRuntimeDir)) {
        fs.rmSync(finalRuntimeDir, { recursive: true, force: true });
      }
      fs.renameSync(stagingDir, finalRuntimeDir);
      const finalCli = path.relative(stagingDir, stagedCli);
      const entryPath = path.join(finalRuntimeDir, finalCli);
      const activeRecord = writeActiveRuntimeAtomic({
        schemaVersion: 1,
        component: manifest.runtimeComponentName,
        version: resolvedVersion,
        runtimeDir: finalRuntimeDir,
        entryPath,
        sha256: computedSha || expectedSha || "",
        installedAt: new Date().toISOString(),
      }, env);
      writeInstallState({
        state: "installed",
        mode,
        runtimeInstalled: true,
        runtimeVersion: resolvedVersion,
        lastError: "",
      }, env);
      pruneUnusedRuntimes({ env });
      return { ok: true, active: activeRecord };
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (previousActive && !readActiveRuntime(env)) {
      writeActiveRuntimeAtomic(previousActive, env);
    }
    writeInstallState({
      state: previousActive ? previousInstall.state : "not_installed",
      runtimeInstalled: Boolean(previousActive),
      runtimeVersion: previousActive?.version || previousInstall.runtimeVersion || "",
      lastError: error && error.message ? error.message : String(error),
    }, env);
    throw error;
  } finally {
    if (releaseLock) await releaseLock().catch(() => {});
  }
}

function uninstallBrowserRuntime({ env = process.env } = {}) {
  const homeDir = browserHomeDir(env);
  if (!fs.existsSync(homeDir)) return { removed: false };
  try {
    fs.rmSync(activeRuntimePath(env), { force: true });
  } catch { /* ignore */ }
  try {
    fs.rmSync(runtimeVersionsDir(env), { recursive: true, force: true });
  } catch { /* ignore */ }
  writeInstallState({
    state: "not_installed",
    runtimeInstalled: false,
    runtimeVersion: "",
    nativeHostRegistered: false,
    devHostRegistered: false,
    lastError: "",
  }, env);
  return { removed: true };
}

module.exports = {
  computeFileSha256,
  runStagedSelfCheck,
  pruneUnusedRuntimes,
  installBrowserRuntime,
  uninstallBrowserRuntime,
};

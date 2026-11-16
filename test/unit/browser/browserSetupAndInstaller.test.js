"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadGlobalBrowserConfig, saveGlobalBrowserConfig } = require("../../../src/config");
const {
  installBrowserRuntime,
  uninstallBrowserRuntime,
  computeFileSha256,
} = require("../../../src/runtime/browser/componentInstaller");
const {
  acquireRuntimeLease,
  readActiveRuntime,
  computeBrowserSetupStatus,
} = require("../../../src/runtime/browser/installState");
const {
  registerNativeHost,
  checkNativeHostHealth,
  unregisterNativeHost,
} = require("../../../src/runtime/browser/nativeHost");
const {
  DEV_EXTENSION_ID,
  NATIVE_HOST_NAME,
  DEV_NATIVE_HOST_NAME,
} = require("../../../src/runtime/browser/manifest");
const {
  runBrowserInstall,
  runBrowserDoctor,
  runBrowserEnable,
  runBrowserDisable,
  runBrowserUninstall,
} = require("../../../src/app/cli/browserCommands");
const {
  runSetupCommand,
  shouldOfferFirstRunSetup,
  maybeRunFirstTimeSetup,
} = require("../../../src/app/cli/setupCommands");

function makeFakeComponentSource(dir, version = "0.0.85") {
  const pkgDir = path.join(dir, "node_modules", "@playwright", "mcp");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@playwright/mcp", version }));
  fs.writeFileSync(path.join(pkgDir, "cli.js"), "#!/usr/bin/env node\nif (process.argv.includes('--help')) { console.log('ok'); process.exit(0); }\n");
}

describe("ufoo Browser setup, optional runtime installer, and native host", () => {
  let tmpRoot;
  let browserHome;
  let nativeHostDir;
  let chromeUserData;
  let globalCfgFile;
  let prevEnv;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-browser-setup-"));
    browserHome = path.join(tmpRoot, "browser-home");
    nativeHostDir = path.join(tmpRoot, "native-hosts");
    chromeUserData = path.join(tmpRoot, "chrome-profile-root");
    globalCfgFile = path.join(tmpRoot, "global-config.json");
    fs.mkdirSync(path.join(chromeUserData, "Default"), { recursive: true });
    prevEnv = {
      UFOO_BROWSER_HOME: process.env.UFOO_BROWSER_HOME,
      UFOO_BROWSER_NATIVE_HOST_DIRS: process.env.UFOO_BROWSER_NATIVE_HOST_DIRS,
      UFOO_BROWSER_CHROME_USER_DATA_DIR: process.env.UFOO_BROWSER_CHROME_USER_DATA_DIR,
      UFOO_BROWSER_PLATFORM: process.env.UFOO_BROWSER_PLATFORM,
      UFOO_GLOBAL_CONFIG_PATH: process.env.UFOO_GLOBAL_CONFIG_PATH,
    };
    process.env.UFOO_BROWSER_HOME = browserHome;
    process.env.UFOO_BROWSER_NATIVE_HOST_DIRS = nativeHostDir;
    process.env.UFOO_BROWSER_CHROME_USER_DATA_DIR = chromeUserData;
    process.env.UFOO_BROWSER_PLATFORM = "darwin";
    process.env.UFOO_GLOBAL_CONFIG_PATH = globalCfgFile;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("non-interactive setup and --yes skip browser without downloading or registering native host", async () => {
    const installImpl = jest.fn();
    const res = await runSetupCommand({ yes: true }, {
      env: process.env,
      stdin: { isTTY: false },
      stdout: { isTTY: false },
      write: () => {},
      installImpl,
    });
    expect(res).toMatchObject({ ok: true, choice: "skip", state: "not_installed" });
    expect(installImpl).not.toHaveBeenCalled();
    expect(loadGlobalBrowserConfig()).toMatchObject({
      setupChoice: "skip",
      enabled: false,
      backend: "ufoo-extension",
      schemaVersion: 1,
    });
    expect(fs.existsSync(browserHome)).toBe(false);
    expect(fs.existsSync(nativeHostDir)).toBe(false);
  });

  test("first-run interactive setup prompts once, respects lock, and ignores CI/workers/flags", async () => {
    expect(shouldOfferFirstRunSetup({
      surface: "ufoo",
      argv: ["--help"],
      env: process.env,
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    })).toBe(false);
    expect(shouldOfferFirstRunSetup({
      surface: "ucode",
      argv: [],
      env: { ...process.env, UFOO_SUBSCRIBER_ID: "ucode:1234" },
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    })).toBe(false);
    expect(shouldOfferFirstRunSetup({
      surface: "ufoo",
      argv: [],
      env: { ...process.env, CI: "1" },
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    })).toBe(false);

    const promptYesNo = jest.fn(async () => false);
    const first = await maybeRunFirstTimeSetup({
      surface: "ucode",
      argv: [],
      env: process.env,
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      write: () => {},
      promptYesNo,
    });
    expect(first.prompted).toBe(true);
    expect(promptYesNo).toHaveBeenCalledTimes(1);
    expect(loadGlobalBrowserConfig().setupChoice).toBe("skip");

    // Second launch never re-prompts.
    const second = await maybeRunFirstTimeSetup({
      surface: "ufoo",
      argv: [],
      env: process.env,
      stdin: { isTTY: true },
      stdout: { isTTY: true },
      write: () => {},
      promptYesNo,
    });
    expect(second.prompted).toBe(false);
    expect(promptYesNo).toHaveBeenCalledTimes(1);
  });

  test("component installer verifies checksums, preserves active runtime on failure, and respects leases", async () => {
    const src1 = path.join(tmpRoot, "src-v1");
    makeFakeComponentSource(src1, "0.0.85");
    const installed = await installBrowserRuntime({ env: process.env, sourceDir: src1 });
    expect(installed.ok).toBe(true);
    expect(readActiveRuntime(process.env).version).toBe("0.0.85");

    // Verify SHA-256 mismatch rolls back cleanly and keeps v1 active.
    const badTar = path.join(tmpRoot, "bad.tgz");
    fs.writeFileSync(badTar, "not-a-valid-tarball");
    await expect(installBrowserRuntime({
      env: process.env,
      tarball: badTar,
      sha256: "0".repeat(64),
    })).rejects.toThrow("sha256 mismatch");
    expect(readActiveRuntime(process.env).version).toBe("0.0.85");

    // Failed self-check also leaves previous active.json untouched.
    const srcBad = path.join(tmpRoot, "src-bad");
    makeFakeComponentSource(srcBad, "0.0.86");
    await expect(installBrowserRuntime({
      env: process.env,
      sourceDir: srcBad,
      runSelfCheck: () => { throw new Error("self-check failed"); },
    })).rejects.toThrow("self-check failed");
    expect(readActiveRuntime(process.env).version).toBe("0.0.85");

    // Leasing 0.0.85 keeps its directory during an update to 0.0.87.
    const releaseLease = acquireRuntimeLease("0.0.85", process.env);
    const oldEntry = readActiveRuntime(process.env).entryPath;
    const src2 = path.join(tmpRoot, "src-v2");
    makeFakeComponentSource(src2, "0.0.87");
    await installBrowserRuntime({ env: process.env, sourceDir: src2 });
    expect(readActiveRuntime(process.env).version).toBe("0.0.87");
    expect(fs.existsSync(oldEntry)).toBe(true);
    releaseLease();

    // Update again -> old unleased 0.0.85 gets pruned.
    await installBrowserRuntime({ env: process.env, sourceDir: src2 });
    expect(fs.existsSync(oldEntry)).toBe(false);
    expect(computeFileSha256(badTar)).toBe(crypto.createHash("sha256").update("not-a-valid-tarball").digest("hex"));
    uninstallBrowserRuntime({ env: process.env });
  });

  test("native host registration uses strict allowed_origins, detects/repairs broken Node path, and uninstall cleans up", async () => {
    const src = path.join(tmpRoot, "src-component");
    makeFakeComponentSource(src, "0.0.85");

    // Unsupported platform never reports install success.
    const unsupported = await runBrowserInstall({
      env: { ...process.env, UFOO_BROWSER_PLATFORM: "win32" },
      sourceDir: src,
    });
    expect(unsupported).toMatchObject({ ok: false, state: "unsupported_platform" });

    // Store unpublished -> pending_browser_install (never hijacks Microsoft's Playwright extension ID).
    const res = await runBrowserInstall({
      env: process.env,
      sourceDir: src,
      dev: true,
      openStore: false,
    });
    expect(res).toMatchObject({ ok: true, state: "pending_browser_install" });

    const devManifestFile = path.join(nativeHostDir, `${DEV_NATIVE_HOST_NAME}.json`);
    const devManifest = JSON.parse(fs.readFileSync(devManifestFile, "utf8"));
    expect(devManifest.allowed_origins).toEqual([`chrome-extension://${DEV_EXTENSION_ID}/`]);
    expect(devManifest.allowed_origins.join(",")).not.toContain("mmlmfjhmonkocbjadbfplnigmagldckm");
    expect(fs.existsSync(path.join(nativeHostDir, `${NATIVE_HOST_NAME}.json`))).toBe(false);

    // Corrupt launcher with missing Node path -> doctor repairs it automatically.
    fs.writeFileSync(devManifest.path, "#!/bin/sh\nexec '/nonexistent/node/bin/node' '/tmp/runner.js' \"$@\"\n", { mode: 0o755 });
    const preHealth = checkNativeHostHealth({ env: process.env });
    expect(preHealth.issues).toContain("node_executable_missing");

    const doc = await runBrowserDoctor({ repair: true, env: process.env });
    expect(doc.repaired).toBe(true);
    expect(checkNativeHostHealth({ env: process.env }).ok).toBe(true);

    // Disable / enable toggles without removing runtime or Chrome state.
    await runBrowserDisable({ env: process.env });
    expect(computeBrowserSetupStatus({ env: process.env }).state).toBe("disabled");
    await runBrowserEnable({ env: process.env });
    expect(computeBrowserSetupStatus({ env: process.env }).state).toBe("pending_browser_install");

    // Uninstall removes host and runtime without touching Chrome profile directory.
    const uninst = await runBrowserUninstall({ env: process.env });
    expect(uninst.ok).toBe(true);
    expect(fs.existsSync(devManifestFile)).toBe(false);
    expect(fs.existsSync(path.join(chromeUserData, "Default"))).toBe(true);
    expect(loadGlobalBrowserConfig()).toMatchObject({ enabled: false, setupChoice: "skip" });
    unregisterNativeHost({ env: process.env });
  });
});

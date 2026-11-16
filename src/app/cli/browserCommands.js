"use strict";

const { spawnSync } = require("child_process");
const { loadGlobalBrowserConfig, saveGlobalBrowserConfig } = require("../../config");
const { getReleaseManifest } = require("../../runtime/browser/manifest");
const {
  computeBrowserSetupStatus,
  readInstallState,
  writeInstallState,
} = require("../../runtime/browser/installState");
const {
  installBrowserRuntime,
  uninstallBrowserRuntime,
  pruneUnusedRuntimes,
} = require("../../runtime/browser/componentInstaller");
const {
  registerNativeHost,
  checkNativeHostHealth,
  repairNativeHost,
  unregisterNativeHost,
} = require("../../runtime/browser/nativeHost");
const {
  requestBroker,
  pingBroker,
  notifyBrokerConfigChanged,
} = require("../../runtime/browser/brokerClient");
const { BrowserBroker } = require("../../runtime/browser/broker");
const PACKAGE_VERSION = require("../../../package.json").version;

async function getLiveBrowserStatus({ env = process.env } = {}) {
  const brokerAlive = await pingBroker({ env });
  const brokerStatus = brokerAlive ? await requestBroker("status", {}, { env }) : null;
  return computeBrowserSetupStatus({ env, brokerStatus });
}

function formatStatusLines(status) {
  const lines = [
    `State: ${status.state}`,
    `Setup choice: ${status.setupChoice}`,
    `Enabled: ${status.enabled ? "yes" : "no"}`,
    `Backend: ${status.backend}`,
    `Platform: ${status.platform} (${status.platformSupported ? "supported" : "unsupported"})`,
    `Chrome detected: ${status.chromeInstalled ? "yes" : "no"}`,
    `Optional runtime: ${status.runtimeInstalled ? `${status.runtimeVersion} (${status.activeEntryPath})` : "not installed"}`,
    `Native Messaging Host: ${status.nativeHostRegistered ? "registered" : "not registered"}`,
    `Extension detected in Chrome profile: ${status.extensionInstalled ? "yes" : "no"}`,
    `Broker running: ${status.brokerRunning ? "yes" : "no"}`,
    `Extension connected: ${status.extensionConnected ? "yes" : "no"}${status.paused ? " (paused)" : ""}`,
  ];
  if (!status.protocolCompatible) {
    lines.push(`Protocol compatibility: MISMATCH (${status.lastError || "update required"})`);
  }
  if (status.state === "pending_browser_install") {
    if (status.installMode === "dev" || !status.storePublished) {
      lines.push("");
      if (!status.storePublished) {
        lines.push("Chrome Web Store listing is not published yet.");
      }
      if (status.devExtensionDir) {
        lines.push("Developer mode instructions:");
        lines.push("  1. Open chrome://extensions in Chrome and enable Developer mode.");
        lines.push(`  2. Click 'Load unpacked' and select: ${status.devExtensionDir}`);
        lines.push(`  3. Confirm extension ID is ${status.devExtensionId}`);
      }
    } else if (status.storeUrl) {
      lines.push(`Install Chrome extension from: ${status.storeUrl}`);
    }
  }
  return lines;
}

async function runBrowserInstall({
  dev = false,
  sourceDir = "",
  tarball = "",
  sha256 = "",
  openStore = true,
  env = process.env,
  installRuntimeImpl = installBrowserRuntime,
  registerHostImpl = registerNativeHost,
} = {}) {
  const mode = dev ? "dev" : "release";
  const initial = computeBrowserSetupStatus({ env });
  if (!initial.platformSupported) {
    return {
      ok: false,
      state: "unsupported_platform",
      error: `ufoo Browser v1 only supports macOS + Chrome (current platform: ${initial.platform}).`,
      status: initial,
    };
  }

  saveGlobalBrowserConfig({
    setupChoice: "install",
    enabled: true,
    backend: "ufoo-extension",
  });

  await installRuntimeImpl({ env, sourceDir, tarball, sha256, mode });
  registerHostImpl({ env, mode });
  writeInstallState({ mode }, env);

  const status = await getLiveBrowserStatus({ env });
  if (openStore && !dev && status.storePublished && status.storeUrl && !status.extensionInstalled && process.platform === "darwin") {
    try {
      spawnSync("open", [status.storeUrl], { stdio: "ignore", timeout: 5000 });
    } catch {
      // Best-effort browser open
    }
  }
  await notifyBrokerConfigChanged({ env }).catch(() => {});

  return {
    ok: status.state === "ready" || status.state === "waiting_for_browser" || status.state === "pending_browser_install",
    state: status.state,
    status,
  };
}

async function runBrowserDoctor({ repair = true, env = process.env } = {}) {
  const status = await getLiveBrowserStatus({ env });
  let health = checkNativeHostHealth({ env });
  let repaired = false;

  if (repair && status.runtimeInstalled && health.issues.includes("node_executable_missing")) {
    repairNativeHost({ env, mode: status.installMode || "release" });
    health = checkNativeHostHealth({ env });
    repaired = true;
  }

  const issues = [];
  if (!status.platformSupported) issues.push(`Unsupported platform: ${status.platform}`);
  if (!status.chromeInstalled) issues.push("Google Chrome not detected in standard macOS locations");
  if (!status.runtimeInstalled) issues.push("Optional Playwright MCP runtime is not installed (run `ufoo browser install`)");
  if (!status.enabled) issues.push("ufoo Browser is currently disabled (run `ufoo browser enable`)");
  for (const issue of health.issues) {
    issues.push(`Native Messaging Host: ${issue}`);
  }
  if (!status.protocolCompatible) issues.push(`Protocol mismatch: ${status.lastError || "update extension or ufoo"}`);
  if (status.state === "pending_browser_install") {
    issues.push(status.storePublished
      ? `Chrome extension not installed yet (${status.storeUrl})`
      : "Chrome Web Store listing not published yet (use `ufoo browser install --dev` for unpacked developer extension)");
  }

  return {
    ok: issues.length === 0 || (status.state === "waiting_for_browser" && health.ok),
    repaired,
    status,
    nativeHostHealth: health,
    issues,
  };
}

async function runBrowserEnable({ env = process.env } = {}) {
  const install = readInstallState(env);
  if (!install.runtimeInstalled) {
    const status = await getLiveBrowserStatus({ env });
    return {
      ok: false,
      code: "not_installed",
      error: "ufoo Browser runtime is not installed yet. Run `ufoo browser install` first.",
      status,
    };
  }
  saveGlobalBrowserConfig({ enabled: true, setupChoice: "install" });
  await notifyBrokerConfigChanged({ env });
  const status = await getLiveBrowserStatus({ env });
  return { ok: true, status };
}

async function runBrowserDisable({ env = process.env } = {}) {
  saveGlobalBrowserConfig({ enabled: false });
  await notifyBrokerConfigChanged({ env });
  const status = await getLiveBrowserStatus({ env });
  return { ok: true, status };
}

async function runBrowserUpdate({
  sourceDir = "",
  tarball = "",
  sha256 = "",
  env = process.env,
  installRuntimeImpl = installBrowserRuntime,
} = {}) {
  const before = await getLiveBrowserStatus({ env });
  const mode = before.installMode || "release";
  const result = await installRuntimeImpl({ env, sourceDir, tarball, sha256, mode });
  registerNativeHost({ env, mode });
  pruneUnusedRuntimes({ env });
  const after = await getLiveBrowserStatus({ env });
  return {
    ok: after.protocolCompatible,
    previousVersion: before.runtimeVersion,
    version: result.active?.version || after.runtimeVersion,
    status: after,
  };
}

async function runBrowserUninstall({ env = process.env } = {}) {
  if (await pingBroker({ env })) {
    await requestBroker("revoke_all", {}, { env }).catch(() => {});
  }
  const hostRes = unregisterNativeHost({ env });
  const runtimeRes = uninstallBrowserRuntime({ env });
  saveGlobalBrowserConfig({ enabled: false, setupChoice: "skip" });
  return {
    ok: true,
    removedNativeHosts: hostRes.removed,
    removedRuntime: runtimeRes.removed,
    chromeExtensionNote: "If you installed the Ufoo extension in Chrome, remove it manually from chrome://extensions. Existing Chrome tabs, cookies and history were not modified.",
  };
}

async function serveBrowserBroker({ env = process.env } = {}) {
  const broker = new BrowserBroker({ env, hostVersion: PACKAGE_VERSION });
  await broker.start();
  const shutdown = async () => {
    await broker.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  return broker;
}

async function runBrowserCommand(subcommand = "status", args = [], opts = {}, {
  env = process.env,
  write = (line) => console.log(line),
  writeError = (line) => console.error(line),
} = {}) {
  void args;
  const sub = String(subcommand || "status").trim().toLowerCase();
  const outputJson = opts.json === true;

  if (sub === "broker-serve") {
    await serveBrowserBroker({ env });
    return 0;
  }

  try {
    if (sub === "status") {
      const status = await getLiveBrowserStatus({ env });
      if (outputJson) write(JSON.stringify(status, null, 2));
      else for (const line of formatStatusLines(status)) write(line);
      return 0;
    }

    if (sub === "install") {
      const res = await runBrowserInstall({
        dev: opts.dev === true,
        sourceDir: opts.source || "",
        tarball: opts.tarball || "",
        sha256: opts.sha256 || "",
        openStore: opts.noOpen !== true,
        env,
      });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else if (!res.ok) writeError(res.error || "Browser install failed");
      else for (const line of formatStatusLines(res.status)) write(line);
      return res.ok ? 0 : 1;
    }

    if (sub === "doctor") {
      const res = await runBrowserDoctor({ repair: opts.noRepair !== true, env });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else {
        write("=== ufoo browser doctor ===");
        if (res.repaired) write("Repaired native host Node executable path.");
        for (const line of formatStatusLines(res.status)) write(line);
        if (res.issues.length) {
          write("");
          write("Issues:");
          for (const issue of res.issues) write(`- ${issue}`);
        } else {
          write("");
          write("No issues detected.");
        }
      }
      return res.ok ? 0 : 1;
    }

    if (sub === "enable") {
      const res = await runBrowserEnable({ env });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else if (!res.ok) writeError(res.error);
      else write(`ufoo Browser enabled (state=${res.status.state})`);
      return res.ok ? 0 : 1;
    }

    if (sub === "disable") {
      const res = await runBrowserDisable({ env });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else write("ufoo Browser disabled (Chrome extension and login state preserved).");
      return 0;
    }

    if (sub === "update") {
      const res = await runBrowserUpdate({
        sourceDir: opts.source || "",
        tarball: opts.tarball || "",
        sha256: opts.sha256 || "",
        env,
      });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else write(`ufoo Browser runtime updated to ${res.version} (state=${res.status.state})`);
      return res.ok ? 0 : 1;
    }

    if (sub === "uninstall") {
      const res = await runBrowserUninstall({ env });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else {
        write("ufoo Browser native host and optional runtime removed.");
        write(res.chromeExtensionNote);
      }
      return 0;
    }

    throw new Error(`Unknown browser subcommand: ${sub}. Use install|status|doctor|enable|disable|update|uninstall`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    if (outputJson) write(JSON.stringify({ ok: false, error: message }, null, 2));
    else writeError(message);
    return 1;
  }
}

module.exports = {
  getLiveBrowserStatus,
  formatStatusLines,
  runBrowserInstall,
  runBrowserDoctor,
  runBrowserEnable,
  runBrowserDisable,
  runBrowserUpdate,
  runBrowserUninstall,
  serveBrowserBroker,
  runBrowserCommand,
};

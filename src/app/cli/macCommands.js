"use strict";

const { loadGlobalMacConfig, saveGlobalMacConfig } = require("../../config");
const {
  resolveCachedHelperBinary,
  detectSwiftCompiler,
  ensureHelperCompiled,
  runHelperCheck,
} = require("../../runtime/mac/helperCompiler");
const {
  pingHelperDaemon,
  ensureHelperDaemon,
  stopHelperDaemon,
  callHelperRpc,
} = require("../../runtime/mac/helperClient");

async function getLiveMacStatus({
  env = process.env,
  platform = process.platform,
  compileIfMissing = true,
  ensureCompiledImpl = ensureHelperCompiled,
  checkHelperImpl = runHelperCheck,
  pingDaemonImpl = pingHelperDaemon,
  detectCompilerImpl = detectSwiftCompiler,
} = {}) {
  const cfg = loadGlobalMacConfig();
  if (platform !== "darwin") {
    return {
      state: "unsupported_platform",
      platform,
      platformSupported: false,
      enabled: cfg.enabled,
      hud: cfg.hud,
      takeoverGuard: cfg.takeoverGuard,
    };
  }

  const compiler = detectCompilerImpl({ env });
  const cached = resolveCachedHelperBinary({ env, platform });
  const daemonStatus = await pingDaemonImpl({ env });

  let checkData = daemonStatus;
  let binaryPath = cached.exists ? cached.binaryPath : "";
  let helperCompiled = cached.exists;
  let compileError = "";

  if (!checkData && (cached.exists || (compileIfMissing && compiler.available))) {
    try {
      const compiled = await ensureCompiledImpl({ env, platform });
      binaryPath = compiled.binaryPath;
      helperCompiled = true;
      checkData = await checkHelperImpl({
        env,
        platform,
        prompt: false,
        openSettings: false,
        ensureCompiledImpl: async () => compiled,
      });
    } catch (err) {
      compileError = err?.message || String(err);
    }
  }

  const permissions = checkData?.permissions || { accessibility: false, screenRecording: false };
  const permsGranted = Boolean(permissions.accessibility && permissions.screenRecording);

  let state = "ready";
  if (!cfg.enabled || String(env.UFOO_MAC_ENABLED || "").trim() === "0") {
    state = "disabled";
  } else if (!helperCompiled && !compiler.available) {
    state = "swiftc_missing";
  } else if (compileError) {
    state = "helper_error";
  } else if (!permsGranted) {
    state = "permissions_needed";
  }

  return {
    state,
    platform,
    platformSupported: true,
    enabled: cfg.enabled && String(env.UFOO_MAC_ENABLED || "").trim() !== "0",
    hud: cfg.hud,
    takeoverGuard: cfg.takeoverGuard,
    swiftCompilerAvailable: compiler.available,
    pointerMode: checkData?.pointerMode || "unknown",
    swiftVersion: compiler.version || "",
    helperCompiled,
    binaryPath,
    daemonRunning: Boolean(daemonStatus),
    daemonPid: daemonStatus?.pid || null,
    osVersion: checkData?.osVersion || "",
    permissions,
    displays: checkData?.displays || [],
    frontmostApp: checkData?.frontmostApp || null,
    takeover: checkData?.takeover || null,
    ...(compileError ? { lastError: compileError } : {}),
  };
}

function formatMacStatusLines(status) {
  const lines = [
    `State: ${status.state}`,
    `Platform: ${status.platform} (${status.platformSupported ? "supported" : "unsupported"})`,
    `Enabled: ${status.enabled ? "yes" : "no"}`,
    `Agent Mouse HUD: ${status.hud ? "on" : "off"}`,
    `Human Takeover Guard (Mouse Shake / Esc): ${status.takeoverGuard ? "on" : "off"}`,
  ];
  if (!status.platformSupported) return lines;

  lines.push(`Agent Mouse input: ${status.pointerMode || "unknown"}`);
  lines.push(`Swift compiler: ${status.swiftCompilerAvailable ? (status.swiftVersion || "available") : "missing (run `xcode-select --install`)"}`);
  lines.push(`Native helper: ${status.helperCompiled ? status.binaryPath : "not compiled"}`);
  lines.push(`Helper daemon: ${status.daemonRunning ? `running (pid=${status.daemonPid})` : "standby (starts on demand)"}`);
  if (status.permissions) {
    lines.push(`Accessibility permission: ${status.permissions.accessibility ? "granted" : "MISSING"}`);
    lines.push(`Screen Recording permission: ${status.permissions.screenRecording ? "granted" : "MISSING"}`);
  }
  if (Array.isArray(status.displays) && status.displays.length) {
    const dispSummary = status.displays
      .map((d) => `#${d.index} ${d.bounds.width}x${d.bounds.height}@${d.scaleFactor}x${d.main ? " (main)" : ""}`)
      .join(", ");
    lines.push(`Displays: ${dispSummary}`);
  }
  if (status.frontmostApp?.name) {
    lines.push(`Frontmost app: ${status.frontmostApp.name} (pid=${status.frontmostApp.pid})`);
  }
  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }
  if (status.state === "permissions_needed") {
    lines.push("");
    lines.push("Next step: run `ufoo mac permissions` to grant Accessibility and Screen Recording to your terminal app.");
  }
  return lines;
}

async function runMacDoctor({ env = process.env, platform = process.platform } = {}) {
  const status = await getLiveMacStatus({ env, platform, compileIfMissing: true });
  const issues = [];
  let daemonVerified = false;

  if (!status.platformSupported) {
    issues.push(`Unsupported platform: ${status.platform} (macOS required)`);
  } else {
    if (!status.swiftCompilerAvailable && !status.helperCompiled) {
      issues.push("Apple Swift compiler (`swiftc`) not found — install with `xcode-select --install`");
    }
    if (!status.helperCompiled) {
      issues.push(`Native helper failed to compile${status.lastError ? `: ${status.lastError}` : ""}`);
    } else {
      try {
        const daemon = await ensureHelperDaemon({ env, platform });
        daemonVerified = Boolean(daemon && daemon.ok);
      } catch (err) {
        issues.push(`Helper daemon socket check failed: ${err?.message || err}`);
      }
    }
    if (!status.enabled) {
      issues.push("Mac app automation is disabled (`ufoo mac enable`)");
    }
    if (!status.permissions?.accessibility) {
      issues.push("Accessibility permission is missing (required for AX UI tree & Agent Mouse/keyboard) — run `ufoo mac permissions`");
    }
    if (!status.permissions?.screenRecording) {
      issues.push("Screen Recording permission is missing (required for window/screen screenshots) — run `ufoo mac permissions`");
    }
  }

  return {
    ok: issues.length === 0,
    daemonVerified,
    status,
    issues,
  };
}

async function runMacPermissions({
  openSettings = true,
  env = process.env,
  platform = process.platform,
  checkHelperImpl = runHelperCheck,
  stopDaemonImpl = stopHelperDaemon,
} = {}) {
  if (platform !== "darwin") {
    return {
      ok: false,
      state: "unsupported_platform",
      error: `ufoo mac permissions is only available on macOS (current: ${platform}).`,
    };
  }
  // Restart daemon so fresh TCC grants apply immediately on next action
  await stopDaemonImpl({ env }).catch(() => {});
  const checked = await checkHelperImpl({
    env,
    platform,
    prompt: true,
    openSettings,
  });
  const perms = checked.permissions || {};
  const grantedAll = Boolean(perms.accessibility && perms.screenRecording);
  return {
    ok: true,
    grantedAll,
    permissions: perms,
    note: grantedAll
      ? "Both Accessibility and Screen Recording permissions are granted."
      : "Grant Accessibility and Screen Recording to your terminal/IDE host in System Settings -> Privacy & Security, then re-run `ufoo mac status`.",
  };
}

async function runMacCommand(subcommand = "status", args = [], opts = {}, {
  env = process.env,
  platform = process.platform,
  write = (line) => console.log(line),
  writeError = (line) => console.error(line),
} = {}) {
  const sub = String(subcommand || "status").trim().toLowerCase();
  const outputJson = opts.json === true;

  try {
    if (sub === "status") {
      const status = await getLiveMacStatus({ env, platform });
      if (outputJson) write(JSON.stringify(status, null, 2));
      else for (const line of formatMacStatusLines(status)) write(line);
      return 0;
    }

    if (sub === "doctor") {
      const res = await runMacDoctor({ env, platform });
      if (outputJson) {
        write(JSON.stringify(res, null, 2));
      } else {
        write("=== ufoo mac doctor ===");
        for (const line of formatMacStatusLines(res.status)) write(line);
        write(`Daemon socket RPC verified: ${res.daemonVerified ? "yes" : "no"}`);
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

    if (sub === "permissions" || sub === "grant" || sub === "setup") {
      const res = await runMacPermissions({
        openSettings: opts.open !== false && opts.noOpen !== true,
        env,
        platform,
      });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else if (!res.ok) writeError(res.error);
      else {
        write(`Accessibility: ${res.permissions.accessibility ? "granted" : "MISSING"}`);
        write(`Screen Recording: ${res.permissions.screenRecording ? "granted" : "MISSING"}`);
        write(res.note);
      }
      return res.ok ? 0 : 1;
    }

    if (sub === "enable") {
      saveGlobalMacConfig({ enabled: true });
      const status = await getLiveMacStatus({ env, platform });
      if (outputJson) write(JSON.stringify({ ok: true, status }, null, 2));
      else write(`ufoo Mac automation enabled (state=${status.state}).`);
      return 0;
    }

    if (sub === "disable") {
      saveGlobalMacConfig({ enabled: false });
      await stopHelperDaemon({ env }).catch(() => {});
      const status = await getLiveMacStatus({ env, platform, compileIfMissing: false });
      if (outputJson) write(JSON.stringify({ ok: true, status }, null, 2));
      else write("ufoo Mac automation disabled and Agent Mouse helper stopped.");
      return 0;
    }

    if (sub === "hud") {
      const arg = String(args[0] || "").trim().toLowerCase();
      const current = loadGlobalMacConfig();
      let nextHud = current.hud;
      if (!arg || arg === "toggle") nextHud = !current.hud;
      else if (["on", "true", "1", "enable"].includes(arg)) nextHud = true;
      else if (["off", "false", "0", "disable"].includes(arg)) nextHud = false;
      else throw new Error(`Invalid hud mode '${arg}'. Expected on|off|toggle.`);
      const updated = saveGlobalMacConfig({ hud: nextHud });
      if (await pingHelperDaemon({ env })) {
        await callHelperRpc("configure", { hud: nextHud }, { env, platform, mutating: false }).catch(() => {});
      }
      if (outputJson) write(JSON.stringify({ ok: true, hud: updated.hud }, null, 2));
      else write(`Agent Mouse visual HUD: ${updated.hud ? "on" : "off"}`);
      return 0;
    }

    if (sub === "stop") {
      const res = await stopHelperDaemon({ env });
      if (outputJson) write(JSON.stringify(res, null, 2));
      else write(res.stopped ? "Stopped ufoo Mac helper daemon." : "ufoo Mac helper daemon was not running.");
      return 0;
    }

    throw new Error(`Unknown mac subcommand: ${sub}. Use status|doctor|permissions|enable|disable|hud|stop`);
  } catch (err) {
    const message = err?.message || String(err);
    if (outputJson) write(JSON.stringify({ ok: false, error: message }, null, 2));
    else writeError(message);
    return 1;
  }
}

module.exports = {
  getLiveMacStatus,
  formatMacStatusLines,
  runMacDoctor,
  runMacPermissions,
  runMacCommand,
};

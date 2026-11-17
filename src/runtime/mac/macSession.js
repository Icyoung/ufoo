"use strict";

const { createHash, randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadGlobalMacConfig } = require("../../config");
const {
  resolveCachedHelperBinary,
  detectSwiftCompiler,
  runHelperCheck,
} = require("./helperCompiler");
const {
  pingHelperDaemon,
  callHelperRpc,
  acquireMacInputLease,
} = require("./helperClient");

const ALL_OPERATIONS = Object.freeze([
  "status",
  "list_apps",
  "list_windows",
  "launch_app",
  "focus_app",
  "manage_window",
  "snapshot",
  "ax_action",
  "screenshot",
  "move",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "press_key",
  "wait",
  "resume_control",
  "release",
]);

const READ_OPERATIONS = new Set([
  "status",
  "list_apps",
  "list_windows",
  "snapshot",
  "screenshot",
  "release",
]);

const INPUT_OPERATIONS = new Set([
  "move",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "press_key",
]);

const MUTATING_OPERATIONS = new Set([
  "launch_app",
  "focus_app",
  "manage_window",
  "ax_action",
  "move",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type",
  "press_key",
]);

const SETUP_HINT = "Use `ufoo mac status` or `ufoo mac permissions` to check/grant macOS Accessibility & Screen Recording permissions, and `ufoo mac enable` if disabled.";

const hash = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 24);
const failure = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

function normalizeRef(raw = "") {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function formatSnapshotText(meta, elements = []) {
  const header = `UI snapshot for "${meta.app || "App"}" (pid=${meta.pid}${meta.bundleId ? `, ${meta.bundleId}` : ""}) — ${elements.length} elements${meta.truncated ? " [truncated]" : ""}:`;
  if (!elements.length) {
    return `${header}\n(no matching accessible elements found; try screenshot + coordinate click or set includeMenuBar=true)`;
  }
  const lines = [header];
  for (const el of elements) {
    const indent = "  ".repeat(Math.min(6, Math.max(0, Number(el.depth) || 0)));
    const parts = [`${el.ref} [${el.role}]`];
    if (el.title) parts.push(JSON.stringify(el.title));
    if (el.label) parts.push(`label=${JSON.stringify(el.label)}`);
    if (el.value) parts.push(`value=${JSON.stringify(el.value)}`);
    if (el.enabled === false) parts.push("(disabled)");
    if (el.focused) parts.push("(focused)");
    if (el.frame) {
      parts.push(`bounds=(${el.frame.x},${el.frame.y},${el.frame.width},${el.frame.height})`);
    }
    if (Array.isArray(el.actions) && el.actions.length) {
      parts.push(`actions=[${el.actions.join(",")}]`);
    }
    lines.push(`${indent}${parts.join(" ")}`);
  }
  return lines.join("\n");
}

function formatAppsText(apps = []) {
  if (!apps.length) return "No running GUI applications found.";
  const lines = [`Running Mac apps (${apps.length}):`];
  for (const app of apps) {
    const tags = [];
    if (app.active) tags.push("frontmost");
    if (app.hidden) tags.push("hidden");
    const tagText = tags.length ? ` [${tags.join(", ")}]` : "";
    lines.push(`- ${app.name || "(unnamed)"} (pid=${app.pid}, bundleId=${app.bundleId || "-"}, windows=${app.windowCount ?? 0})${tagText}`);
  }
  return lines.join("\n");
}

function formatWindowsText(windows = []) {
  if (!windows.length) return "No matching on-screen Mac windows found.";
  const lines = [`Mac windows (${windows.length}):`];
  for (const w of windows) {
    const b = w.bounds || {};
    const front = w.frontmost ? " [frontmost]" : "";
    lines.push(`- windowId=${w.windowId}${front} app="${w.app}" (pid=${w.pid}) title=${JSON.stringify(w.title || "")} bounds=(${b.x},${b.y},${b.width},${b.height})`);
  }
  return lines.join("\n");
}

function createMacSessions({
  env = process.env,
  platform = process.platform,
  loadMacConfig = loadGlobalMacConfig,
  rpcCall = callHelperRpc,
  pingDaemon = pingHelperDaemon,
  checkHelper = runHelperCheck,
  acquireLease = acquireMacInputLease,
} = {}) {
  const sessions = new Map();

  function isEnabled(cfg) {
    if (String(env.UFOO_MAC_ENABLED || "").trim() === "0") return false;
    if (String(env.UFOO_MAC_ENABLED || "").trim() === "1") return true;
    return cfg.enabled !== false;
  }

  function identity(context = {}) {
    if (!context.sessionId) throw new Error("Mac operations require a sessionId");
    const root = fs.realpathSync(context.workspaceRoot || process.cwd());
    const namespace = String(context.artifactNamespace || "ucode");
    const id = hash(`${root}\0${namespace}\0${context.sessionId}`);
    const agentLabel = namespace === "ucode" ? "ucode" : (context.agentName || "ufoo");
    return { root, id, namespace, agentLabel };
  }

  function get(context = {}) {
    const { root, id, agentLabel } = identity(context);
    if (!sessions.has(id)) {
      sessions.set(id, {
        id,
        root,
        agentLabel,
        outputDir: path.join(root, ".ufoo", "mac", id),
        queue: Promise.resolve(),
        elements: new Map(),
        screenshots: new Map(),
        screenshotSeq: 0,
        lastScreenshotId: "",
        activeTarget: null,
        touchedHelper: false,
      });
    } else {
      sessions.get(id).agentLabel = agentLabel;
    }
    return sessions.get(id);
  }

  function turnScopeFromContext(context = {}) {
    return String(context.requestId || context.taskRunId || context.turnId || context.sessionId || "").trim();
  }

  async function buildStatus(entry, context = {}) {
    if (platform !== "darwin") {
      return {
        ok: true,
        supported: false,
        platform,
        state: "unsupported_platform",
        text: `mac_app is only supported on macOS (current platform: ${platform}).`,
      };
    }
    const cfg = loadMacConfig();
    const enabled = isEnabled(cfg);
    if (!enabled) {
      return {
        ok: true,
        supported: true,
        platform,
        enabled: false,
        hud: cfg.hud,
        takeoverGuard: cfg.takeoverGuard,
        state: "disabled",
        setup: SETUP_HINT,
        text: "Mac app automation is currently disabled. Run `ufoo mac enable` to enable it.",
      };
    }

    const live = await pingDaemon({ env });
    if (live) {
      const perms = live.permissions || {};
      const ready = Boolean(perms.accessibility && perms.screenRecording);
      return {
        ok: true,
        supported: true,
        platform,
        enabled: true,
        hud: cfg.hud,
        takeoverGuard: cfg.takeoverGuard,
        daemonRunning: true,
        state: ready ? "ready" : "permissions_needed",
        ...live,
        setup: SETUP_HINT,
        text: ready
          ? `Mac automation ready (Accessibility=granted, ScreenRecording=granted, displays=${(live.displays || []).length}).`
          : `Mac automation needs permissions: Accessibility=${perms.accessibility ? "granted" : "MISSING"}, ScreenRecording=${perms.screenRecording ? "granted" : "MISSING"}. Run \`ufoo mac permissions\` to grant access.`,
      };
    }

    const cached = resolveCachedHelperBinary({ env, platform });
    const compiler = detectSwiftCompiler({ env });
    if (cached.exists) {
      try {
        const checked = await checkHelper({ env, platform, prompt: false, openSettings: false });
        const perms = checked.permissions || {};
        const ready = Boolean(perms.accessibility && perms.screenRecording);
        return {
          ok: true,
          supported: true,
          platform,
          enabled: true,
          hud: cfg.hud,
          takeoverGuard: cfg.takeoverGuard,
          daemonRunning: false,
          helperCompiled: true,
          state: ready ? "ready" : "permissions_needed",
          ...checked,
          setup: SETUP_HINT,
        };
      } catch {
        // Fall back to lightweight cold status below
      }
    }

    return {
      ok: true,
      supported: true,
      platform,
      enabled: true,
      hud: cfg.hud,
      takeoverGuard: cfg.takeoverGuard,
      daemonRunning: false,
      helperCompiled: cached.exists,
      swiftCompilerAvailable: compiler.available,
      state: compiler.available || cached.exists ? "standby" : "swiftc_missing",
      setup: SETUP_HINT,
      text: compiler.available || cached.exists
        ? "Mac automation is enabled (helper will start automatically on first operation)."
        : "Xcode Command Line Tools (`swiftc`) not found. Install with `xcode-select --install`.",
    };
  }

  async function invokeHelper(entry, method, params = {}, context = {}, { mutating = false, timeoutMs = 20000 } = {}) {
    const cfg = loadMacConfig();
    const enrichedParams = {
      ...params,
      hud: cfg.hud !== false,
      takeoverGuard: cfg.takeoverGuard !== false,
      agentLabel: entry.agentLabel,
      sessionId: entry.id,
      turnScope: turnScopeFromContext(context),
    };
    const res = await rpcCall(method, enrichedParams, {
      env,
      platform,
      timeoutMs,
      signal: context.signal,
      mutating,
    });
    entry.touchedHelper = true;
    if (!res || res.ok === false) {
      return failure(
        res?.code || "mac_action_failed",
        res?.error || `Mac helper '${method}' failed`,
        res?.permission ? { permission: res.permission, setup: SETUP_HINT } : (res?.reason ? { reason: res.reason } : {}),
      );
    }
    if ((method.startsWith("mouse_") || method.startsWith("key_")) && res.result?.pid && res.result?.windowId) {
      entry.activeTarget = { pid: res.result.pid, windowId: res.result.windowId };
    }
    return { ok: true, ...(res.result || {}) };
  }

  function inputTarget(entry, input, point = null) {
    // Explicit or snapshot-derived targets must not inherit an unrelated
    // session target. Unqualified keyboard/scroll calls reuse this session only.
    if (input.pid || input.windowId || input.app || input.bundleId || point?.pid || point?.windowId) {
      return {
        app: input.app || "", bundleId: input.bundleId || "",
        pid: input.pid || point?.pid || 0, windowId: input.windowId || point?.windowId || 0,
      };
    }
    return point ? {} : (entry.activeTarget || {});
  }

  async function resolveCoordinates(entry, rawX, rawY, rawRef, input = {}, context = {}) {
    if (rawRef) {
      const refKey = normalizeRef(rawRef);
      const elem = entry.elements.get(refKey);
      if (!elem) {
        return failure("unknown_element_ref", `Unknown element ref '${refKey}'. Call snapshot first to obtain current @eN refs.`);
      }
      if (!elem.center) {
        return failure("element_no_bounds", `Element ${refKey} (${elem.role}) has no screen bounds; try ax_action with ref="${refKey}" instead.`);
      }
      return {
        ok: true,
        x: elem.center.x,
        y: elem.center.y,
        pid: elem.pid,
        windowId: elem.windowId || 0,
        resolvedFrom: refKey,
      };
    }

    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return failure("invalid_mac_arguments", "Provide either ref (e.g. \"@e4\") or numeric x and y coordinates.");
    }

    const space = String(input.space || "auto").trim().toLowerCase();
    const ssId = String(input.screenshotId || "").trim();

    if (ssId || space === "screenshot") {
      const targetId = ssId || entry.lastScreenshotId;
      const shot = entry.screenshots.get(targetId);
      if (!shot) {
        return failure("unknown_screenshot_id", `Unknown screenshotId '${targetId}'. Take a fresh screenshot or pass space="screen" with global coordinates.`);
      }
      let originX = shot.bounds.x;
      let originY = shot.bounds.y;
      if (shot.windowId > 0 && shot.coordinateSpace === "window") {
        const winCheck = await invokeHelper(entry, "list_windows", { windowId: shot.windowId, includeOffscreen: true }, context, { mutating: false });
        if (winCheck.ok && Array.isArray(winCheck.windows) && winCheck.windows[0]?.bounds) {
          originX = winCheck.windows[0].bounds.x;
          originY = winCheck.windows[0].bounds.y;
        }
      }
      return {
        ok: true,
        x: Math.round(originX + x * shot.scaleX),
        y: Math.round(originY + y * shot.scaleY),
        windowId: shot.windowId || 0,
        pid: shot.pid || 0,
        resolvedFrom: `screenshot:${targetId}`,
      };
    }

    if (space === "window") {
      const winCheck = await invokeHelper(entry, "list_windows", {
        windowId: input.windowId || 0,
        app: input.app || "",
        bundleId: input.bundleId || "",
        pid: input.pid || 0,
      }, context, { mutating: false });
      const win = winCheck.ok && Array.isArray(winCheck.windows) ? winCheck.windows[0] : null;
      if (!win || !win.bounds) {
        return failure("window_not_found", "Could not resolve target window bounds for space=\"window\".");
      }
      return {
        ok: true,
        x: Math.round(win.bounds.x + x),
        y: Math.round(win.bounds.y + y),
        windowId: win.windowId || 0,
        pid: win.pid || 0,
        resolvedFrom: `window:${win.windowId}`,
      };
    }

    return {
      ok: true,
      x: Math.round(x),
      y: Math.round(y),
      windowId: Number(input.windowId) || 0,
      pid: Number(input.pid) || 0,
      resolvedFrom: "screen",
    };
  }

  async function runOperation(entry, input = {}, context = {}) {
    if (context.signal?.aborted) {
      return failure("cancelled", "Mac operation cancelled before execution");
    }
    const operation = String(input.operation || "").trim().toLowerCase();
    if (!ALL_OPERATIONS.includes(operation)) {
      return failure("invalid_mac_operation", `Unsupported operation '${operation}'. Supported: ${ALL_OPERATIONS.join(", ")}`);
    }

    if (operation === "status") {
      return buildStatus(entry, context);
    }

    if (platform !== "darwin") {
      return failure("unsupported_platform", `mac_app automation is only supported on macOS (current: ${platform}).`);
    }

    if (context.executionState?.planMode && !READ_OPERATIONS.has(operation)) {
      return failure("plan_mode", "Mac app actions that change UI state require plan mode to be off (inspection via status, list_apps, list_windows, snapshot, and screenshot remains available).");
    }

    if (operation === "release") {
      if (entry.touchedHelper) {
        await invokeHelper(entry, "hide_hud", {}, context, { mutating: false }).catch(() => {});
        entry.touchedHelper = false;
      }
      entry.elements.clear();
      entry.activeTarget = null;
      entry.screenshots.clear();
      entry.lastScreenshotId = "";
      return { ok: true, released: true, text: "Released Mac session state and hid Agent Mouse HUD." };
    }

    const cfg = loadMacConfig();
    if (!isEnabled(cfg)) {
      return failure("mac_disabled", "Mac app automation is currently disabled. Run `ufoo mac enable` to enable it.", { setup: SETUP_HINT });
    }

    if (operation === "wait") {
      const ms = Math.max(50, Math.min(Number(input.ms ?? input.durationMs ?? 500) || 500, 10000));
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        if (context.signal) {
          context.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("Wait cancelled"), { code: "cancelled" }));
          }, { once: true });
        }
      });
      return { ok: true, waitedMs: ms, text: `Waited ${ms}ms.` };
    }

    if (operation === "resume_control") {
      const cleared = await invokeHelper(entry, "clear_takeover", {}, context, { mutating: false });
      if (!cleared.ok) return cleared;
      return { ok: true, text: "Cleared takeover pause state. Inspect current window/screen before acting." };
    }

    if (operation === "list_apps") {
      const res = await invokeHelper(entry, "list_apps", {
        includeBackground: Boolean(input.includeBackground),
      }, context, { mutating: false });
      if (!res.ok) return res;
      return { ok: true, apps: res.apps || [], text: formatAppsText(res.apps || []) };
    }

    if (operation === "list_windows") {
      const res = await invokeHelper(entry, "list_windows", {
        app: input.app || "",
        bundleId: input.bundleId || "",
        pid: input.pid || 0,
        windowId: input.windowId || 0,
        includeOffscreen: Boolean(input.includeOffscreen),
      }, context, { mutating: false });
      if (!res.ok) return res;
      return { ok: true, windows: res.windows || [], text: formatWindowsText(res.windows || []) };
    }

    if (operation === "launch_app") {
      const res = await invokeHelper(entry, "launch_app", {
        app: input.app || "",
        bundleId: input.bundleId || "",
        waitMs: input.waitMs || 4000,
      }, context, { mutating: true });
      if (!res.ok) return res;
      entry.activeTarget = { pid: res.pid, windowId: input.windowId || res.windows?.[0]?.windowId || 0 };
      return {
        ...res,
        text: `${res.launched ? "Launched" : "Activated"} "${res.name}" (pid=${res.pid}, windows=${(res.windows || []).length}).`,
      };
    }

    if (operation === "focus_app") {
      const res = await invokeHelper(entry, "focus_app", {
        app: input.app || "",
        bundleId: input.bundleId || "",
        pid: input.pid || 0,
        windowId: input.windowId || 0,
      }, context, { mutating: true });
      if (!res.ok) return res;
      entry.activeTarget = { pid: res.pid, windowId: input.windowId || res.windows?.[0]?.windowId || 0 };
      return {
        ...res,
        text: `Focused "${res.name}" (pid=${res.pid}).`,
      };
    }

    if (operation === "manage_window") {
      const windowAction = String(input.windowAction || "focus").trim().toLowerCase();
      const res = await invokeHelper(entry, "manage_window", {
        windowAction,
        app: input.app || "",
        bundleId: input.bundleId || "",
        pid: input.pid || 0,
        windowId: input.windowId || 0,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      }, context, { mutating: true });
      if (!res.ok) return res;
      const b = res.bounds || {};
      return {
        ...res,
        text: `Window ${res.windowId || ""} (${res.app}) action=${windowAction} bounds=(${b.x},${b.y},${b.width},${b.height}).`,
      };
    }

    if (operation === "snapshot") {
      const res = await invokeHelper(entry, "snapshot", {
        app: input.app || "",
        bundleId: input.bundleId || "",
        pid: input.pid || 0,
        windowId: input.windowId || 0,
        maxDepth: input.maxDepth || 7,
        maxNodes: input.maxNodes || 350,
        interactiveOnly: Boolean(input.interactiveOnly),
        includeMenuBar: Boolean(input.includeMenuBar),
        query: input.query || "",
      }, context, { mutating: false });
      if (!res.ok) return res;

      entry.elements.clear();
      const annotated = (res.elements || []).map((el, idx) => {
        const ref = `@e${idx + 1}`;
        const record = { ...el, ref, pid: res.pid };
        entry.elements.set(ref, record);
        return record;
      });
      entry.activeTarget = { pid: res.pid, windowId: input.windowId || annotated.find((el) => el.windowId)?.windowId || 0 };

      const fullText = formatSnapshotText(res, annotated);
      const output = {
        ok: true,
        app: res.app,
        bundleId: res.bundleId,
        pid: res.pid,
        elementCount: annotated.length,
        truncated: Boolean(res.truncated),
      };
      if (fullText.length > 6000) {
        fs.mkdirSync(entry.outputDir, { recursive: true, mode: 0o700 });
        output.outputPath = path.join(entry.outputDir, `snapshot-${randomUUID()}.txt`);
        fs.writeFileSync(output.outputPath, fullText, { mode: 0o600 });
        output.textTruncated = true;
        output.text = `${fullText.slice(0, 6000)}\n[Truncated; use read on outputPath for the remaining UI tree.]`;
      } else {
        output.text = fullText;
      }
      return output;
    }

    if (operation === "ax_action") {
      const refKey = normalizeRef(input.ref);
      if (!refKey) {
        return failure("invalid_mac_arguments", "ref (e.g. \"@e3\" from snapshot) is required for ax_action.");
      }
      const elem = entry.elements.get(refKey);
      if (!elem) {
        return failure("unknown_element_ref", `Unknown element ref '${refKey}'. Call snapshot first to obtain current @eN refs.`);
      }
      const axAction = String(input.axAction || "press").trim().toLowerCase();
      const res = await invokeHelper(entry, "ax_action", {
        pid: elem.pid,
        rootKind: elem.rootKind || "window",
        rootIndex: elem.rootIndex || 0,
        windowId: elem.windowId || 0,
        axPath: elem.axPath || [],
        expectedRole: elem.role || "",
        axAction,
        value: input.value != null ? String(input.value) : (input.text != null ? String(input.text) : ""),
      }, context, { mutating: true });
      if (!res.ok) return res;
      entry.activeTarget = { pid: elem.pid, windowId: elem.windowId || 0 };
      return {
        ...res,
        ref: refKey,
        text: `Executed AX '${axAction}' on ${refKey} [${res.role || elem.role}] ${res.title ? JSON.stringify(res.title) : ""}.`.trim(),
      };
    }

    if (operation === "screenshot") {
      fs.mkdirSync(entry.outputDir, { recursive: true, mode: 0o700 });
      const rawFile = path.join(entry.outputDir, `shot-${randomUUID()}.png`);
      const res = await invokeHelper(entry, "screenshot", {
        outputPath: rawFile,
        app: input.app || "",
        bundleId: input.bundleId || "",
        pid: input.pid || 0,
        windowId: input.windowId || 0,
        display: input.display || 1,
        region: input.region || null,
        retina: Boolean(input.retina),
      }, context, { mutating: false, timeoutMs: 25000 });
      if (!res.ok) return res;

      const finalPath = res.path || rawFile;
      const bytesBuf = fs.readFileSync(finalPath);
      try { fs.chmodSync(finalPath, 0o600); } catch {}

      entry.screenshotSeq += 1;
      const screenshotId = `s${entry.screenshotSeq}`;
      const shotRecord = {
        screenshotId,
        coordinateSpace: res.coordinateSpace || "screen",
        bounds: res.bounds || { x: 0, y: 0, width: res.imageWidth || 0, height: res.imageHeight || 0 },
        imageWidth: res.imageWidth,
        imageHeight: res.imageHeight,
        scaleX: res.scaleX || 1,
        scaleY: res.scaleY || 1,
        windowId: res.windowId || 0,
        pid: res.pid || 0,
        app: res.app || "",
      };
      entry.screenshots.set(screenshotId, shotRecord);
      entry.lastScreenshotId = screenshotId;
      if (shotRecord.pid && shotRecord.windowId) {
        entry.activeTarget = { pid: shotRecord.pid, windowId: shotRecord.windowId };
      }
      if (entry.screenshots.size > 20) {
        const oldestKey = entry.screenshots.keys().next().value;
        entry.screenshots.delete(oldestKey);
      }

      const b = shotRecord.bounds;
      const coordNote = shotRecord.coordinateSpace === "window"
        ? `Pass screenshotId="${screenshotId}" with image (x, y) coordinates (0..${res.imageWidth}, 0..${res.imageHeight}) to click/drag inside this capture, or space="screen" for global coordinates (origin=${b.x},${b.y}).`
        : `Image size=${res.imageWidth}x${res.imageHeight} matches logical screen coordinates (pass screenshotId="${screenshotId}" or direct x, y).`;

      return {
        ok: true,
        kind: "image",
        screenshotId,
        captureKind: res.captureKind,
        coordinateSpace: shotRecord.coordinateSpace,
        bounds: shotRecord.bounds,
        imageWidth: res.imageWidth,
        imageHeight: res.imageHeight,
        windowId: res.windowId || undefined,
        app: res.app || undefined,
        path: finalPath,
        mediaType: res.mediaType || "image/png",
        bytes: bytesBuf.length,
        base64: bytesBuf.toString("base64"),
        text: `Captured ${res.captureKind || "screen"} screenshot id=${screenshotId}${res.app ? ` ("${res.app}")` : ""}. ${coordNote}`,
      };
    }

    // Serialize agent input; the physical user pointer remains independent.
    if (INPUT_OPERATIONS.has(operation)) {
      const releaseInput = await acquireLease({ env });
      try {
        if (operation === "move") {
          const pt = await resolveCoordinates(entry, input.x, input.y, input.ref, input, context);
          if (!pt.ok) return pt;
          const res = await invokeHelper(entry, "mouse_move", { x: pt.x, y: pt.y, ...inputTarget(entry, input, pt) }, context, { mutating: true });
          if (!res.ok) return res;
          return { ...res, resolvedFrom: pt.resolvedFrom, text: `Moved Agent Mouse to (${res.x}, ${res.y}).` };
        }

        if (operation === "click" || operation === "double_click" || operation === "right_click") {
          const pt = await resolveCoordinates(entry, input.x, input.y, input.ref, input, context);
          if (!pt.ok) return pt;
          const button = operation === "right_click" ? "right" : String(input.button || "left").toLowerCase();
          const clickCount = operation === "double_click" ? 2 : (Number(input.clickCount) || 1);
          const focusFirst = input.focusApp === true;
          const res = await invokeHelper(entry, "mouse_click", {
            x: pt.x,
            y: pt.y,
            button,
            clickCount,
            modifiers: Array.isArray(input.modifiers) ? input.modifiers : [],
            focusFirst,
            ...inputTarget(entry, input, pt),
          }, context, { mutating: true });
          if (!res.ok) return res;
          return {
            ...res,
            resolvedFrom: pt.resolvedFrom,
            text: `Clicked (${res.button}, ${res.clickCount}x) at (${res.x}, ${res.y}).`,
          };
        }

        if (operation === "drag") {
          const fromPt = await resolveCoordinates(entry, input.fromX ?? input.x, input.fromY ?? input.y, input.fromRef ?? input.ref, input, context);
          if (!fromPt.ok) return fromPt;
          const toPt = await resolveCoordinates(entry, input.toX, input.toY, input.toRef, input, context);
          if (!toPt.ok) return toPt;
          if ((fromPt.pid && toPt.pid && fromPt.pid !== toPt.pid)
            || (fromPt.windowId && toPt.windowId && fromPt.windowId !== toPt.windowId)) {
            return failure("cross_window_drag_unsupported", "Independent dragging must stay within one target window.");
          }
          const res = await invokeHelper(entry, "mouse_drag", {
            ...inputTarget(entry, input, fromPt),
            fromX: fromPt.x,
            fromY: fromPt.y,
            toX: toPt.x,
            toY: toPt.y,
            holdMs: input.holdMs || 80,
            modifiers: Array.isArray(input.modifiers) ? input.modifiers : [],
          }, context, { mutating: true });
          if (!res.ok) return res;
          return {
            ...res,
            text: `Dragged Agent Mouse from (${res.from.x}, ${res.from.y}) to (${res.to.x}, ${res.to.y}).`,
          };
        }

        if (operation === "scroll") {
          let pt = null;
          if (input.ref || (input.x !== undefined && input.y !== undefined)) {
            const resolved = await resolveCoordinates(entry, input.x, input.y, input.ref, input, context);
            if (!resolved.ok) return resolved;
            pt = resolved;
          }
          const res = await invokeHelper(entry, "mouse_scroll", {
            ...inputTarget(entry, input, pt),
            ...(pt ? { x: pt.x, y: pt.y } : {}),
            deltaX: Number(input.deltaX) || 0,
            deltaY: input.deltaY !== undefined ? Number(input.deltaY) : -240,
          }, context, { mutating: true });
          if (!res.ok) return res;
          return {
            ...res,
            text: `Scrolled (deltaX=${res.deltaX}, deltaY=${res.deltaY}) at (${res.x}, ${res.y}).`,
          };
        }

        if (operation === "type") {
          if (input.focusApp === true) {
            const focused = await invokeHelper(entry, "focus_app", {
              ...inputTarget(entry, input),
            }, context, { mutating: true });
            if (!focused.ok) return focused;
          }
          const res = await invokeHelper(entry, "key_type", {
            ...inputTarget(entry, input),
            text: input.text != null ? String(input.text) : "",
            submit: Boolean(input.submit),
          }, context, { mutating: true, timeoutMs: 30000 });
          if (!res.ok) return res;
          return {
            ...res,
            text: `Typed ${res.typedLength} characters${res.submitted ? " and pressed Return" : ""}.`,
          };
        }

        if (operation === "press_key") {
          if (input.focusApp === true) {
            const focused = await invokeHelper(entry, "focus_app", {
              ...inputTarget(entry, input),
            }, context, { mutating: true });
            if (!focused.ok) return focused;
          }
          const res = await invokeHelper(entry, "key_press", {
            ...inputTarget(entry, input),
            key: input.key || "",
            modifiers: Array.isArray(input.modifiers) ? input.modifiers : [],
            repeat: input.repeat || 1,
          }, context, { mutating: true });
          if (!res.ok) return res;
          return {
            ...res,
            text: `Pressed key '${res.key}'${res.modifiers?.length ? ` with [${res.modifiers.join("+")}]` : ""}${res.repeat > 1 ? ` (${res.repeat}x)` : ""}.`,
          };
        }
      } finally {
        await releaseInput().catch(() => {});
      }
    }

    return failure("invalid_mac_operation", `Unhandled Mac operation: ${operation}`);
  }

  async function execute(input = {}, context = {}) {
    let entry;
    try {
      entry = get(context);
    } catch (err) {
      return failure("mac_context_required", err.message);
    }

    const task = entry.queue.then(async () => {
      try {
        return await runOperation(entry, input, context);
      } catch (err) {
        return failure(
          err?.code || (MUTATING_OPERATIONS.has(input.operation) ? "mac_action_uncertain" : "mac_action_failed"),
          err?.message || "Mac operation failed",
        );
      }
    });
    entry.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async function releaseSession(context = {}) {
    let id;
    try {
      id = identity(context).id;
    } catch {
      return;
    }
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    if (entry.touchedHelper) {
      await rpcCall("hide_hud", {}, { env, platform, timeoutMs: 1200, mutating: false }).catch(() => {});
    }
  }

  async function closeAll() {
    const entries = [...sessions.values()];
    sessions.clear();
    if (entries.some((e) => e.touchedHelper)) {
      await rpcCall("hide_hud", {}, { env, platform, timeoutMs: 1200, mutating: false }).catch(() => {});
    }
  }

  return {
    execute,
    releaseSession,
    closeAll,
  };
}

let sharedSessions = null;
function getMacSessions() {
  if (!sharedSessions) {
    sharedSessions = createMacSessions();
  }
  return sharedSessions;
}

module.exports = {
  ALL_OPERATIONS,
  READ_OPERATIONS,
  INPUT_OPERATIONS,
  createMacSessions,
  getMacSessions,
};

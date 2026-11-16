"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport, getDefaultEnvironment } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { AjvJsonSchemaValidator } = require("@modelcontextprotocol/sdk/validation/ajv-provider.js");
const lockfile = require("proper-lockfile");
const { loadGlobalBrowserConfig } = require("../../config");
const {
  resolveMcpCliEntrypoint,
  acquireRuntimeLease,
  computeBrowserSetupStatus,
} = require("./installState");
const {
  requestBroker,
  ensureBrokerRunning,
} = require("./brokerClient");

// Deliberately exclude browser_install/browser_close and arbitrary Node execution.
// Disconnecting the MCP client must never close the user's browser.
const ALLOWED_TOOLS = new Set([
  "browser_tabs", "browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_find",
  "browser_click", "browser_type", "browser_press_key", "browser_hover", "browser_drag",
  "browser_select_option", "browser_fill_form", "browser_handle_dialog", "browser_wait_for",
  "browser_take_screenshot", "browser_evaluate", "browser_file_upload", "browser_drop",
  "browser_console_messages", "browser_network_requests",
  "browser_mouse_move_xy", "browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_wheel",
]);
const READ_TOOLS = new Set(["browser_snapshot", "browser_find", "browser_take_screenshot", "browser_console_messages", "browser_network_requests", "browser_wait_for"]);
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const failure = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
const setup = "Enable browser support with `ufoo setup --browser=install` (or `ufoo browser install`) and install the Ufoo Chrome extension. For explicit CDP, set UFOO_BROWSER_CDP_ENDPOINT. Never fall back to launching another browser.";

function readConnectionConfig(env = process.env, { loadBrowserConfig = null } = {}) {
  const endpoint = String(env.UFOO_BROWSER_CDP_ENDPOINT || "").trim();
  if (endpoint && !["chrome", "chrome-beta", "chrome-dev", "chrome-canary", "msedge", "msedge-beta", "msedge-dev", "msedge-canary"].includes(endpoint)) {
    const url = new URL(endpoint);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) throw new Error("Invalid browser CDP endpoint protocol");
  }
  if (endpoint) {
    return {
      mode: "cdp",
      endpoint,
      headers: [],
      profile: String(env.UFOO_BROWSER_PROFILE || "").trim(),
    };
  }
  const hostCfg = typeof loadBrowserConfig === "function" ? loadBrowserConfig() : null;
  if (hostCfg && hostCfg.backend === "ufoo-extension") {
    return {
      mode: "ufoo-extension",
      endpoint: "",
      headers: [],
      profile: String(env.UFOO_BROWSER_PROFILE || hostCfg.profile || "").trim(),
    };
  }
  return {
    mode: "extension",
    endpoint: "",
    headers: [],
    profile: String(env.UFOO_BROWSER_PROFILE || "").trim(),
  };
}

async function acquireCdpLease() {
  // One CDP owner per OS user, across processes and workspaces. Endpoint aliases
  // can refer to the same Chrome; a conservative global lease avoids that race.
  const dir = path.join(os.tmpdir(), `ufoo-browser-${process.getuid?.() ?? os.userInfo().username}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return await lockfile.lock(path.join(dir, "cdp"), { realpath: false, stale: 30000, update: 10000, retries: 0 });
  } catch (error) {
    if (error.code === "ELOCKED") throw Object.assign(new Error("Another ufoo/ucode session owns the CDP browser. Disconnect it first, or use extension mode for independently owned tabs."), { code: "browser_busy" });
    throw error;
  }
}

function browserProcessEnvironment(env = process.env) {
  const childEnv = getDefaultEnvironment();
  for (const key of ["TMPDIR", "TMP", "TEMP", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PLAYWRIGHT_MCP_EXTENSION_TOKEN"]) {
    if (env[key]) childEnv[key] = env[key];
  }
  return childEnv;
}

function createMcpConnection({ root, outputDir, config, name, env, cliPath = "", allowBundledFallback = true }) {
  const resolved = cliPath
    ? { entryPath: cliPath, version: "" }
    : resolveMcpCliEntrypoint({ env, allowBundledFallback });
  if (!resolved || !resolved.entryPath) {
    throw Object.assign(new Error("Playwright MCP optional runtime is not installed. Run `ufoo browser install` first."), { code: "not_installed" });
  }
  const args = [resolved.entryPath, "--no-webmcp", "--caps", "vision", "--codegen", "none", "--image-responses", "allow",
    "--output-dir", outputDir, "--file-paths", "absolute", "--timeout-action", "10000", "--timeout-navigation", "45000"];
  if (config.mode === "cdp" || config.mode === "ufoo-extension") {
    args.push("--cdp-endpoint", config.endpoint);
    if (Array.isArray(config.headers)) {
      for (const header of config.headers) args.push("--cdp-header", header);
    }
  } else {
    args.push("--extension");
    if (config.profile) args.push("--profile-dir-name", config.profile);
  }
  const childEnv = browserProcessEnvironment(env);
  const transport = new StdioClientTransport({ command: process.execPath, args, env: childEnv, cwd: root, stderr: "pipe" });
  // Drain diagnostics without leaking extension tokens or URLs into transcripts.
  transport.stderr?.on("data", () => {});
  const client = new Client({ name, version: "1.0.0" });
  return { client, transport };
}

function isReadCall(tool, args = {}) {
  return READ_TOOLS.has(tool) || (tool === "browser_tabs" && args.action === "list");
}

function formatTabListText(tabs = [], currentSessionId = "", paused = false) {
  const lines = [];
  if (paused) lines.push("[Browser control is currently PAUSED in Ufoo extension]");
  if (!tabs.length) {
    lines.push("No open Chrome tabs found (use browser_tabs action=new to open a tab).");
    return lines.join("\n");
  }
  lines.push("Chrome tabs (select with browser_tabs action=select and tabId):");
  tabs.forEach((tab, idx) => {
    const ownerTag = !tab.owner
      ? "available"
      : tab.owner.sessionId === currentSessionId
        ? "owned-by-this-session"
        : `busy (${tab.owner.projectName}/${tab.owner.agentName})`;
    const activeTag = tab.active ? " [active]" : "";
    lines.push(`- index=${idx} tabId=${tab.tabId}${activeTag} [${ownerTag}] ${tab.title || "(untitled)"} — ${tab.url || "about:blank"}`);
  });
  return lines.join("\n");
}

function augmentTabsSchema(tool) {
  if (!tool || tool.name !== "browser_tabs") return tool;
  const schema = tool.inputSchema ? JSON.parse(JSON.stringify(tool.inputSchema)) : { type: "object", properties: {} };
  schema.properties = schema.properties || {};
  schema.properties.tabId = { type: "integer", description: "Stable Chrome tabId returned by browser_tabs action=list (preferred over index in ufoo-extension mode)" };
  return { ...tool, inputSchema: schema };
}

function createBrowserSessions({
  env = process.env,
  createConnection = createMcpConnection,
  acquireLease = acquireCdpLease,
  idleMs = 600000,
  hostControlled = false,
  loadBrowserConfig = loadGlobalBrowserConfig,
  broker = { request: requestBroker, ensureRunning: ensureBrokerRunning },
} = {}) {
  const sessions = new Map();
  const validator = new AjvJsonSchemaValidator();

  function identity(context) {
    if (!context.sessionId) throw new Error("Browser operations require a sessionId");
    const root = fs.realpathSync(context.workspaceRoot || process.cwd());
    const id = hash(`${root}\0${context.artifactNamespace || "ucode"}\0${context.sessionId}`);
    return {
      root,
      id,
      projectName: String(context.projectName || path.basename(root) || "ufoo"),
      agentName: String(context.agentName || context.artifactNamespace || "agent"),
    };
  }

  function get(context) {
    const { root, id, projectName, agentName } = identity(context);
    if (!sessions.has(id)) {
      sessions.set(id, {
        id,
        root,
        projectName,
        agentName,
        outputDir: path.join(root, ".ufoo", "browser", id),
        queue: Promise.resolve(),
        client: null,
        transport: null,
        release: null,
        runtimeRelease: null,
        tools: new Map(),
        state: "disconnected",
        reconnectRequired: false,
        lastListedTabs: [],
        brokerRegistered: false,
        sessionToken: "",
        toolsOnlyClient: false,
      });
    } else {
      const entry = sessions.get(id);
      entry.projectName = projectName;
      entry.agentName = agentName;
    }
    return sessions.get(id);
  }

  async function close(entry, { unregisterBroker = true, preserveTools = false } = {}) {
    clearTimeout(entry.timer);
    const { client, transport, release, runtimeRelease, brokerRegistered, config } = entry;
    entry.client = null;
    entry.transport = null;
    entry.release = null;
    entry.runtimeRelease = null;
    if (unregisterBroker) {
      entry.brokerRegistered = false;
      entry.sessionToken = "";
    }
    entry.toolsOnlyClient = false;
    if (!preserveTools) entry.tools.clear();
    entry.state = "disconnected";
    try {
      await client?.close();
    } finally {
      try {
        await transport?.close();
      } finally {
        if (release) await release();
        if (runtimeRelease) runtimeRelease();
        if (unregisterBroker && brokerRegistered && config?.mode === "ufoo-extension") {
          await broker.request("unregister_session", { sessionId: entry.id }, { env }).catch(() => {});
        }
      }
    }
  }

  function effectiveConfig() {
    return readConnectionConfig(env, { loadBrowserConfig: hostControlled ? loadBrowserConfig : null });
  }

  function checkHostAvailability(cfg) {
    if (!hostControlled) return { allowed: true };
    if (cfg.mode === "cdp") return { allowed: true };
    const browserCfg = loadBrowserConfig();
    if (!browserCfg.enabled) {
      return {
        allowed: false,
        code: "browser_disabled",
        error: "ufoo Browser is disabled or not configured. Run `ufoo setup --browser=install` or `ufoo browser enable` to enable it.",
      };
    }
    const resolvedCli = resolveMcpCliEntrypoint({ env, allowBundledFallback: false });
    if (!resolvedCli) {
      return {
        allowed: false,
        code: "not_installed",
        error: "ufoo Browser optional runtime component is not installed. Run `ufoo browser install` first.",
      };
    }
    return { allowed: true, cli: resolvedCli };
  }

  function status(entry) {
    const cfg = entry.config || effectiveConfig();
    const base = {
      ok: true,
      state: entry.state,
      mode: cfg.mode,
      reconnectRequired: entry.reconnectRequired,
      setup,
    };
    if (!hostControlled) return base;
    const hostStatus = computeBrowserSetupStatus({ env });
    return {
      ...base,
      enabled: hostStatus.enabled,
      availability: hostStatus.state,
      setupChoice: hostStatus.setupChoice,
      runtimeInstalled: hostStatus.runtimeInstalled,
      extensionInstalled: hostStatus.extensionInstalled,
    };
  }

  async function ensureBrokerSession(entry, { requireExtension = true } = {}) {
    const ensured = await broker.ensureRunning({ env });
    if (!ensured.ok) {
      throw Object.assign(new Error(ensured.error || "Browser broker unavailable"), { code: ensured.code || "browser_connection_failed" });
    }
    if (!requireExtension) return null;
    const reg = await broker.request("register_session", {
      sessionId: entry.id,
      projectName: entry.projectName,
      agentName: entry.agentName,
      workspaceRoot: entry.root,
    }, { env });
    if (!reg || !reg.ok) {
      throw Object.assign(new Error(reg?.error || "Chrome extension is not ready"), { code: reg?.code || "waiting_for_browser" });
    }
    entry.brokerRegistered = true;
    if (entry.client && entry.sessionToken && reg.sessionToken && entry.sessionToken !== reg.sessionToken) {
      await close(entry, { unregisterBroker: false });
    }
    entry.sessionToken = reg.sessionToken || "";
    return reg;
  }

  async function start(entry, signal, { skipRelayConnect = false } = {}) {
    if (entry.client) {
      if (skipRelayConnect || !entry.toolsOnlyClient) return;
      await close(entry, { unregisterBroker: false });
    }
    entry.config = effectiveConfig();
    const avail = checkHostAvailability(entry.config);
    if (!avail.allowed) {
      throw Object.assign(new Error(avail.error), { code: avail.code });
    }
    if (entry.config.mode === "cdp") {
      entry.release = await acquireLease();
    } else if (entry.config.mode === "ufoo-extension") {
      if (skipRelayConnect) {
        // Tool schema inspection only: pass a loopback dummy endpoint without touching Chrome.
        entry.config = { ...entry.config, endpoint: "ws://127.0.0.1:1/unused", headers: [] };
      } else {
        const reg = await ensureBrokerSession(entry, { requireExtension: true });
        entry.config = {
          ...entry.config,
          endpoint: reg.wsEndpoint,
          headers: [`Authorization: Bearer ${reg.sessionToken}`],
        };
      }
    }

    if (avail.cli && avail.cli.version) {
      entry.runtimeRelease = acquireRuntimeLease(avail.cli.version, env);
    }
    fs.mkdirSync(entry.outputDir, { recursive: true, mode: 0o700 });
    const { client, transport } = createConnection({
      root: entry.root,
      outputDir: entry.outputDir,
      config: entry.config,
      name: `ufoo-${entry.id}`,
      env,
      cliPath: avail.cli?.entryPath || "",
      allowBundledFallback: !hostControlled,
    });
    entry.client = client;
    entry.transport = transport;
    entry.toolsOnlyClient = Boolean(skipRelayConnect);
    client.onclose = () => {
      if (entry.client !== client) return;
      entry.state = "disconnected";
      entry.reconnectRequired = !entry.toolsOnlyClient;
      entry.queue = entry.queue.then(() => close(entry)).catch(() => {});
    };
    await client.connect(transport, { signal, timeout: 15000 });
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: 15000 });
      for (const tool of page.tools) {
        if (ALLOWED_TOOLS.has(tool.name)) {
          const normalizedTool = entry.config.mode === "ufoo-extension" ? augmentTabsSchema(tool) : tool;
          entry.tools.set(normalizedTool.name, { ...normalizedTool, validate: validator.getValidator(normalizedTool.inputSchema) });
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    entry.state = "ready";
  }

  function normalizeResult(entry, result) {
    const text = (result.content || []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const output = { ok: !result.isError };
    if (result.isError) { output.code = "browser_action_failed"; output.error = text.slice(0, 1500); }
    if (text.length > 6000) {
      output.outputPath = path.join(entry.outputDir, `${randomUUID()}.txt`);
      fs.writeFileSync(output.outputPath, text, { mode: 0o600 });
      output.truncated = true;
    }
    const image = (result.content || []).find((item) => item.type === "image");
    if (image && !result.isError) {
      const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[image.mimeType];
      if (extension) {
        const bytes = Buffer.from(image.data, "base64");
        const file = path.join(entry.outputDir, `${randomUUID()}.${extension}`);
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        Object.assign(output, { path: file, mediaType: image.mimeType, bytes: bytes.length, base64: image.data });
      }
    }
    // Put artifact references before potentially escaped/large page text so
    // transport clipping still leaves a way to retrieve the original output.
    output.text = text.slice(0, 6000) + (output.truncated ? "\n[Truncated; use read on outputPath for the remaining content.]" : "");
    return output;
  }

  async function handleBrokerManagedTabs(entry, args = {}, context = {}) {
    const action = String(args.action || "list");
    if (action === "list") {
      await ensureBrokerSession(entry, { requireExtension: false });
      const res = await broker.request("list_tabs", {}, { env });
      if (!res || !res.ok) return failure(res?.code || "waiting_for_browser", res?.error || "Chrome extension is not connected");
      entry.lastListedTabs = res.tabs || [];
      entry.state = res.paused ? "disconnected" : "ready";
      return {
        ok: true,
        paused: Boolean(res.paused),
        tabs: entry.lastListedTabs,
        text: formatTabListText(entry.lastListedTabs, entry.id, Boolean(res.paused)),
      };
    }

    if (action === "select") {
      let targetTabId = Number(args.tabId);
      if (!Number.isInteger(targetTabId) && Number.isInteger(args.index)) {
        const listed = entry.lastListedTabs[args.index];
        if (listed) targetTabId = listed.tabId;
      }
      if (!Number.isInteger(targetTabId) || targetTabId <= 0) {
        return failure("invalid_browser_arguments", "Specify a valid tabId (or index from browser_tabs action=list)");
      }
      await ensureBrokerSession(entry, { requireExtension: true });
      const claim = await broker.request("claim_tab", { sessionId: entry.id, tabId: targetTabId }, { env });
      if (!claim || !claim.ok) {
        return failure(claim?.code || "browser_tab_busy", claim?.error || "Unable to claim tab", claim?.owner ? { owner: claim.owner } : {});
      }
      await start(entry, context.signal);
      // Ensure Playwright MCP initializes its BrowserContext and selects the claimed tab.
      const listCheck = await entry.client.callTool({ name: "browser_tabs", arguments: { action: "list" } }, undefined, { signal: context.signal, timeout: 15000 });
      if (listCheck?.isError) return normalizeResult(entry, listCheck);
      const tabStatus = await broker.request("session_tab_status", { sessionId: entry.id }, { env });
      const owned = Array.isArray(tabStatus?.ownedTabs) ? tabStatus.ownedTabs : [];
      const ownedIdx = owned.findIndex((item) => item.tabId === targetTabId);
      if (ownedIdx >= 0) {
        const selCheck = await entry.client.callTool({ name: "browser_tabs", arguments: { action: "select", index: ownedIdx } }, undefined, { signal: context.signal, timeout: 15000 });
        if (selCheck?.isError) return normalizeResult(entry, selCheck);
      }
      entry.state = "connected";
      return {
        ok: true,
        tabId: targetTabId,
        title: claim.title || "",
        url: claim.url || "",
        text: `Selected tabId=${targetTabId}: ${claim.title || "(untitled)"} — ${claim.url || ""}`,
      };
    }

    if (action === "new") {
      if (context.executionState?.planMode) return failure("plan_mode", "Browser actions that change state require plan mode to be off");
      await ensureBrokerSession(entry, { requireExtension: true });
      const created = await broker.request("create_tab", { sessionId: entry.id, url: args.url || "" }, { env });
      if (!created || !created.ok) return failure(created?.code || "browser_action_failed", created?.error || "Failed to create tab");
      await start(entry, context.signal);
      const listCheck = await entry.client.callTool({ name: "browser_tabs", arguments: { action: "list" } }, undefined, { signal: context.signal, timeout: 15000 });
      if (listCheck?.isError) return normalizeResult(entry, listCheck);
      const tabStatus = await broker.request("session_tab_status", { sessionId: entry.id }, { env });
      const owned = Array.isArray(tabStatus?.ownedTabs) ? tabStatus.ownedTabs : [];
      const ownedIdx = owned.findIndex((item) => item.tabId === created.tabId);
      if (ownedIdx >= 0) {
        const selCheck = await entry.client.callTool({ name: "browser_tabs", arguments: { action: "select", index: ownedIdx } }, undefined, { signal: context.signal, timeout: 15000 });
        if (selCheck?.isError) return normalizeResult(entry, selCheck);
      }
      entry.state = "connected";
      return {
        ok: true,
        tabId: created.tabId,
        title: created.title || "",
        url: created.url || args.url || "about:blank",
        text: `Opened new owned tabId=${created.tabId} (${created.url || args.url || "about:blank"})`,
      };
    }

    if (action === "close") {
      if (context.executionState?.planMode) return failure("plan_mode", "Browser actions that change state require plan mode to be off");
      const tabStatus = await broker.request("session_tab_status", { sessionId: entry.id }, { env });
      const owned = Array.isArray(tabStatus?.ownedTabs) ? tabStatus.ownedTabs : [];
      let targetTabId = Number(args.tabId);
      if (!Number.isInteger(targetTabId)) {
        const idx = Number.isInteger(args.index) ? args.index : 0;
        targetTabId = owned[idx]?.tabId;
      }
      if (!Number.isInteger(targetTabId)) {
        return failure("tab_not_owned", "No owned tab to close");
      }
      const closed = await broker.request("close_tab", { sessionId: entry.id, tabId: targetTabId }, { env });
      if (!closed || !closed.ok) return failure(closed?.code || "browser_action_failed", closed?.error || "Failed to close tab");
      return { ok: true, closedTabId: targetTabId, text: `Closed tabId=${targetTabId} (no replacement tab created)` };
    }

    return failure("invalid_browser_arguments", `Unsupported browser_tabs action: ${action}`);
  }

  async function execute(input = {}, context = {}) {
    let entry;
    try { entry = get(context); } catch (error) { return failure("browser_context_required", error.message); }
    if (input.operation === "status") return status(entry);

    const run = async () => {
      clearTimeout(entry.timer);
      if (context.signal?.aborted) return failure("cancelled", "Browser operation cancelled before execution");
      const operation = input.operation;
      if (operation === "disconnect") { await close(entry); entry.reconnectRequired = false; return status(entry); }
      if (!["connect", "tools", "call"].includes(operation)) return failure("invalid_browser_operation", "Use status, connect, tools, call or disconnect");

      const cfg = effectiveConfig();
      const avail = checkHostAvailability(cfg);
      if (!avail.allowed) {
        return failure(avail.code, avail.error);
      }

      const tool = operation === "connect" ? "browser_tabs" : input.tool;
      const args = operation === "connect" ? { action: "list" } : (input.arguments || {});
      if (operation === "call" && !ALLOWED_TOOLS.has(tool)) return failure("unsupported_browser_tool", "Use browser tools to discover supported operations");
      if (operation === "call" && context.executionState?.planMode && !isReadCall(tool, args)) return failure("plan_mode", "Browser actions that change state require plan mode to be off");
      if (args.isolatedContext && args.isolatedContext !== "default") return failure("existing_browser_only", "Use the existing browser context; isolated contexts are disabled");
      if (entry.reconnectRequired && operation !== "connect") {
        return failure("browser_reconnect_required", "The browser connection was lost. Explicitly connect and inspect the current page before deciding whether to repeat any action.");
      }

      let dispatched = false;
      try {
        if (operation === "connect" && entry.reconnectRequired) {
          await close(entry);
          entry.reconnectRequired = false;
        }

        if (operation === "tools") {
          if (cfg.mode === "ufoo-extension") {
            if (entry.tools.size === 0) {
              const hadClient = Boolean(entry.client);
              await start(entry, context.signal, { skipRelayConnect: !hadClient });
              if (!hadClient) {
                await close(entry, { unregisterBroker: false, preserveTools: true });
              }
            }
          } else {
            await start(entry, context.signal, { skipRelayConnect: false });
          }
          if (!tool) return { ok: true, tools: [...entry.tools.values()].map((item) => ({ name: item.name, description: item.description })) };
          const found = entry.tools.get(tool);
          return found ? { ok: true, name: found.name, description: found.description, inputSchema: found.inputSchema } : failure("unsupported_browser_tool", "Tool is unavailable in this Playwright version");
        }

        if (cfg.mode === "ufoo-extension" && tool === "browser_tabs") {
          return await handleBrokerManagedTabs(entry, args, context);
        }

        if (cfg.mode === "ufoo-extension") {
          const tabStatus = await broker.request("session_tab_status", { sessionId: entry.id }, { env });
          if (tabStatus?.paused) {
            await close(entry);
            return failure("browser_paused", "Browser control is paused in Ufoo extension");
          }
          if (tabStatus?.invalidated || tabStatus?.releasedSinceLastClaim) {
            await close(entry);
            entry.reconnectRequired = true;
            return failure("browser_reconnect_required", "Tab control was released or interrupted. Reconnect and re-verify the page before acting.");
          }
          if (!Array.isArray(tabStatus?.ownedTabs) || tabStatus.ownedTabs.length === 0) {
            return failure("tab_selection_required", "No tab is claimed for this session. Call browser_tabs with action=list and action=select (with tabId) or action=new first.");
          }
        }

        await start(entry, context.signal);
        const definition = entry.tools.get(tool);
        if (!definition) return failure("unsupported_browser_tool", "Tool is unavailable in this Playwright version");
        const checked = definition.validate(args);
        if (!checked.valid) return failure("invalid_browser_arguments", checked.errorMessage);
        entry.state = entry.state === "connected" ? "connected" : "connecting";
        dispatched = true;
        const result = await entry.client.callTool({ name: tool, arguments: args }, undefined, { signal: context.signal, timeout: 60000, resetTimeoutOnProgress: false });
        entry.state = result.isError && entry.state === "connecting" ? "ready" : "connected";
        return normalizeResult(entry, result);
      } catch (error) {
        await close(entry).catch(() => {});
        entry.reconnectRequired = dispatched;
        const uncertain = dispatched && !isReadCall(tool, args);
        if (!uncertain && ["browser_disabled", "not_installed", "waiting_for_browser", "protocol_mismatch", "browser_paused", "browser_busy"].includes(error?.code)) {
          return failure(error.code, error.message);
        }
        return failure(
          uncertain ? "browser_action_uncertain" : (error.code === "browser_busy" ? "browser_busy" : "browser_connection_failed"),
          `${uncertain ? "Action outcome is unknown; do not retry automatically. Reconnect and inspect the page. " : "Could not complete the browser operation. "}${error.code === "browser_busy" ? error.message : setup}`
        );
      }
    };

    const result = entry.queue.then(run, run).finally(() => {
      if (entry.client) {
        entry.timer = setTimeout(() => {
          entry.reconnectRequired = true;
          entry.queue = entry.queue.then(() => close(entry)).catch(() => {});
        }, idleMs);
        entry.timer.unref?.();
      }
    });
    entry.queue = result.catch(() => {});
    return result;
  }

  async function disconnect(context) { return execute({ operation: "disconnect" }, context); }
  async function closeAll() { await Promise.all([...sessions.values()].map((entry) => entry.queue.then(() => close(entry)))); sessions.clear(); }
  return { execute, disconnect, closeAll };
}

let shared;
function getBrowserSessions() {
  return shared ||= createBrowserSessions({ hostControlled: true });
}

module.exports = {
  createBrowserSessions,
  getBrowserSessions,
  createMcpConnection,
  readConnectionConfig,
  browserProcessEnvironment,
  acquireCdpLease,
  ALLOWED_TOOLS,
  isReadCall,
};

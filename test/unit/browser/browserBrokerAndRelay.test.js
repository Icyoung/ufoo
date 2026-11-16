"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { BrowserBroker } = require("../../../src/runtime/browser/broker");
const { requestBroker } = require("../../../src/runtime/browser/brokerClient");
const { createBrowserSessions } = require("../../../src/runtime/browser/playwrightSession");
const { saveGlobalBrowserConfig } = require("../../../src/config");
const { installBrowserRuntime } = require("../../../src/runtime/browser/componentInstaller");
const {
  DEV_EXTENSION_ID,
  computeExtensionIdFromPublicKey,
  PROTOCOL_VERSION,
} = require("../../../src/runtime/browser/manifest");
const {
  encodeNativeMessage,
  createNativeMessageReader,
} = require("../../../src/runtime/browser/nativeMessagingProtocol");

function makeFakeComponentSource(dir, version = "0.0.85") {
  const pkgDir = path.join(dir, "node_modules", "@playwright", "mcp");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@playwright/mcp", version }));
  fs.writeFileSync(path.join(pkgDir, "cli.js"), "#!/usr/bin/env node\nif (process.argv.includes('--help')) process.exit(0);\n");
}

function connectWs(url, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
    });
  });
}

describe("ufoo Browser broker, Native Messaging, tab ownership, and host gating", () => {
  let tmpRoot;
  let browserHome;
  let globalCfgFile;
  let prevEnv;
  let broker;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-browser-broker-"));
    browserHome = path.join(tmpRoot, "browser-home");
    globalCfgFile = path.join(tmpRoot, "global-config.json");
    prevEnv = {
      UFOO_BROWSER_HOME: process.env.UFOO_BROWSER_HOME,
      UFOO_BROWSER_NATIVE_HOST_DIRS: process.env.UFOO_BROWSER_NATIVE_HOST_DIRS,
      UFOO_BROWSER_CHROME_USER_DATA_DIR: process.env.UFOO_BROWSER_CHROME_USER_DATA_DIR,
      UFOO_GLOBAL_CONFIG_PATH: process.env.UFOO_GLOBAL_CONFIG_PATH,
      UFOO_BROWSER_PLATFORM: process.env.UFOO_BROWSER_PLATFORM,
    };
    process.env.UFOO_BROWSER_PLATFORM = "darwin";
    process.env.UFOO_BROWSER_HOME = browserHome;
    process.env.UFOO_BROWSER_NATIVE_HOST_DIRS = path.join(tmpRoot, "native-hosts");
    process.env.UFOO_BROWSER_CHROME_USER_DATA_DIR = path.join(tmpRoot, "chrome-profile-root");
    process.env.UFOO_GLOBAL_CONFIG_PATH = globalCfgFile;
    saveGlobalBrowserConfig({ enabled: true, setupChoice: "install", backend: "ufoo-extension" });
  });

  afterEach(async () => {
    if (broker) await broker.stop();
    broker = null;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("extension manifest public key deterministically computes DEV_EXTENSION_ID and native framing round-trips", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../extensions/ufoo-browser/manifest.json"), "utf8"));
    expect(computeExtensionIdFromPublicKey(manifest.key)).toBe(DEV_EXTENSION_ID);
    for (const [size, file] of [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)]) {
      const png = fs.readFileSync(path.resolve(__dirname, "../../../extensions/ufoo-browser", file));
      expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(png.readUInt32BE(16)).toBe(Number(size));
      expect(png.readUInt32BE(20)).toBe(Number(size));
    }
    expect(Object.keys(manifest.icons)).toEqual(["16", "32", "48", "128"]);

    const decoded = [];
    const push = createNativeMessageReader((msg) => decoded.push(msg));
    const frame1 = encodeNativeMessage({ type: "hello", id: 1 });
    const frame2 = encodeNativeMessage({ type: "ping", id: 2 });
    const combined = Buffer.concat([frame1, frame2]);
    push(combined.slice(0, 7));
    push(combined.slice(7));
    expect(decoded).toEqual([{ type: "hello", id: 1 }, { type: "ping", id: 2 }]);
  });

  test("broker enforces extension origin, single-use token, protocol compatibility, and CSWSH defense", async () => {
    broker = new BrowserBroker({ env: process.env });
    const info = await broker.start();

    // Unknown or incompatible extension protocol is rejected at native_hello.
    const badExt = await requestBroker("native_hello", {
      extensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      extensionVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    }, { env: process.env });
    expect(badExt).toMatchObject({ ok: false, code: "extension_not_allowed" });

    const badProto = await requestBroker("native_hello", {
      extensionId: DEV_EXTENSION_ID,
      extensionVersion: "0.1.0",
      protocolVersion: 99,
    }, { env: process.env });
    expect(badProto).toMatchObject({ ok: false, code: "protocol_mismatch" });

    const hello = await requestBroker("native_hello", {
      extensionId: DEV_EXTENSION_ID,
      extensionVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    }, { env: process.env });
    expect(hello.ok).toBe(true);

    // Web page Origin cannot use the extension WebSocket token.
    await expect(connectWs(hello.wsUrl, { headers: { Origin: "https://evil.example" } })).rejects.toMatchObject({ statusCode: 403 });

    // Valid extension Origin connects and consumes the single-use token.
    const extWs = await connectWs(hello.wsUrl, { headers: { Origin: `chrome-extension://${DEV_EXTENSION_ID}` } });
    await expect(connectWs(hello.wsUrl, { headers: { Origin: `chrome-extension://${DEV_EXTENSION_ID}` } })).rejects.toMatchObject({ statusCode: 401 });

    extWs.send(JSON.stringify({
      method: "extension.initialized",
      params: { extensionId: DEV_EXTENSION_ID, extensionVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION, tabs: [] },
    }));
    await new Promise((r) => setTimeout(r, 40));

    // Register an agent session -> /cdp/<id> rejects missing bearer or browser Origin (CSWSH).
    const reg = await requestBroker("register_session", { sessionId: "s1", projectName: "proj-a", agentName: "main" }, { env: process.env });
    expect(reg.ok).toBe(true);
    await expect(connectWs(reg.wsEndpoint, { headers: { Origin: "https://evil.example", Authorization: `Bearer ${reg.sessionToken}` } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(connectWs(reg.wsEndpoint, { headers: { Authorization: "Bearer wrong" } })).rejects.toMatchObject({ statusCode: 401 });

    const cdpWs = await connectWs(`ws://127.0.0.1:${info.port}/cdp/s1`, { headers: { Authorization: `Bearer ${reg.sessionToken}` } });
    cdpWs.close();
    extWs.close();
  });

  test("tab ownership isolates sessions, returns browser_tab_busy without preemption, and invalidates on release/pause", async () => {
    broker = new BrowserBroker({ env: process.env });
    await broker.start();

    const hello = await requestBroker("native_hello", {
      extensionId: DEV_EXTENSION_ID,
      extensionVersion: "0.1.0",
      protocolVersion: PROTOCOL_VERSION,
    }, { env: process.env });
    const extWs = await connectWs(hello.wsUrl, { headers: { Origin: `chrome-extension://${DEV_EXTENSION_ID}` } });

    const chromeTabs = [
      { id: 101, windowId: 1, active: true, incognito: false, title: "Dashboard", url: "https://app.example.com" },
      { id: 102, windowId: 1, active: false, incognito: false, title: "Docs", url: "https://docs.example.com" },
      { id: 103, windowId: 1, active: false, incognito: false, title: "Extensions", url: "chrome://extensions" },
      { id: 104, windowId: 2, active: false, incognito: true, title: "Secret", url: "https://secret.example.com" },
    ];
    const detachedTabs = [];
    extWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (!msg.id) return;
      if (msg.method === "ufoo.listTabs") {
        extWs.send(JSON.stringify({ id: msg.id, result: chromeTabs }));
      } else if (msg.method === "chrome.debugger.attach") {
        extWs.send(JSON.stringify({ id: msg.id, result: {} }));
      } else if (msg.method === "chrome.debugger.detach") {
        detachedTabs.push(msg.params[0].tabId);
        extWs.send(JSON.stringify({ id: msg.id, result: {} }));
      } else if (msg.method === "chrome.debugger.sendCommand") {
        const [target, cdpMethod] = msg.params;
        if (cdpMethod === "Target.getTargetInfo") {
          extWs.send(JSON.stringify({ id: msg.id, result: { targetInfo: { targetId: `target-${target.tabId}`, type: "page", url: "https://app.example.com" } } }));
        } else {
          extWs.send(JSON.stringify({ id: msg.id, result: { echo: cdpMethod, tabId: target.tabId } }));
        }
      }
    });

    extWs.send(JSON.stringify({
      method: "extension.initialized",
      params: { extensionId: DEV_EXTENSION_ID, extensionVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION, tabs: chromeTabs },
    }));
    await new Promise((r) => setTimeout(r, 40));

    // list_tabs filters out chrome:// and incognito tabs.
    const listed = await requestBroker("list_tabs", {}, { env: process.env });
    expect(listed.tabs.map((t) => t.tabId)).toEqual([101, 102]);

    const regA = await requestBroker("register_session", { sessionId: "agent-a", projectName: "alpha", agentName: "main" }, { env: process.env });
    const regB = await requestBroker("register_session", { sessionId: "agent-b", projectName: "beta", agentName: "ucode" }, { env: process.env });

    const cdpA = await connectWs(regA.wsEndpoint, { headers: { Authorization: `Bearer ${regA.sessionToken}` } });
    const cdpB = await connectWs(regB.wsEndpoint, { headers: { Authorization: `Bearer ${regB.sessionToken}` } });
    const eventsA = [];
    const eventsB = [];
    cdpA.on("message", (d) => eventsA.push(JSON.parse(d.toString("utf8"))));
    cdpB.on("message", (d) => eventsB.push(JSON.parse(d.toString("utf8"))));

    cdpA.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    cdpB.send(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
    await new Promise((r) => setTimeout(r, 30));

    // Agent A claims 101; Agent B cannot steal 101, gets browser_tab_busy, and claims 102 instead.
    expect(await requestBroker("claim_tab", { sessionId: "agent-a", tabId: 101 }, { env: process.env })).toMatchObject({ ok: true, tabId: 101 });
    expect(await requestBroker("claim_tab", { sessionId: "agent-b", tabId: 101 }, { env: process.env })).toMatchObject({
      ok: false,
      code: "browser_tab_busy",
      owner: { projectName: "alpha", agentName: "main" },
    });
    expect(await requestBroker("claim_tab", { sessionId: "agent-b", tabId: 102 }, { env: process.env })).toMatchObject({ ok: true, tabId: 102 });
    await new Promise((r) => setTimeout(r, 40));

    // Each session's CDP relay only received Target.attachedToTarget for its own tab.
    expect(eventsA.filter((e) => e.method === "Target.attachedToTarget").map((e) => e.params.targetInfo.targetId)).toEqual(["target-101"]);
    expect(eventsB.filter((e) => e.method === "Target.attachedToTarget").map((e) => e.params.targetInfo.targetId)).toEqual(["target-102"]);

    // User releases tab 101 in extension -> Agent A receives Target.detachedFromTarget and cannot auto-reclaim.
    extWs.send(JSON.stringify({ method: "extension.release_tab", params: { tabId: 101 } }));
    await new Promise((r) => setTimeout(r, 40));
    expect(detachedTabs).toContain(101);
    expect(eventsA.some((e) => e.method === "Target.detachedFromTarget")).toBe(true);
    expect((await requestBroker("session_tab_status", { sessionId: "agent-a" }, { env: process.env })).releasedSinceLastClaim).toBe(true);

    // User pauses all -> Agent B is disconnected and invalidated.
    extWs.send(JSON.stringify({ method: "extension.pause_all", params: {} }));
    await new Promise((r) => setTimeout(r, 40));
    expect((await requestBroker("status", {}, { env: process.env })).paused).toBe(true);
    expect(await requestBroker("claim_tab", { sessionId: "agent-b", tabId: 102 }, { env: process.env })).toMatchObject({
      ok: false,
      code: "browser_reconnect_required",
    });

    cdpA.close();
    cdpB.close();
    extWs.close();
  });

  test("host-controlled browser sessions return browser_disabled/not_installed without loading optional deps, then work once enabled", async () => {
    saveGlobalBrowserConfig({ enabled: false, setupChoice: "skip", backend: "ufoo-extension" });
    const createConnection = jest.fn();
    const sessions = createBrowserSessions({
      env: process.env,
      hostControlled: true,
      createConnection,
    });
    const ctx = { workspaceRoot: tmpRoot, sessionId: "s-host" };

    // status stays non-failing and informative while connect/tools/call fail cleanly without spawning MCP.
    expect(await sessions.execute({ operation: "status" }, ctx)).toMatchObject({
      ok: true,
      state: "disconnected",
      enabled: false,
      availability: "not_installed",
    });
    expect(await sessions.execute({ operation: "connect" }, ctx)).toMatchObject({ ok: false, code: "browser_disabled" });
    expect(await sessions.execute({ operation: "tools" }, ctx)).toMatchObject({ ok: false, code: "browser_disabled" });
    expect(createConnection).not.toHaveBeenCalled();

    // Enabled without installed runtime returns not_installed.
    saveGlobalBrowserConfig({ enabled: true, setupChoice: "install", backend: "ufoo-extension" });
    expect(await sessions.execute({ operation: "connect" }, ctx)).toMatchObject({ ok: false, code: "not_installed" });
    expect(createConnection).not.toHaveBeenCalled();

    // Install optional runtime and verify status reflects pending_browser_install cleanly.
    const src = path.join(tmpRoot, "src-runtime");
    makeFakeComponentSource(src, "0.0.85");
    await installBrowserRuntime({ env: process.env, sourceDir: src });
    expect(await sessions.execute({ operation: "status" }, ctx)).toMatchObject({
      ok: true,
      enabled: true,
      runtimeInstalled: true,
      availability: "pending_browser_install",
    });
    await sessions.closeAll();
  });
});

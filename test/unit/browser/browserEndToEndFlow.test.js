"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocket } = require("ws");
const { BrowserBroker } = require("../../../src/runtime/browser/broker");
const { createBrowserSessions } = require("../../../src/runtime/browser/playwrightSession");
const { saveGlobalBrowserConfig } = require("../../../src/config");
const { installBrowserRuntime } = require("../../../src/runtime/browser/componentInstaller");
const { registerNativeHost } = require("../../../src/runtime/browser/nativeHost");
const { nativeHostLauncherPath } = require("../../../src/runtime/browser/paths");
const {
  DEV_EXTENSION_ID,
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
  });
}

describe("ufoo Browser end-to-end CLI, native host binary, and Playwright MCP relay", () => {
  let tmpRoot;
  let browserHome;
  let nativeHostDir;
  let chromeUserData;
  let globalCfgFile;
  let broker;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-browser-e2e-"));
    browserHome = path.join(tmpRoot, "browser-home");
    nativeHostDir = path.join(tmpRoot, "native-hosts");
    chromeUserData = path.join(tmpRoot, "chrome-profile-root");
    globalCfgFile = path.join(tmpRoot, "global-config.json");
    fs.mkdirSync(path.join(chromeUserData, "Default"), { recursive: true });
  });

  afterEach(async () => {
    if (broker) await broker.stop();
    broker = null;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function childEnv(extra = {}) {
    return {
      ...process.env,
      UFOO_BROWSER_HOME: browserHome,
      UFOO_BROWSER_NATIVE_HOST_DIRS: nativeHostDir,
      UFOO_BROWSER_CHROME_USER_DATA_DIR: chromeUserData,
      UFOO_BROWSER_PLATFORM: "darwin",
      UFOO_GLOBAL_CONFIG_PATH: globalCfgFile,
      ...extra,
    };
  }

  test("CLI setup, browser status/install/disable/enable/uninstall work end-to-end", () => {
    const repoRoot = path.resolve(__dirname, "../../..");
    const ufooBin = path.join(repoRoot, "bin", "ufoo.js");
    const srcDir = path.join(tmpRoot, "fake-mcp");
    makeFakeComponentSource(srcDir, "0.0.85");

    const skipRun = spawnSync(process.execPath, [ufooBin, "setup", "--browser=skip", "--json"], {
      encoding: "utf8",
      env: childEnv(),
    });
    expect(skipRun.status).toBe(0);
    expect(JSON.parse(skipRun.stdout)).toMatchObject({ ok: true, choice: "skip", state: "not_installed" });

    const installRun = spawnSync(
      process.execPath,
      [ufooBin, "browser", "install", "--dev", "--no-open", "--source", srcDir, "--json"],
      { encoding: "utf8", env: childEnv() }
    );
    expect(installRun.status).toBe(0);
    expect(JSON.parse(installRun.stdout)).toMatchObject({ ok: true, state: "pending_browser_install" });

    const disableRun = spawnSync(process.execPath, [ufooBin, "browser", "disable", "--json"], {
      encoding: "utf8",
      env: childEnv(),
    });
    expect(disableRun.status).toBe(0);
    expect(JSON.parse(disableRun.stdout).status.state).toBe("disabled");

    const enableRun = spawnSync(process.execPath, [ufooBin, "browser", "enable", "--json"], {
      encoding: "utf8",
      env: childEnv(),
    });
    expect(enableRun.status).toBe(0);
    expect(JSON.parse(enableRun.stdout).status.enabled).toBe(true);

    const uninstallRun = spawnSync(process.execPath, [ufooBin, "browser", "uninstall", "--json"], {
      encoding: "utf8",
      env: childEnv(),
    });
    expect(uninstallRun.status).toBe(0);
    expect(JSON.parse(uninstallRun.stdout)).toMatchObject({ ok: true, removedRuntime: true });
  });

  test("native host launcher exchanges 4-byte LE hello -> connect_info and real Playwright MCP attaches via broker relay", async () => {
    const env = childEnv();
    const realMcpCli = path.join(path.dirname(require.resolve("@playwright/mcp/package.json")), "cli.js");
    const realMcpRoot = path.resolve(path.dirname(realMcpCli), "../../..");

    // Install real pinned @playwright/mcp into ~/.ufoo/browser/runtime/ using the repo's node_modules as source,
    // or link via UFOO_BROWSER_MCP_CLI after installing a lightweight component dir.
    const fakeSrc = path.join(tmpRoot, "src-mcp");
    makeFakeComponentSource(fakeSrc, "0.0.85");
    // Temporarily point process.env for saveGlobalBrowserConfig
    const prevGlobal = process.env.UFOO_GLOBAL_CONFIG_PATH;
    process.env.UFOO_GLOBAL_CONFIG_PATH = globalCfgFile;
    try {
      saveGlobalBrowserConfig({ enabled: true, setupChoice: "install", backend: "ufoo-extension" });
    } finally {
      if (prevGlobal === undefined) delete process.env.UFOO_GLOBAL_CONFIG_PATH;
      else process.env.UFOO_GLOBAL_CONFIG_PATH = prevGlobal;
    }

    await installBrowserRuntime({ env, sourceDir: fakeSrc, mode: "dev" });
    registerNativeHost({ env, mode: "dev" });

    broker = new BrowserBroker({ env });
    await broker.start();

    // 1. Spawn the actual native-host launcher script and complete a Native Messaging handshake.
    const launcher = nativeHostLauncherPath(env);
    const nativeReply = await new Promise((resolve, reject) => {
      const child = spawn(launcher, [], { env, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Native host timed out"));
      }, 5000);
      const push = createNativeMessageReader((msg) => {
        clearTimeout(timer);
        child.kill();
        resolve(msg);
      }, reject);
      child.stdout.on("data", push);
      child.on("error", reject);
      child.stdin.write(encodeNativeMessage({
        type: "hello",
        id: 42,
        extensionId: DEV_EXTENSION_ID,
        extensionVersion: "0.1.0",
        protocolVersion: PROTOCOL_VERSION,
      }));
    });
    expect(nativeReply).toMatchObject({ type: "connect_info", id: 42, protocolVersion: PROTOCOL_VERSION });
    expect(nativeReply.wsUrl).toContain("/extension?token=");

    // 2. Connect extension WS using the Native Messaging-issued wsUrl + token.
    const extWs = await connectWs(nativeReply.wsUrl, {
      headers: { Origin: `chrome-extension://${DEV_EXTENSION_ID}` },
    });
    const tabs = [
      { id: 77, windowId: 1, active: true, incognito: false, title: "Logged-in Portal", url: "https://portal.example.com" },
      { id: 78, windowId: 1, active: false, incognito: false, title: "Second Tab", url: "https://docs.example.com" },
    ];
    let nextNewTabId = 90;
    extWs.on("message", (raw) => {
      const msg = JSON.parse(raw.toString("utf8"));
      if (!msg.id) return;
      if (msg.method === "ufoo.listTabs") {
        extWs.send(JSON.stringify({ id: msg.id, result: tabs }));
      } else if (msg.method === "chrome.tabs.create") {
        const created = { id: nextNewTabId++, windowId: 1, active: true, incognito: false, title: "New App", url: msg.params?.[0]?.url || "http://localhost:5173/" };
        tabs.push(created);
        extWs.send(JSON.stringify({ id: msg.id, result: created }));
      } else if (msg.method === "chrome.debugger.attach" || msg.method === "chrome.debugger.detach") {
        extWs.send(JSON.stringify({ id: msg.id, result: {} }));
      } else if (msg.method === "chrome.debugger.sendCommand") {
        const [target, method, params] = msg.params;
        if (method === "Target.getTargetInfo") {
          extWs.send(JSON.stringify({ id: msg.id, result: { targetInfo: { targetId: `t-${target.tabId}`, browserContextId: "ctx-1", type: "page", url: "https://portal.example.com", title: "Logged-in Portal" } } }));
        } else if (method === "Target.setAutoAttach" || method === "Page.enable" || method === "DOM.enable") {
          extWs.send(JSON.stringify({ id: msg.id, result: {} }));
        } else if (method === "Page.createIsolatedWorld") {
          // Playwright has installed frame listeners when it requests this world.
          // Sending the main context earlier races the asynchronous frame-tree reply
          // through the broker and can lose the context forever in this fake Chrome.
          extWs.send(JSON.stringify({
            method: "chrome.debugger.onEvent",
            params: [{ tabId: target.tabId }, "Runtime.executionContextCreated", {
              context: { id: 1, origin: "http://localhost:5173", name: "", auxData: { isDefault: true, frameId: `t-${target.tabId}`, type: "default" } },
            }],
          }));
          extWs.send(JSON.stringify({
            method: "chrome.debugger.onEvent",
            params: [{ tabId: target.tabId }, "Runtime.executionContextCreated", {
              context: { id: 2, origin: "http://localhost:5173", name: params?.worldName || "__playwright_utility_world__", auxData: { isDefault: false, frameId: `t-${target.tabId}`, type: "isolated" } },
            }],
          }));
          extWs.send(JSON.stringify({ id: msg.id, result: { executionContextId: 2 } }));
        } else if (method === "Runtime.enable") {
          extWs.send(JSON.stringify({ id: msg.id, result: {} }));
        } else if (method === "Page.getFrameTree") {
          extWs.send(JSON.stringify({ id: msg.id, result: { frameTree: { frame: { id: `t-${target.tabId}`, loaderId: "loader-1", mimeType: "text/html", securityOrigin: "http://localhost:5173", url: "https://portal.example.com" } } } }));
        } else if (method === "Runtime.evaluate") {
          extWs.send(JSON.stringify({ id: msg.id, result: { result: { type: "object", objectId: `utility-${target.tabId}` } } }));
        } else if (method === "Runtime.callFunctionOn") {
          // Playwright's utility script receives the expression as an argument
          // and returns its own serialized value inside the CDP RemoteObject.
          const isEval = JSON.stringify(params?.arguments || []).includes("1 + 1");
          const value = isEval
            ? { o: [{ k: "result", v: 2 }, { k: "isFunction", v: true }] }
            : "Logged-in Portal";
          extWs.send(JSON.stringify({ id: msg.id, result: { result: { type: "object", value } } }));
        } else {
          extWs.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      }
    });
    extWs.send(JSON.stringify({
      method: "extension.initialized",
      params: { extensionId: DEV_EXTENSION_ID, extensionVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION, tabs },
    }));
    await new Promise((r) => setTimeout(r, 40));

    // 3. Drive createBrowserSessions with hostControlled=true and real @playwright/mcp CLI!
    expect(fs.existsSync(realMcpRoot)).toBe(true);
    const sessions = createBrowserSessions({
      env: { ...env, UFOO_BROWSER_MCP_CLI: realMcpCli },
      hostControlled: true,
      loadBrowserConfig: () => ({ enabled: true, setupChoice: "install", backend: "ufoo-extension", schemaVersion: 1 }),
    });
    const ctxA = { workspaceRoot: tmpRoot, sessionId: "session-a", projectName: "projA", agentName: "main" };
    const ctxB = { workspaceRoot: tmpRoot, sessionId: "session-b", projectName: "projB", agentName: "ucode" };

    try {
      const listRes = await sessions.execute({ operation: "connect" }, ctxA);
      expect(listRes.ok).toBe(true);
      expect(listRes.text).toContain("tabId=77");

      // Claim tab 77 for Agent A; Agent B gets browser_tab_busy without preemption!
      const selA = await sessions.execute({ operation: "call", tool: "browser_tabs", arguments: { action: "select", tabId: 77 } }, ctxA);
      expect(selA).toMatchObject({ ok: true, tabId: 77 });

      const selB = await sessions.execute({ operation: "call", tool: "browser_tabs", arguments: { action: "select", tabId: 77 } }, ctxB);
      expect(selB).toMatchObject({ ok: false, code: "browser_tab_busy", owner: { projectName: "projA", agentName: "main" } });

      // Regression: tools -> new -> tools -> select -> real CDP tool call must retain sessionToken and tab ownership.
      const ctxC = { workspaceRoot: tmpRoot, sessionId: "session-c", projectName: "projC", agentName: "ucode" };

      expect((await sessions.execute({ operation: "tools" }, ctxC)).ok).toBe(true);
      const createdTab = await sessions.execute({ operation: "call", tool: "browser_tabs", arguments: { action: "new", url: "http://localhost:5173" } }, ctxC);
      expect(createdTab).toMatchObject({ ok: true, tabId: 90 });
      expect((await sessions.execute({ operation: "tools", tool: "browser_evaluate" }, ctxC)).ok).toBe(true);
      expect((await sessions.execute({ operation: "call", tool: "browser_tabs", arguments: { action: "select", tabId: 90 } }, ctxC))).toMatchObject({ ok: true, tabId: 90 });
      const evalRes = await sessions.execute({ operation: "call", tool: "browser_evaluate", arguments: { function: "() => 1 + 1" } }, ctxC);
      expect(evalRes).toMatchObject({ ok: true });
      expect(evalRes.text).toContain("### Result\n2");
    } finally {
      await sessions.closeAll();
      extWs.close();
    }
  }, 20000);
});

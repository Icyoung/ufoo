"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  LAUNCHD_LABEL,
  resolveLaunchdDomain,
  resolveLaunchdPlistPath,
  buildLaunchdPlistXml,
  parseLaunchctlPrintOutput,
  getLaunchdServiceStatus,
  installLaunchdService,
  uninstallLaunchdService,
  restartLaunchdService,
} = require("../../../src/runtime/daemon/launchdService");

describe("launchdService", () => {
  test("builds valid macOS LaunchAgent plist XML with foreground global daemon env", () => {
    const xml = buildLaunchdPlistXml({
      homeDir: "/Users/alice",
      controllerRoot: "/Users/alice/.ufoo-controller",
      nodeExecutable: "/opt/homebrew/bin/node",
      cliEntrypoint: "/Users/alice/Code/ufoo/bin/ufoo.js",
      logPath: "/Users/alice/.ufoo-controller/.ufoo/run/ufoo-daemon-launchd.log",
      envPath: "/custom/bin:/usr/bin",
    });

    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/Users/alice/Code/ufoo/bin/ufoo.js</string>");
    expect(xml).toContain("<string>daemon</string>");
    expect(xml).toContain("<string>start</string>");
    expect(xml).toContain("<key>UFOO_DAEMON_CHILD</key>\n    <string>1</string>");
    expect(xml).toContain("<key>UFOO_DAEMON_TOPOLOGY</key>\n    <string>global</string>");
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain("<key>ThrottleInterval</key>\n  <integer>3</integer>");
    expect(xml).toContain("/opt/homebrew/bin");
    expect(xml).toContain("/custom/bin");
  });

  test("parses launchctl print output for running and waiting states", () => {
    const running = parseLaunchctlPrintOutput(`
      gui/501/dev.ufoo.daemon = {
        state = running
        pid = 42190
        last exit code = 0
      }
    `);
    expect(running).toEqual({
      state: "running",
      pid: 42190,
      running: true,
      lastExitCode: "0",
    });

    const waiting = parseLaunchctlPrintOutput(`
      gui/501/dev.ufoo.daemon = {
        state = waiting
        last exit code = 1
      }
    `);
    expect(waiting).toEqual({
      state: "waiting",
      pid: null,
      running: false,
      lastExitCode: "1",
    });
  });

  test("installs, inspects, restarts, and uninstalls LaunchAgent hermetically", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-launchd-test-"));
    try {
      const homeDir = path.join(tmp, "home");
      const controllerRoot = path.join(tmp, "controller");
      const plistPath = resolveLaunchdPlistPath({ homeDir });
      let loaded = false;
      let pid = 7771;
      const calls = [];
      const spawnSyncImpl = jest.fn((bin, args) => {
        calls.push([bin, ...args]);
        if (args[0] === "print") {
          if (!loaded) return { status: 113, stdout: "", stderr: "Could not find service" };
          return { status: 0, stdout: `state = running\npid = ${pid}\n`, stderr: "" };
        }
        if (args[0] === "bootstrap") {
          loaded = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "bootout") {
          loaded = false;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "kickstart") {
          pid += 1;
          return { status: 0, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      });
      const stopDaemon = jest.fn(() => true);
      const isRunning = jest.fn(() => true);

      const before = getLaunchdServiceStatus({
        platform: "darwin",
        uid: 501,
        homeDir,
        controllerRoot,
        spawnSyncImpl,
      });
      expect(before).toMatchObject({
        supported: true,
        installed: false,
        loaded: false,
        state: "not_installed",
      });

      const installed = installLaunchdService({
        platform: "darwin",
        uid: 501,
        homeDir,
        controllerRoot,
        spawnSyncImpl,
        isRunning,
        stopDaemon,
      });
      expect(installed).toMatchObject({
        ok: true,
        installed: true,
        loaded: true,
        running: true,
        pid: 7772,
      });
      expect(fs.existsSync(plistPath)).toBe(true);
      expect(stopDaemon).toHaveBeenCalledWith(controllerRoot, { source: "launchd-service:install" });
      expect(calls).toContainEqual(["launchctl", "bootstrap", resolveLaunchdDomain({ uid: 501 }), plistPath]);

      const restarted = restartLaunchdService({
        platform: "darwin",
        uid: 501,
        homeDir,
        controllerRoot,
        spawnSyncImpl,
      });
      expect(restarted).toMatchObject({ ok: true, pid: 7773, running: true });

      const removed = uninstallLaunchdService({
        platform: "darwin",
        uid: 501,
        homeDir,
        controllerRoot,
        spawnSyncImpl,
      });
      expect(removed).toMatchObject({
        ok: true,
        installed: false,
        loaded: false,
        running: false,
      });
      expect(fs.existsSync(plistPath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reports unsupported gracefully on non-macOS platforms", () => {
    const status = getLaunchdServiceStatus({ platform: "linux", homeDir: "/tmp/home" });
    expect(status.supported).toBe(false);
    expect(status.state).toBe("unsupported");
    const res = installLaunchdService({ platform: "linux", homeDir: "/tmp/home" });
    expect(res.ok).toBe(false);
  });
});

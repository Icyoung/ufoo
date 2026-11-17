"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadGlobalMacConfig,
  saveGlobalMacConfig,
  saveGlobalBrowserConfig,
  loadGlobalBrowserConfig,
} = require("../../../src/config");
const { macHelperSocketPath } = require("../../../src/runtime/mac/paths");
const { detectSwiftCompiler, ensureHelperCompiled } = require("../../../src/runtime/mac/helperCompiler");
const { ensureHelperDaemon, callHelperRpc, stopHelperDaemon } = require("../../../src/runtime/mac/helperClient");
const { runMacCommand } = require("../../../src/app/cli/macCommands");
const fmt = require("../../../src/ui/format");

describe("ufoo mac CLI, config, and native helper runtime", () => {
  let tmpDir;
  let prevGlobalCfg;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mac-cli-"));
    prevGlobalCfg = process.env.UFOO_GLOBAL_CONFIG_PATH;
    process.env.UFOO_GLOBAL_CONFIG_PATH = path.join(tmpDir, "config.json");
  });

  afterEach(async () => {
    await stopHelperDaemon({ env: { ...process.env, UFOO_MAC_HOME: path.join(tmpDir, "mac") } }).catch(() => {});
    if (prevGlobalCfg === undefined) delete process.env.UFOO_GLOBAL_CONFIG_PATH;
    else process.env.UFOO_GLOBAL_CONFIG_PATH = prevGlobalCfg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("persists mac config atomically alongside existing browser settings", () => {
    expect(loadGlobalMacConfig()).toEqual({
      enabled: true,
      hud: true,
      takeoverGuard: true,
      schemaVersion: 1,
    });
    saveGlobalBrowserConfig({ enabled: true, setupChoice: "install" });
    saveGlobalMacConfig({ enabled: false, hud: false });

    expect(loadGlobalMacConfig()).toMatchObject({
      enabled: false,
      hud: false,
      takeoverGuard: true,
    });
    expect(loadGlobalBrowserConfig()).toMatchObject({
      enabled: true,
      setupChoice: "install",
    });
  });

  test("keeps Unix domain socket path well within Darwin 104-byte sun_path limit", () => {
    const deepHome = path.join(tmpDir, "very-long-nested-directory-name-1", "very-long-nested-directory-name-2", "mac-runtime-home");
    const sock = macHelperSocketPath({ UFOO_MAC_HOME: deepHome });
    expect(Buffer.byteLength(sock)).toBeLessThanOrEqual(96);
  });

  test("ufoo mac CLI supports status, disable, enable, hud toggle, and stop", async () => {
    const env = { ...process.env, UFOO_MAC_HOME: path.join(tmpDir, "mac") };
    const run = async (sub, args = [], platform = "linux") => {
      const out = [];
      const code = await runMacCommand(sub, args, { json: true }, {
        env,
        platform,
        write: (line) => out.push(line),
        writeError: (line) => out.push(line),
      });
      return { code, json: JSON.parse(out.join("\n")) };
    };

    const linuxStatus = await run("status", [], "linux");
    expect(linuxStatus.code).toBe(0);
    expect(linuxStatus.json).toMatchObject({ state: "unsupported_platform", platformSupported: false });

    const disabled = await run("disable", [], "linux");
    expect(disabled.code).toBe(0);
    expect(loadGlobalMacConfig().enabled).toBe(false);

    const enabled = await run("enable", [], "linux");
    expect(enabled.code).toBe(0);
    expect(loadGlobalMacConfig().enabled).toBe(true);

    const hudOff = await run("hud", ["off"], "linux");
    expect(hudOff.json).toEqual({ ok: true, hud: false });
    const hudToggle = await run("hud", ["toggle"], "linux");
    expect(hudToggle.json).toEqual({ ok: true, hud: true });

    const stopped = await run("stop", [], "linux");
    expect(stopped.code).toBe(0);
    expect(stopped.json.ok).toBe(true);
  });

  test("formats mac_app tool calls cleanly for TUI rows", () => {
    expect(fmt.TOOL_LABELS.mac_app).toBe("Operating Mac app");
    const row = fmt.buildUcodeToolRowText([{
      tool: "mac_app",
      detail: "click · @e4",
      isError: false,
    }]);
    expect(row).toContain("Mac App click · @e4");
  });

  const isDarwinWithSwift = process.platform === "darwin" && detectSwiftCompiler().available;
  (isDarwinWithSwift ? test : test.skip)(
    "compiles native Swift helper and serves read-only daemon RPCs on macOS",
    async () => {
      const macEnv = { ...process.env, UFOO_MAC_HOME: path.join(tmpDir, "mac") };
      const compiled = await ensureHelperCompiled({ env: macEnv });
      expect(compiled.ok).toBe(true);
      expect(fs.existsSync(compiled.binaryPath)).toBe(true);

      const second = await ensureHelperCompiled({ env: macEnv });
      expect(second.compiled).toBe(false);
      expect(second.binaryPath).toBe(compiled.binaryPath);

      const daemon = await ensureHelperDaemon({ env: macEnv, idleMs: 15000 });
      expect(daemon.ok).toBe(true);

      const apps = await callHelperRpc("list_apps", {}, { env: macEnv, mutating: false });
      expect(apps.ok).toBe(true);
      expect(Array.isArray(apps.result.apps)).toBe(true);

      const wins = await callHelperRpc("list_windows", {}, { env: macEnv, mutating: false });
      expect(wins.ok).toBe(true);
      expect(Array.isArray(wins.result.windows)).toBe(true);

      const stopped = await stopHelperDaemon({ env: macEnv });
      expect(stopped.ok).toBe(true);
    },
    30000,
  );
});

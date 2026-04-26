const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  saveConfig,
  loadConfig,
  normalizeAgentProvider,
  normalizeControllerMode,
  normalizeCodexInternalThreadMode,
  normalizeCodexAuthPath,
  normalizeCodexOauthRefreshWindowSec,
  normalizeClaudeOauthProfile,
  normalizeClaudeOauthTokenPath,
  normalizeClaudeOauthRefreshWindowSec,
} = require("../../src/config");

describe("config save/load", () => {
  test("saveConfig preserves existing fields on partial updates", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    saveConfig(projectRoot, { launchMode: "internal" });
    saveConfig(projectRoot, { agentModel: "gpt-5.4" });

    const loaded = loadConfig(projectRoot);
    expect(loaded.launchMode).toBe("internal");
    expect(loaded.agentModel).toBe("gpt-5.4");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("saveConfig preserves host launch mode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-host-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    saveConfig(projectRoot, { launchMode: "host" });

    const loaded = loadConfig(projectRoot);
    expect(loaded.launchMode).toBe("host");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("saveConfig/loadConfig normalizes controllerMode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-controller-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    saveConfig(projectRoot, { controllerMode: "main" });
    expect(loadConfig(projectRoot).controllerMode).toBe("main");

    saveConfig(projectRoot, { controllerMode: "router-api" });
    expect(loadConfig(projectRoot).controllerMode).toBe("main");

    saveConfig(projectRoot, { controllerMode: "invalid-mode" });
    expect(loadConfig(projectRoot).controllerMode).toBe("legacy");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("normalizeAgentProvider only allows codex and claude engines", () => {
    expect(normalizeAgentProvider("codex-cli")).toBe("codex-cli");
    expect(normalizeAgentProvider("claude-cli")).toBe("claude-cli");
    expect(normalizeAgentProvider("ucode")).toBe("codex-cli");
    expect(normalizeAgentProvider("ufoo")).toBe("codex-cli");
    expect(normalizeAgentProvider("unknown")).toBe("codex-cli");
  });

  test("normalizeControllerMode supports all phase flags", () => {
    expect(normalizeControllerMode("legacy")).toBe("legacy");
    expect(normalizeControllerMode("shadow")).toBe("shadow");
    expect(normalizeControllerMode("main")).toBe("main");
    expect(normalizeControllerMode("router-api")).toBe("main");
    expect(normalizeControllerMode("loop")).toBe("loop");
    expect(normalizeControllerMode("unknown")).toBe("legacy");
  });

  test("loadConfig defaults controllerMode to main when config is absent", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-default-main-"));
    expect(loadConfig(projectRoot).controllerMode).toBe("main");
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("saveConfig/loadConfig normalizes codexInternalThreadMode", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-codex-thread-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    expect(loadConfig(projectRoot).codexInternalThreadMode).toBe("api");

    saveConfig(projectRoot, { codexInternalThreadMode: "sdk" });
    expect(loadConfig(projectRoot).codexInternalThreadMode).toBe("api");

    saveConfig(projectRoot, { codexInternalThreadMode: "direct-api" });
    expect(loadConfig(projectRoot).codexInternalThreadMode).toBe("api");

    saveConfig(projectRoot, { codexInternalThreadMode: "invalid-mode" });
    expect(loadConfig(projectRoot).codexInternalThreadMode).toBe("legacy");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("normalizeCodexInternalThreadMode supports direct API aliases", () => {
    expect(normalizeCodexInternalThreadMode("legacy")).toBe("legacy");
    expect(normalizeCodexInternalThreadMode("sdk")).toBe("api");
    expect(normalizeCodexInternalThreadMode("api")).toBe("api");
    expect(normalizeCodexInternalThreadMode("direct")).toBe("api");
    expect(normalizeCodexInternalThreadMode("unknown")).toBe("legacy");
  });

  test("saveConfig/loadConfig normalizes codex auth path", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-codex-auth-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    saveConfig(projectRoot, { codexAuthPath: " /tmp/codex-auth.json " });
    expect(loadConfig(projectRoot).codexAuthPath).toBe("/tmp/codex-auth.json");

    expect(normalizeCodexAuthPath(" /tmp/codex-auth.json ")).toBe("/tmp/codex-auth.json");
    expect(normalizeCodexAuthPath(undefined)).toBe("");
    expect(normalizeCodexOauthRefreshWindowSec("90")).toBe(90);
    expect(normalizeCodexOauthRefreshWindowSec("bad")).toBe(300);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("saveConfig/loadConfig normalizes claude oauth reader settings", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-config-claude-oauth-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo"), { recursive: true });

    saveConfig(projectRoot, {
      claudeOauthProfile: " work ",
      claudeOauthTokenPath: " /tmp/claude-oauth.json ",
      claudeOauthRefreshWindowSec: "90",
    });

    expect(loadConfig(projectRoot)).toMatchObject({
      claudeOauthProfile: "work",
      claudeOauthTokenPath: "/tmp/claude-oauth.json",
      claudeOauthRefreshWindowSec: 90,
    });

    saveConfig(projectRoot, { claudeOauthRefreshWindowSec: -1 });
    expect(loadConfig(projectRoot).claudeOauthRefreshWindowSec).toBe(300);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("normalizeClaudeOauth helpers handle invalid values", () => {
    expect(normalizeClaudeOauthProfile(" team ")).toBe("team");
    expect(normalizeClaudeOauthProfile(null)).toBe("");
    expect(normalizeClaudeOauthTokenPath(" /tmp/oauth.json ")).toBe("/tmp/oauth.json");
    expect(normalizeClaudeOauthTokenPath(undefined)).toBe("");
    expect(normalizeClaudeOauthRefreshWindowSec("45")).toBe(45);
    expect(normalizeClaudeOauthRefreshWindowSec("bad")).toBe(300);
  });
});

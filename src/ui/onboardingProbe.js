"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { writeFileAtomic } = require("../coordination/bus/utils");
const { loadConfig } = require("../config");
const {
  inspectCodexDirectAuth,
  inspectClaudeDirectAuth,
  inspectAgyDirectAuth,
  inspectKimiDirectAuth,
  inspectGrokDirectAuth,
} = require("../agents/providers/directAuthStatus");
const {
  detectInstalledAcpAgents,
  isCommandExecutable,
} = require("../agents/providers/acpRegistry");
const { resolveAgyBinary } = require("../agents/providers/agyThreadProvider");
const {
  inspectCodexMcpConfig,
  configureCodexMcp,
} = require("../runtime/daemon/mcpConfigure");
const { computeBrowserSetupStatus } = require("../runtime/browser/installState");
const { getCliBinDir } = require("./cliHandoff");

const ALLOWLISTED_LOGIN_COMMANDS = Object.freeze({
  claude: "claude auth login",
  "claude-cli": "claude auth login",
  codex: "codex login",
  "codex-cli": "codex login",
  agy: "agy acp --login",
  "agy-cli": "agy acp --login",
  kimi: "kimi",
  "acp:kimi": "kimi",
  grok: "grok",
  "acp:grok": "grok",
  gemini: "gemini",
  "acp:gemini": "gemini",
  opencode: "opencode",
  "acp:opencode": "opencode",
});

function onboardingFilePath(controllerRoot) {
  return path.join(controllerRoot, ".ufoo", "ui", "onboarding.json");
}

function readOnboardingState(controllerRoot) {
  const file = onboardingFilePath(controllerRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      completed: Boolean(parsed && parsed.completed),
      skipped: Boolean(parsed && parsed.skipped),
      completedAt: String(parsed?.completedAt || ""),
    };
  } catch {
    return { completed: false, skipped: false, completedAt: "" };
  }
}

function saveOnboardingState(controllerRoot, patch = {}) {
  const file = onboardingFilePath(controllerRoot);
  const current = readOnboardingState(controllerRoot);
  const next = {
    ...current,
    ...patch,
    completed: patch.completed !== undefined ? Boolean(patch.completed) : true,
    completedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

async function safeInspect(fn, fallback = { ok: false, error: "unavailable" }) {
  try {
    return (await fn()) || fallback;
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function probePrimaryProviders({ projectRoot, config, isExecutable = isCommandExecutable } = {}) {
  const codexBin = Boolean(isExecutable("codex"));
  const claudeBin = Boolean(isExecutable("claude"));
  const agyBin = Boolean(isExecutable("agy") || resolveAgyBinary({ isExecutable }));

  const [codexAuth, claudeAuth, agyAuth] = await Promise.all([
    safeInspect(() => inspectCodexDirectAuth({ projectRoot, loadConfigImpl: () => config })),
    safeInspect(() => inspectClaudeDirectAuth({ projectRoot, loadConfigImpl: () => config })),
    safeInspect(() => inspectAgyDirectAuth({ projectRoot, loadConfigImpl: () => config })),
  ]);

  const codexReady = Boolean(codexAuth.ok);
  const claudeReady = Boolean(claudeAuth.ok);
  const agyReady = Boolean(agyAuth.ok);

  const primary = [
    {
      id: "claude-cli",
      workerId: "claude",
      label: "Claude Code",
      kind: "sdk",
      installed: claudeBin || claudeReady,
      authenticated: claudeReady,
      status: claudeReady ? "ready" : (claudeBin ? "needs_auth" : "not_installed"),
      detail: claudeReady
        ? (claudeAuth.account || claudeAuth.source || "Signed in")
        : (claudeBin ? "Installed · run `claude auth login` to sign in" : "CLI not detected in PATH"),
      loginCommand: "claude auth login",
      installHint: "npm install -g @anthropic-ai/claude-code",
    },
    {
      id: "codex-cli",
      workerId: "codex",
      label: "Codex",
      kind: "sdk",
      installed: codexBin || codexReady,
      authenticated: codexReady,
      status: codexReady ? "ready" : (codexBin ? "needs_auth" : "not_installed"),
      detail: codexReady
        ? (codexAuth.account || codexAuth.source || "Signed in")
        : (codexBin ? "Installed · run `codex login` to sign in" : "CLI not detected in PATH"),
      loginCommand: "codex login",
      installHint: "npm install -g @openai/codex",
    },
    {
      id: "agy-cli",
      workerId: "agy",
      label: "Antigravity (agy)",
      kind: "native",
      installed: agyReady || agyBin,
      authenticated: agyReady,
      status: agyReady ? "ready" : (agyBin ? "needs_auth" : "not_installed"),
      detail: agyReady
        ? (agyAuth.account || "Signed in (local Antigravity credentials)")
        : "Sign in via `agy`",
      loginCommand: "agy acp --login",
      installHint: "",
    },
  ];

  return primary;
}

async function probeAcpProviders({ projectRoot, config, isExecutable = isCommandExecutable } = {}) {
  const [kimiAuth, grokAuth] = await Promise.all([
    safeInspect(() => inspectKimiDirectAuth({ projectRoot, loadConfigImpl: () => config })),
    safeInspect(() => inspectGrokDirectAuth({ projectRoot, loadConfigImpl: () => config })),
  ]);

  return detectInstalledAcpAgents(projectRoot, { config, isExecutable }).map((entry) => {
    let authenticated = Boolean(entry.available);
    let authDetail = entry.available ? `Ready (${entry.command})` : "Not installed in PATH";
    if (entry.id === "kimi") {
      authenticated = Boolean(kimiAuth.ok);
      authDetail = entry.available
        ? (authenticated ? "Installed & authenticated" : "Installed · run `kimi` to sign in")
        : "Not installed in PATH";
    } else if (entry.id === "grok") {
      authenticated = Boolean(grokAuth.ok);
      authDetail = entry.available
        ? (authenticated ? "Installed & authenticated" : "Installed · set XAI_API_KEY or run `grok`")
        : "Not installed in PATH";
    }
    return {
      id: entry.agentType,
      acpId: entry.id,
      label: entry.label,
      kind: "acp",
      command: entry.command,
      installed: Boolean(entry.available),
      authenticated,
      status: !entry.available ? "not_installed" : (authenticated ? "ready" : "needs_auth"),
      detail: authDetail,
      loginCommand: ALLOWLISTED_LOGIN_COMMANDS[entry.agentType] || "",
    };
  });
}

async function probeOnboardingState({
  controllerRoot,
  projectRoot = "",
  existingProjectsCount = 0,
  homedir = os.homedir(),
  isExecutable = isCommandExecutable,
} = {}) {
  const targetRoot = projectRoot || controllerRoot;
  let config = {};
  try {
    config = loadConfig(targetRoot) || {};
  } catch {
    config = {};
  }

  const persisted = readOnboardingState(controllerRoot);
  const [primaryEngines, acpEngines] = await Promise.all([
    probePrimaryProviders({ projectRoot: targetRoot, config, isExecutable }),
    probeAcpProviders({ projectRoot: targetRoot, config, isExecutable }),
  ]);

  const binDir = getCliBinDir(homedir);
  const cliInstalled = fs.existsSync(path.join(binDir, "ufoo")) && fs.existsSync(path.join(binDir, "ucode"));

  let codexMcp = { configured: false, changed: false, target: "" };
  try {
    codexMcp = inspectCodexMcpConfig({ projectRoot: controllerRoot });
  } catch {
    // ignore if daemon connection file isn't ready yet
  }

  let browserStatus = { state: "not_installed", enabled: false, runtimeInstalled: false };
  try {
    const raw = computeBrowserSetupStatus();
    browserStatus = {
      state: String(raw.state || "not_installed"),
      enabled: Boolean(raw.enabled),
      runtimeInstalled: Boolean(raw.runtimeInstalled),
      setupChoice: String(raw.setupChoice || "unset"),
    };
  } catch {
    // ignore
  }

  const recommendedProvider = primaryEngines.find((p) => p.status === "ready")?.id
    || config.agentProvider
    || "claude-cli";

  return {
    completed: persisted.completed,
    skipped: persisted.skipped,
    should_show: !persisted.completed && existingProjectsCount === 0,
    recommended_provider: recommendedProvider,
    current_provider: config.agentProvider || "codex-cli",
    primary_engines: primaryEngines,
    acp_engines: acpEngines,
    cli: {
      installed: cliInstalled,
      bin_dir: binDir,
      binaries: ["ufoo", "ucode"],
    },
    mcp: {
      codex_configured: Boolean(codexMcp.configured),
      codex_needs_update: Boolean(codexMcp.changed),
      codex_target: String(codexMcp.target || ""),
    },
    browser: browserStatus,
  };
}

function launchLoginInTerminal(engineId = "", options = {}) {
  const key = String(engineId || "").trim().toLowerCase();
  const cmd = ALLOWLISTED_LOGIN_COMMANDS[key];
  if (!cmd) {
    return { ok: false, error: `No terminal login command registered for "${engineId}"` };
  }
  if (options.dryRun) {
    return { ok: true, dryRun: true, command: cmd };
  }
  if (process.platform !== "darwin") {
    return { ok: false, command: cmd, error: `Run \`${cmd}\` in your terminal to sign in.` };
  }
  try {
    const escaped = cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "Terminal"
      activate
      do script "${escaped}"
    end tell`;
    const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true, command: cmd, terminal: "Terminal" };
  } catch (err) {
    return { ok: false, command: cmd, error: err && err.message ? err.message : String(err) };
  }
}

function configureExternalHostMcp(host = "codex", options = {}) {
  const normalized = String(host || "codex").trim().toLowerCase();
  if (normalized !== "codex") {
    return {
      ok: false,
      error: `Automatic HTTP MCP configuration is currently for Codex; other hosts use "ufoo mcp".`,
    };
  }
  try {
    const res = configureCodexMcp({
      projectRoot: options.controllerRoot || undefined,
    });
    return {
      ok: true,
      host: "codex",
      target: res.target,
      changed: Boolean(res.changed),
      endpoint: res.endpoint,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
    };
  }
}

module.exports = {
  ALLOWLISTED_LOGIN_COMMANDS,
  onboardingFilePath,
  readOnboardingState,
  saveOnboardingState,
  probeOnboardingState,
  launchLoginInTerminal,
  configureExternalHostMcp,
};

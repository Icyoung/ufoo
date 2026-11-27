"use strict";

/**
 * CLI <-> Desktop App bidirectional handoff, URL scheme (`ufoo://`),
 * local wakeup socket (`~/.ufoo/run/desktop-handoff.sock`), macOS terminal
 * launcher (`Continue in CLI`), and bundled CLI PATH shim installer.
 */

const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const AgentActivator = require("../coordination/bus/activate");
const { canonicalProjectRoot } = require("../runtime/projects/projectId");
const { resolveNodeExecutable } = require("../runtime/process/nodeExecutable");
const { requestActivate } = require("../runtime/terminal/adapters/hostAdapter");

const CLI_BINARIES = Object.freeze([
  "ufoo",
  "ucode",
]);

function getDesktopRunDir(homedir = os.homedir()) {
  return path.join(homedir, ".ufoo", "run");
}

function getDesktopHandoffSocketPath(homedir = os.homedir()) {
  return path.join(getDesktopRunDir(homedir), "desktop-handoff.sock");
}

function getCliBinDir(homedir = os.homedir()) {
  return path.join(homedir, ".ufoo", "bin");
}

function buildHandoffUrl({
  projectRoot = "",
  target = "main",
  windowMode = "",
  docPath = "",
} = {}) {
  const params = new URLSearchParams();
  if (projectRoot) {
    try {
      params.set("project", canonicalProjectRoot(projectRoot));
    } catch {
      params.set("project", path.resolve(projectRoot));
    }
  }
  if (target) params.set("target", String(target).trim());
  if (windowMode && ["main", "side", "multi"].includes(String(windowMode))) {
    params.set("window", String(windowMode));
  }
  if (docPath) params.set("doc", String(docPath).trim());
  const qs = params.toString();
  return `ufoo://open${qs ? `?${qs}` : ""}`;
}

function parseHandoffUrl(rawUrl = "") {
  const text = String(rawUrl || "").trim();
  if (!text.startsWith("ufoo://")) return null;
  try {
    const parsed = new URL(text);
    const projectRaw = parsed.searchParams.get("project") || "";
    let projectRoot = "";
    if (projectRaw) {
      try {
        projectRoot = canonicalProjectRoot(projectRaw);
      } catch {
        projectRoot = path.resolve(projectRaw);
      }
    }
    const target = parsed.searchParams.get("target") || "main";
    const windowRaw = parsed.searchParams.get("window") || "";
    const windowMode = ["main", "side", "multi"].includes(windowRaw) ? windowRaw : "";
    const docPath = parsed.searchParams.get("doc") || "";
    return {
      action: parsed.hostname || parsed.pathname.replace(/^\/+/, "") || "open",
      projectRoot,
      target,
      windowMode,
      docPath,
      raw: text,
    };
  } catch {
    return null;
  }
}

function createDesktopHandoffServer({
  socketPath = getDesktopHandoffSocketPath(),
  onHandoff = () => {},
} = {}) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.unlinkSync(socketPath);
  } catch {
    // ignore stale socket removal errors
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      try {
        const msg = JSON.parse(line);
        const parsed = msg.url ? parseHandoffUrl(msg.url) : msg;
        if (parsed) onHandoff(parsed);
        socket.end(`${JSON.stringify({ ok: true })}\n`);
      } catch (err) {
        socket.end(`${JSON.stringify({ ok: false, error: err.message })}\n`);
      }
    });
  });

  return {
    socketPath,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          try {
            fs.chmodSync(socketPath, 0o600);
          } catch {
            // ignore chmod issues on unsupported platforms
          }
          resolve(socketPath);
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          try {
            fs.unlinkSync(socketPath);
          } catch {
            // ignore
          }
          resolve();
        });
      });
    },
  };
}

function sendHandoffToRunningDesktop(handoffPayload, {
  socketPath = getDesktopHandoffSocketPath(),
  timeoutMs = 1200,
} = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) {
      resolve({ ok: false, reason: "no_socket" });
      return;
    }
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const client = net.createConnection(socketPath, () => {
      client.write(`${JSON.stringify(handoffPayload)}\n`);
    });
    let buf = "";
    const timer = setTimeout(() => {
      try { client.destroy(); } catch {}
      finish({ ok: false, reason: "timeout" });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.includes("\n")) {
        try {
          const parsed = JSON.parse(buf.trim().split("\n")[0]);
          finish({ ok: Boolean(parsed && parsed.ok), delivered: "socket" });
        } catch {
          finish({ ok: true, delivered: "socket" });
        }
        try { client.end(); } catch {}
      }
    });
    client.on("error", () => finish({ ok: false, reason: "connect_failed" }));
  });
}

function findInstalledMacAppCandidates(repoRoot = path.resolve(__dirname, "..", "..")) {
  const home = os.homedir();
  return [
    process.env.UFOO_DESKTOP_APP_PATH || "",
    "/Applications/Ufoo.app",
    path.join(home, "Applications", "Ufoo.app"),
    path.join(repoRoot, "target", "release", "bundle", "macos", "Ufoo.app"),
    path.join(repoRoot, "crates", "ufoo-desktop", "target", "release", "bundle", "macos", "Ufoo.app"),
  ].filter(Boolean);
}

async function openInDesktopApp(options = {}) {
  const url = buildHandoffUrl(options);
  const parsed = parseHandoffUrl(url);
  const direct = await sendHandoffToRunningDesktop({ url, ...parsed }, options);
  if (direct.ok) {
    if (process.platform === "darwin" && options.skipOsActivate !== true) {
      for (const appPath of findInstalledMacAppCandidates()) {
        if (fs.existsSync(appPath)) {
          spawnSync("open", ["-a", appPath], { stdio: "ignore" });
          break;
        }
      }
    }
    return { ok: true, method: "socket", url };
  }

  if (process.platform === "darwin" && options.skipOsOpen !== true) {
    for (const appPath of findInstalledMacAppCandidates()) {
      if (fs.existsSync(appPath)) {
        const res = spawnSync("open", ["-a", appPath, url], { encoding: "utf8" });
        if (res.status === 0) return { ok: true, method: "app_bundle", appPath, url };
      }
    }
    const schemeRes = spawnSync("open", [url], { encoding: "utf8" });
    if (schemeRes.status === 0) {
      return { ok: true, method: "url_scheme", url };
    }
  }

  return {
    ok: false,
    url,
    error: "Ufoo.app is not running or installed in /Applications yet.",
  };
}

function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function escapeAppleScriptString(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function buildCliCommandString({
  projectRoot,
  windowMode = "",
  agentId = "",
  repoRoot = path.resolve(__dirname, "..", ".."),
  ufooBin = "",
} = {}) {
  const root = canonicalProjectRoot(projectRoot || process.cwd());
  const binDir = getCliBinDir();
  const shimmedUfoo = path.join(binDir, "ufoo");
  let invocation = "";
  if (ufooBin) {
    invocation = shellQuote(ufooBin);
  } else if (fs.existsSync(shimmedUfoo)) {
    invocation = shellQuote(shimmedUfoo);
  } else {
    const nodeBin = resolveNodeExecutable();
    const scriptPath = path.join(repoRoot, "bin", "ufoo.js");
    invocation = `${shellQuote(nodeBin)} ${shellQuote(scriptPath)}`;
  }

  const args = ["chat", "--project", shellQuote(root)];
  if (agentId) {
    args.push("--agent", shellQuote(agentId));
  } else if (windowMode && ["main", "side", "multi"].includes(windowMode) && windowMode !== "main") {
    args.push("--window", shellQuote(windowMode));
  }
  return `cd ${shellQuote(root)} && ${invocation} ${args.join(" ")}`;
}

function detectPreferredMacTerminal(preferred = "") {
  const explicit = String(preferred || process.env.UFOO_TERMINAL || "").trim().toLowerCase();
  if (explicit) return explicit;
  const candidates = [
    { id: "iterm2", app: "/Applications/iTerm.app" },
    { id: "ghostty", app: "/Applications/Ghostty.app" },
    { id: "warp", app: "/Applications/Warp.app" },
    { id: "apple-terminal", app: "/System/Applications/Utilities/Terminal.app" },
  ];
  for (const item of candidates) {
    if (fs.existsSync(item.app)) return item.id;
  }
  return "apple-terminal";
}

function externalHostApp(meta) {
  const aliases = [
    [/^(iterm2?|iterm\.app)$/i, "iTerm"],
    [/^(terminal|apple_terminal|terminal\.app)$/i, "Terminal"],
    [/^cursor$/i, "Cursor"],
    [/^(code|vscode|visual studio code)$/i, "Visual Studio Code"],
    [/^ghostty$/i, "Ghostty"],
    [/^warp(terminal)?$/i, "Warp"],
    [/^(codex( app)?|chatgpt( desktop)?|com\.openai\.codex)$/i, "Codex"],
    [/^(agy|antigravity( app)?|google antigravity|com\.google\.antigravity)$/i, "Antigravity"],
  ];
  for (const hint of [meta.host_name, meta.hostName, meta.mcp_metadata?.host_name, meta.terminal_app, meta.terminal]) {
    const match = aliases.find(([pattern]) => pattern.test(String(hint || "").trim()));
    if (match) return match[1];
  }
  return "";
}

async function focusExternalAgentHost(projectRoot, meta = {}) {
  if (process.platform !== "darwin") {
    return { ok: false, error: "External terminal focus is currently supported on macOS" };
  }
  if (meta.launch_mode === "host" && !meta.mcp_bridge && meta.host_inject_sock) {
    try {
      await requestActivate(meta.host_inject_sock);
      return { ok: true, method: "session" };
    } catch {
      // Try a local window or application if the host session is unavailable.
    }
  }

  const appName = externalHostApp(meta);
  const tty = typeof meta.tty === "string" && /^\/dev\/tty[a-z\d]+$/i.test(meta.tty) ? meta.tty : "";
  const terminalApps = ["Terminal", "iTerm"].filter((name) => !appName || name === appName);
  if (tty && terminalApps.length) {
    const activator = new AgentActivator(projectRoot);
    for (const terminalApp of terminalApps) {
      try {
        activator.activateTerminalByTty(tty, terminalApp);
        return { ok: true, appName: terminalApp, method: "session" };
      } catch {
        // The tab might have closed or macOS might have denied Automation.
      }
    }
  }

  if (!appName) {
    return { ok: false, error: "No matching window or registered host for this worker." };
  }

  const threadId = meta.mcp_metadata?.provider_session_id || meta.provider_session_id;
  if (appName === "Codex" && typeof threadId === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(threadId)) {
    const res = spawnSync("open", [`codex://threads/${threadId}`], { encoding: "utf8" });
    if (res.status === 0) return { ok: true, appName, method: "deep_link" };
  }

  const args = appName === "Codex" ? ["-b", "com.openai.codex"] : ["-a", appName];
  const res = spawnSync("open", args, { encoding: "utf8" });
  if (res.status === 0) return { ok: true, appName, method: "app" };
  return { ok: false, error: res.stderr?.trim() || `Could not activate ${appName}` };
}

function launchCliHandoff(options = {}) {
  const command = buildCliCommandString(options);
  if (options.dryRun === true) {
    return { ok: true, command, terminal: detectPreferredMacTerminal(options.preferredTerminal) };
  }
  if (process.platform !== "darwin") {
    return { ok: false, command, error: "GUI->CLI terminal launch currently supports macOS" };
  }

  const terminal = detectPreferredMacTerminal(options.preferredTerminal);
  const escapedCmd = escapeAppleScriptString(command);

  if (terminal === "iterm2" && fs.existsSync("/Applications/iTerm.app")) {
    const script = [
      'tell application "iTerm"',
      "  activate",
      "  if (count of windows) = 0 then",
      "    create window with default profile",
      "    tell current session of current window",
      `      write text "${escapedCmd}"`,
      "    end tell",
      "  else",
      "    tell current window",
      "      create tab with default profile",
      "      tell current session",
      `        write text "${escapedCmd}"`,
      "      end tell",
      "    end tell",
      "  end if",
      "end tell",
    ].join("\n");
    const res = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
    if (res.status === 0) return { ok: true, terminal: "iterm2", command };
  }

  if (terminal === "ghostty" && fs.existsSync("/Applications/Ghostty.app")) {
    const child = spawn("open", ["-na", "Ghostty.app", "--args", "-e", "/bin/zsh", "-lic", command], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return { ok: true, terminal: "ghostty", command };
  }

  const appleTerminalScript = [
    'tell application "Terminal"',
    "  activate",
    `  do script "${escapedCmd}"`,
    "end tell",
  ].join("\n");
  const res = spawnSync("osascript", ["-e", appleTerminalScript], { encoding: "utf8" });
  if (res.status === 0) {
    return { ok: true, terminal: "apple-terminal", command };
  }
  return {
    ok: false,
    terminal,
    command,
    error: String(res.stderr || "Failed to launch macOS Terminal"),
  };
}

function installCliShims({
  coreRoot = path.resolve(__dirname, "..", ".."),
  nodeExecutable = resolveNodeExecutable(),
  tuiBinary = "",
  targetDir = getCliBinDir(),
  updateZshrc = false,
} = {}) {
  fs.mkdirSync(targetDir, { recursive: true });
  const installed = [];
  for (const binName of CLI_BINARIES) {
    const scriptFile = path.join(coreRoot, "bin", `${binName}.js`);
    if (!fs.existsSync(scriptFile)) continue;
    const shimPath = path.join(targetDir, binName);
    const lines = [
      "#!/bin/sh",
      "# Managed by Ufoo Desktop App — shares bundled Node & GlobalDaemon core",
      `export UFOO_NODE_EXECUTABLE=${shellQuote(nodeExecutable)}`,
    ];
    if (tuiBinary && fs.existsSync(tuiBinary)) {
      lines.push(`export UFOO_TUI_BIN=${shellQuote(tuiBinary)}`);
    }
    lines.push(`exec ${shellQuote(nodeExecutable)} ${shellQuote(scriptFile)} "$@"`);
    fs.writeFileSync(shimPath, `${lines.join("\n")}\n`, { mode: 0o755 });
    fs.chmodSync(shimPath, 0o755);
    installed.push(shimPath);
  }

  let profileUpdated = false;
  if (updateZshrc) {
    const zshrc = path.join(os.homedir(), ".zshrc");
    const exportLine = `export PATH="${targetDir}:$PATH"`;
    const current = fs.existsSync(zshrc) ? fs.readFileSync(zshrc, "utf8") : "";
    if (!current.includes(targetDir)) {
      fs.appendFileSync(zshrc, `\n# Ufoo CLI\n${exportLine}\n`, "utf8");
      profileUpdated = true;
    }
  }

  const pathEntries = String(process.env.PATH || "").split(path.delimiter);
  return {
    ok: true,
    targetDir,
    installed,
    inPath: pathEntries.includes(targetDir),
    profileUpdated,
  };
}

module.exports = {
  CLI_BINARIES,
  getDesktopHandoffSocketPath,
  getCliBinDir,
  buildHandoffUrl,
  parseHandoffUrl,
  createDesktopHandoffServer,
  sendHandoffToRunningDesktop,
  openInDesktopApp,
  buildCliCommandString,
  launchCliHandoff,
  focusExternalAgentHost,
  installCliShims,
};

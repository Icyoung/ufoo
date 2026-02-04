const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../config");

function resolveAgentId(projectRoot, agentId) {
  if (!agentId) return agentId;
  if (agentId.includes(":")) return agentId;
  const busPath = path.join(projectRoot, ".ufoo", "bus", "bus.json");
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entries = Object.entries(bus.subscribers || {});
    const match = entries.find(([, meta]) => meta?.nickname === agentId);
    if (match) return match[0];
    const targetType = agentId === "claude" ? "claude-code" : agentId;
    const candidates = entries
      .filter(([, meta]) => meta?.agent_type === targetType && meta?.status === "active")
      .map(([id]) => id);
    if (candidates.length === 1) return candidates[0];
  } catch {
    // ignore
  }
  return agentId;
}

function runAppleScript(lines) {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", lines.flatMap((l) => ["-e", l]));
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || "osascript failed"));
    });
  });
}

function escapeCommand(cmd) {
  return cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shellEscape(value) {
  const str = String(value);
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

async function spawnInternalAgent(projectRoot, agent, count = 1, nickname = "") {
  const runner = path.join(projectRoot, "bin", "ufoo.js");
  const logDir = path.join(projectRoot, ".ufoo", "run");
  const logFile = path.join(logDir, `agent-${agent}-${Date.now()}.log`);
  const errLog = fs.openSync(logFile, "a");
  for (let i = 0; i < count; i += 1) {
    const child = spawn(process.execPath, [runner, "agent-runner", agent], {
      detached: true,
      stdio: ["ignore", errLog, errLog],
      cwd: projectRoot,
      env: {
        ...process.env,
        UFOO_INTERNAL_AGENT: "1",
        UFOO_NICKNAME: nickname || "",
        UFOO_LAUNCH_MODE: "internal"
      },
    });
    child.unref();
  }
  setTimeout(() => {
    try {
      fs.closeSync(errLog);
    } catch {
      // ignore
    }
  }, 1000);
}

function spawnTmuxWindow(projectRoot, agent, nickname = "") {
  return new Promise((resolve, reject) => {
    const binary = agent === "codex" ? "ucodex" : "uclaude";
    const nickEnv = nickname ? `UFOO_NICKNAME=${shellEscape(nickname)} ` : "";
    const modeEnv = "UFOO_LAUNCH_MODE=tmux ";

    // IMPORTANT: Set TMUX_PANE inside the new window using tmux display-message
    // This ensures the agent gets the correct pane ID for command injection
    const setPaneEnv = `export TMUX_PANE=$(tmux display-message -p '#{pane_id}'); `;
    const runCmd = `cd ${shellEscape(projectRoot)} && ${setPaneEnv}${modeEnv}${nickEnv}${binary}`;
    const windowName = nickname || `${agent}-${Date.now()}`;

    // Use detached mode (-d) to avoid stealing focus
    // Use -a flag to insert after current window, avoiding index conflicts
    // Use target session from env or current session
    const targetSession = process.env.UFOO_TMUX_SESSION || "";
    const tmuxArgs = ["new-window", "-a", "-d", "-n", windowName];
    if (targetSession) {
      tmuxArgs.push("-t", targetSession);
    }
    tmuxArgs.push(runCmd);

    const proc = spawn("tmux", tmuxArgs);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || "tmux new-window failed"));
    });
  });
}

async function launchAgent(projectRoot, agent, count = 1, nickname = "") {
  const config = loadConfig(projectRoot);
  const mode = config.launchMode || "terminal";

  if (mode === "internal") {
    await spawnInternalAgent(projectRoot, agent, count, nickname);
    return { mode: "internal" };
  }
  if (mode === "tmux") {
    // Check if tmux is available
    const tmuxCheck = spawn("tmux", ["list-sessions"], { stdio: "pipe" });
    let stdout = "";
    tmuxCheck.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    const tmuxAvailable = await new Promise((resolve) => {
      tmuxCheck.on("close", (code) => resolve(code === 0));
      tmuxCheck.on("error", () => resolve(false));
    });
    if (!tmuxAvailable) {
      throw new Error("tmux is not available or no tmux session is running");
    }
    // If UFOO_TMUX_SESSION not set, use first available session
    if (!process.env.UFOO_TMUX_SESSION && stdout) {
      const sessions = stdout.trim().split("\n");
      if (sessions.length > 0) {
        const firstSession = sessions[0].split(":")[0];
        process.env.UFOO_TMUX_SESSION = firstSession;
      }
    }
    for (let i = 0; i < count; i += 1) {
      const nick = count > 1 ? `${nickname || agent}-${i + 1}` : (nickname || "");
      // eslint-disable-next-line no-await-in-loop
      await spawnTmuxWindow(projectRoot, agent, nick);
    }
    return { mode: "tmux" };
  }
  // terminal mode
  if (process.platform !== "darwin") {
    throw new Error("launchAgent with terminal mode is only supported on macOS Terminal.app");
  }
  const binary = agent === "codex" ? "ucodex" : "uclaude";
  const cwdCmd = `cd "${projectRoot}"`;
  const nickEnv = nickname ? `UFOO_NICKNAME=${shellEscape(nickname)} ` : "";
  const modeEnv = "UFOO_LAUNCH_MODE=terminal ";
  const runCmd = `${cwdCmd} && ${modeEnv}${nickEnv}${binary}`;
  const script = [
    'tell application "Terminal"',
    `do script "${escapeCommand(runCmd)}"`,
    "activate",
    "end tell",
  ];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runAppleScript(script);
  }
  return { mode: "terminal" };
}

async function closeAgent(projectRoot, agentId) {
  if (process.platform !== "darwin") {
    return false;
  }
  const resolvedId = resolveAgentId(projectRoot, agentId);
  const busPath = path.join(projectRoot, ".ufoo", "bus", "bus.json");
  let pid = null;
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entry = bus.subscribers?.[resolvedId];
    if (entry && entry.pid) pid = entry.pid;
  } catch {
    pid = null;
  }
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

module.exports = { launchAgent, closeAgent };

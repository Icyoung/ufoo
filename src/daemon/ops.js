const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../config");
const { getUfooPaths } = require("../ufoo/paths");
const { loadAgentsData, saveAgentsData } = require("../ufoo/agentsStore");
const { isAgentPidAlive, getTtyProcessInfo } = require("../bus/utils");

function resolveAgentId(projectRoot, agentId) {
  if (!agentId) return agentId;
  if (agentId.includes(":")) return agentId;
  const busPath = getUfooPaths(projectRoot).agentsFile;
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entries = Object.entries(bus.agents || {});
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

function listSubscribers(projectRoot, agentType) {
  const busPath = getUfooPaths(projectRoot).agentsFile;
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    return Object.entries(bus.agents || {})
      .filter(([, meta]) => meta && meta.agent_type === agentType && meta.status === "active")
      .map(([id]) => id);
  } catch {
    return [];
  }
}

async function waitForNewSubscriber(projectRoot, agentType, existing, timeoutMs = 15000) {
  const start = Date.now();
  const seen = new Set(existing || []);
  while (Date.now() - start < timeoutMs) {
    const current = listSubscribers(projectRoot, agentType);
    const diff = current.find((id) => !seen.has(id));
    if (diff) return diff;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function escapeCommand(cmd) {
  return cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function shellEscape(value) {
  const str = String(value);
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

function buildTitleCmd(title) {
  if (!title) return "";
  return `printf '\\033]0;%s\\007' ${shellEscape(title)}`;
}

function buildResumeCommand(projectRoot, agent, sessionId) {
  const binary = agent === "codex" ? "./bin/ucodex.js" : "./bin/uclaude.js";
  const args = buildResumeArgs(agent, sessionId);
  const argText = args.length > 0 ? ` ${args.map(shellEscape).join(" ")}` : "";
  const skipProbeEnv = "UFOO_SKIP_SESSION_PROBE=1 ";
  return `cd ${shellEscape(projectRoot)} && ${skipProbeEnv}${binary}${argText}`;
}

async function tryReuseTerminal(projectRoot, subscriberId, meta, agent, sessionId) {
  if (!meta || !meta.tty) return false;
  const info = getTtyProcessInfo(meta.tty);
  if (!info.alive || info.hasAgent || !info.idle) return false;
  const titleCmd = buildTitleCmd(meta.nickname || "");
  const baseCmd = buildResumeCommand(projectRoot, agent, sessionId);
  const command = titleCmd ? `${titleCmd} && ${baseCmd}` : baseCmd;
  try {
    const EventBus = require("../bus");
    const bus = new EventBus(projectRoot);
    bus.ensureBus();
    await bus.inject(subscriberId, command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn managed terminal agent - open a real Terminal session to run the agent
 */
async function spawnManagedTerminalAgent(projectRoot, agent, nickname = "", processManager = null, extraArgs = [], extraEnv = "") {
  const binary = agent === "codex" ? "./bin/ucodex.js" : "./bin/uclaude.js";
  const agentType = agent === "codex" ? "codex" : "claude-code";
  const existing = listSubscribers(projectRoot, agentType);
  const runDir = getUfooPaths(projectRoot).runDir;
  fs.mkdirSync(runDir, { recursive: true });

  const args = Array.isArray(extraArgs) ? extraArgs : [];
  const argText = args.length > 0 ? ` ${args.map(shellEscape).join(" ")}` : "";
  const nickEnv = nickname ? `UFOO_NICKNAME=${shellEscape(nickname)} ` : "";
  const modeEnv = "UFOO_LAUNCH_MODE=terminal ";
  const envPrefix = extraEnv ? `${String(extraEnv).trim()} ` : "";
  const titleCmd = buildTitleCmd(nickname);
  const prefix = titleCmd ? `${titleCmd} && ` : "";

  const logFile = path.join(runDir, `terminal-${agent}-${Date.now()}.log`);
  const runCmd = `cd ${shellEscape(projectRoot)} && ${prefix}${modeEnv}${nickEnv}${envPrefix}${binary}${argText}`;

  // Spawn managed agent as daemon child using a PTY via `script`
  const scriptCmd = `bash -lc ${shellEscape(runCmd)}`;
  const child = spawn("script", ["-q", logFile, "-c", scriptCmd], {
    detached: false,
    stdio: ["ignore", "ignore", "ignore"],
    cwd: projectRoot,
    env: {
      ...process.env,
      UFOO_LAUNCH_MODE: "terminal",
      UFOO_NICKNAME: nickname || "",
    },
  });

  if (processManager) {
    processManager.register(`terminal-${agent}-${child.pid}`, child);
  }

  // Open Terminal.app to tail logs for visibility
  if (process.platform === "darwin") {
    const script = [
      'tell application "Terminal"',
      `do script "${escapeCommand(`tail -n +1 -f ${logFile}`)}"`,
      "activate",
      "end tell",
    ];
    await runAppleScript(script);
  }

  const subscriberId = await waitForNewSubscriber(projectRoot, agentType, existing, 15000);
  return { child, subscriberId: subscriberId || null };
}

async function spawnInternalAgent(projectRoot, agent, count = 1, nickname = "", processManager = null) {
  const runner = path.join(projectRoot, "bin", "ufoo.js");
  const logDir = getUfooPaths(projectRoot).runDir;
  fs.mkdirSync(logDir, { recursive: true });

  const crypto = require("crypto");
  const EventBus = require("../bus");
  const children = [];
  const subscriberIds = [];

  // 初始化 bus
  const bus = new EventBus(projectRoot);
  await bus.init();

  const originalPid = process.pid;

  for (let i = 0; i < count; i += 1) {
    const logFile = path.join(logDir, `agent-${agent}-${Date.now()}-${i}.log`);
    const errLog = fs.openSync(logFile, "a");

    // 预生成 session ID
    const sessionId = crypto.randomBytes(4).toString("hex");
    const agentType = agent === "codex" ? "codex" : "claude-code";
    const subscriberId = `${agentType}:${sessionId}`;
    subscriberIds.push(subscriberId);

    // Daemon 预先在 bus 中注册
    bus.loadBusData();
    process.env.UFOO_PARENT_PID = String(originalPid);

    const finalNickname = count > 1 ? `${nickname || agent}-${i + 1}` : (nickname || "");
    const usePty = process.env.UFOO_INTERNAL_PTY !== "0";
    const launchMode = usePty ? "internal-pty" : "internal";

    // 传递 launch_mode 和 parent PID 到 join
    await bus.subscriberManager.join(sessionId, agentType, finalNickname, {
      launchMode,
      parentPid: originalPid,
    });
    bus.saveBusData();

    const runnerCmd = usePty ? "agent-pty-runner" : "agent-runner";
    const child = spawn(process.execPath, [runner, runnerCmd, agent], {
      // 关键改动：不使用 detached，daemon 作为父进程
      detached: false,
      stdio: ["ignore", errLog, errLog],
      cwd: projectRoot,
      env: {
        ...process.env,
        UFOO_INTERNAL_AGENT: "1",
        UFOO_INTERNAL_PTY: usePty ? "1" : "0",
        UFOO_SUBSCRIBER_ID: subscriberId,  // 直接传递 subscriber ID
        UFOO_NICKNAME: finalNickname,
        UFOO_LAUNCH_MODE: usePty ? "internal-pty" : "internal",
        UFOO_PARENT_PID: String(originalPid),
      },
    });

    // 本地日志记录
    child.on("exit", (code, signal) => {
      try {
        fs.closeSync(errLog);
      } catch {
        // ignore
      }

      if (signal) {
        fs.appendFileSync(logFile, `\n[internal-agent] ${subscriberId} killed by signal ${signal}\n`);
      } else {
        fs.appendFileSync(logFile, `\n[internal-agent] ${subscriberId} exited with code ${code}\n`);
      }
    });

    child.on("error", (err) => {
      fs.appendFileSync(logFile, `\n[internal-agent] ${subscriberId} spawn failed: ${err.message}\n`);
      try {
        fs.closeSync(errLog);
      } catch {
        // ignore
      }
    });

    // 注册到进程管理器（父子进程监控）
    if (processManager) {
      processManager.register(subscriberId, child);
    }

    children.push(child);
  }

  return { children, subscriberIds };
}

function spawnTmuxWindow(projectRoot, agent, nickname = "", extraArgs = [], extraEnv = "") {
  return new Promise((resolve, reject) => {
    const binary = agent === "codex" ? "ucodex" : "uclaude";
    const nickEnv = nickname ? `UFOO_NICKNAME=${shellEscape(nickname)} ` : "";
    const modeEnv = "UFOO_LAUNCH_MODE=tmux ";
    const ttyEnv = "UFOO_TTY_OVERRIDE=$(tty) ";
    const args = Array.isArray(extraArgs) ? extraArgs : [];
    const envPrefix = extraEnv ? `${String(extraEnv).trim()} ` : "";
    const argText = args.length > 0 ? ` ${args.map(shellEscape).join(" ")}` : "";

    // IMPORTANT: Set TMUX_PANE inside the new window using tmux display-message
    // This ensures the agent gets the correct pane ID for command injection
    const setPaneEnv = `export TMUX_PANE=$(tmux display-message -p '#{pane_id}'); `;
    const runCmd = `cd ${shellEscape(projectRoot)} && ${setPaneEnv}${modeEnv}${nickEnv}${ttyEnv}${envPrefix}${binary}${argText}`;
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

async function launchAgent(projectRoot, agent, count = 1, nickname = "", processManager = null) {
  const config = loadConfig(projectRoot);
  const mode = config.launchMode || "terminal";

  if (mode === "internal") {
    const result = await spawnInternalAgent(projectRoot, agent, count, nickname, processManager);
    return { mode: "internal", subscriberIds: result.subscriberIds };
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
  // terminal mode - daemon 作为父进程，输出到终端窗口
  if (process.platform !== "darwin") {
    throw new Error("launchAgent with terminal mode is only supported on macOS Terminal.app");
  }

  const subscriberIds = [];
  for (let i = 0; i < count; i += 1) {
    const nick = count > 1 ? `${nickname || agent}-${i + 1}` : (nickname || "");
    // eslint-disable-next-line no-await-in-loop
    const result = await spawnManagedTerminalAgent(projectRoot, agent, nick, processManager);
    if (result.subscriberId) subscriberIds.push(result.subscriberId);
  }

  return { mode: "terminal", subscriberIds };
}

function normalizeAgentType(agentType) {
  if (agentType === "claude-code") return "claude";
  if (agentType === "codex") return "codex";
  return agentType;
}

function buildResumeArgs(agent, sessionId) {
  if (!sessionId) return [];
  if (agent === "codex") return ["resume", sessionId];
  if (agent === "claude") return ["--session-id", sessionId];
  return [];
}

function isActiveAgent(meta) {
  if (!meta || meta.status !== "active") return false;
  if (meta.pid && !isAgentPidAlive(meta.pid)) return false;
  return true;
}

async function resumeAgents(projectRoot, target = "", processManager = null) {
  const config = loadConfig(projectRoot);
  const mode = config.launchMode || "terminal";
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const data = loadAgentsData(filePath);
  const entries = Object.entries(data.agents || {});

  let targets = entries;
  if (target) {
    if (target.includes(":")) {
      targets = entries.filter(([id]) => id === target);
    } else {
      targets = entries.filter(([, meta]) => meta && meta.nickname === target);
    }
  }

  const resumable = [];
  const skipped = [];

  for (const [id, meta] of targets) {
    if (!meta || !meta.provider_session_id) {
      skipped.push({ id, reason: "no provider session" });
      continue;
    }
    if (isActiveAgent(meta)) {
      skipped.push({ id, reason: "already active" });
      continue;
    }
    const agent = normalizeAgentType(meta.agent_type);
    if (agent !== "codex" && agent !== "claude") {
      skipped.push({ id, reason: "unsupported agent type" });
      continue;
    }
    resumable.push({ id, meta, agent });
  }

  if (resumable.length === 0) {
    return { ok: true, resumed: [], skipped };
  }

  // Clear old nicknames to allow reuse
  let updated = false;
  for (const item of resumable) {
    if (item.meta && item.meta.nickname) {
      data.agents[item.id] = { ...item.meta, nickname: "" };
      updated = true;
    }
  }
  if (updated) {
    saveAgentsData(filePath, data);
  }

  const resumed = [];
  if (mode === "internal") {
    for (const item of resumable) {
      skipped.push({ id: item.id, reason: "internal mode not supported for resume" });
    }
    return { ok: true, resumed, skipped };
  }

  for (const item of resumable) {
    const nickname = item.meta.nickname || "";
    const sessionId = item.meta.provider_session_id;
    const reused = await tryReuseTerminal(projectRoot, item.id, item.meta, item.agent, sessionId);
    if (!reused) {
      const args = buildResumeArgs(item.agent, sessionId);
      const envPrefix = "UFOO_SKIP_SESSION_PROBE=1";
      if (mode === "tmux") {
        // eslint-disable-next-line no-await-in-loop
        await spawnTmuxWindow(projectRoot, item.agent, nickname, args, envPrefix);
      } else {
        // eslint-disable-next-line no-await-in-loop
        await spawnManagedTerminalAgent(projectRoot, item.agent, nickname, processManager, args, envPrefix);
      }
    }
    resumed.push({ id: item.id, nickname, agent: item.agent, sessionId, reused });
  }

  return { ok: true, resumed, skipped };
}

async function closeAgent(projectRoot, agentId) {
  if (process.platform !== "darwin") {
    return false;
  }
  const resolvedId = resolveAgentId(projectRoot, agentId);
  const busPath = getUfooPaths(projectRoot).agentsFile;
  let pid = null;
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entry = bus.agents?.[resolvedId];
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

module.exports = { launchAgent, closeAgent, resumeAgents };

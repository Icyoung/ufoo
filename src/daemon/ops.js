const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../config");
const { getUfooPaths } = require("../ufoo/paths");
const { loadAgentsData, saveAgentsData } = require("../ufoo/agentsStore");
const { isAgentPidAlive, getTtyProcessInfo } = require("../bus/utils");
const { isITerm2 } = require("../terminal/detect");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");

function normalizeLaunchAgent(agent = "") {
  const value = String(agent || "").trim().toLowerCase();
  if (value === "codex") return "codex";
  if (value === "claude" || value === "claude-code") return "claude";
  if (value === "ufoo" || value === "ucode" || value === "ufoo-code") return "ufoo";
  return "";
}

function toBusAgentType(agent = "") {
  if (agent === "codex") return "codex";
  if (agent === "claude") return "claude-code";
  if (agent === "ufoo") return "ufoo-code";
  return "";
}

function toTerminalBinary(agent = "") {
  if (agent === "codex") return "ucodex";
  if (agent === "claude") return "uclaude";
  if (agent === "ufoo") return "ucode";
  return "";
}

function toTmuxBinary(agent = "") {
  if (agent === "codex") return "ucodex";
  if (agent === "claude") return "uclaude";
  if (agent === "ufoo") return "ucode";
  return "";
}

function normalizeLaunchScope(value, fallback = "inplace") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "inplace" || raw === "same" || raw === "current" || raw === "tab" || raw === "pane") {
    return "inplace";
  }
  if (
    raw === "window"
    || raw === "separate"
    || raw === "new"
    || raw === "new-window"
    || raw === "external"
    || raw === "1"
    || raw === "true"
    || raw === "yes"
    || raw === "y"
    || raw === "on"
  ) {
    return "window";
  }
  if (raw === "0" || raw === "false" || raw === "no" || raw === "n" || raw === "off") {
    return "inplace";
  }
  return fallback;
}

function normalizeTerminalAppPreference(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "terminal" || raw === "apple_terminal" || raw === "apple-terminal") {
    return "terminal";
  }
  if (raw === "iterm2" || raw === "iterm" || raw === "iterm.app") {
    return "iterm2";
  }
  return "";
}

function resolveAgentId(projectRoot, agentId) {
  if (!agentId) return agentId;
  if (agentId.includes(":")) return agentId;
  const busPath = getUfooPaths(projectRoot).agentsFile;
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entries = Object.entries(bus.agents || {});
    const match = entries.find(([, meta]) => meta?.nickname === agentId);
    if (match) return match[0];
    const normalized = normalizeLaunchAgent(agentId);
    const targetType = toBusAgentType(normalized) || agentId;
    const candidates = entries
      .filter(([, meta]) => meta?.agent_type === targetType && meta?.status === "active")
      .map(([id]) => id);
    if (candidates.length === 1) return candidates[0];
  } catch {
    // ignore
  }
  return agentId;
}

function markAgentInactive(projectRoot, agentId) {
  if (!agentId) return false;
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const data = loadAgentsData(filePath);
  const meta = data.agents?.[agentId];
  if (!meta) return false;
  data.agents[agentId] = {
    ...meta,
    status: "inactive",
    last_seen: new Date().toISOString(),
  };
  saveAgentsData(filePath, data);
  return true;
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

function escapeAppleScriptString(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(lines) {
  return new Promise((resolve, reject) => {
    const proc = spawn("osascript", lines.flatMap((l) => ["-e", l]));
    let stderr = "";
    let stdout = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || "osascript failed"));
    });
  });
}

async function openTerminalWindow(runCmd, options = {}) {
  if (process.platform !== "darwin") {
    throw new Error("Terminal mode is only supported on macOS");
  }

  const launchScope = normalizeLaunchScope(options.launchScope, "inplace");
  const terminalApp = normalizeTerminalAppPreference(options.terminalApp);
  const preferSeparateWindow = launchScope === "window";
  const escaped = escapeAppleScriptString(runCmd);
  const shouldTryITerm2 = terminalApp
    ? terminalApp === "iterm2"
    : isITerm2();

  if (shouldTryITerm2) {
    try {
      const script = preferSeparateWindow
        ? [
          'tell application "iTerm2"',
          `  create window with default profile command "${escaped}"`,
          "  activate",
          "end tell",
        ]
        : [
          'tell application "iTerm2"',
          "  if (count of windows) is 0 then",
          `    create window with default profile command "${escaped}"`,
          "  else",
          "    tell current window",
          `      create tab with default profile command "${escaped}"`,
          "    end tell",
          "  end if",
          "  activate",
          "end tell",
        ];
      await runAppleScript(script);
      return;
    } catch {
      // fall back to Terminal.app
    }
  }

  if (preferSeparateWindow) {
    const script = [
      'tell application "Terminal"',
      `  do script "${escaped}"`,
      "  activate",
      "end tell",
    ];
    await runAppleScript(script);
    return;
  }

  const preferredScript = [
    'tell application "Terminal"',
    "  activate",
    "  if (count of windows) is 0 then",
    `    do script "${escaped}"`,
    "  else",
    '    tell application "System Events"',
    '      tell process "Terminal"',
    '        keystroke "t" using command down',
    "      end tell",
    "    end tell",
    "    delay 0.08",
    `    do script "${escaped}" in selected tab of front window`,
    "  end if",
    "  activate",
    "end tell",
  ];

  try {
    await runAppleScript(preferredScript);
    return;
  } catch {
    // Accessibility can block System Events key events; fall back to pure Terminal AppleScript.
  }

  const fallbackScript = [
    'tell application "Terminal"',
    "  activate",
    "  if (count of windows) is 0 then",
    `    do script "${escaped}"`,
    "  else",
    "    set newTab to (do script \"\" in front window)",
    `    do script "${escaped}" in newTab`,
    "  end if",
    "  activate",
    "end tell",
  ];
  await runAppleScript(fallbackScript);
}

async function closeTerminalWindowByTty(ttyPath, preferApp = "") {
  if (process.platform !== "darwin") return false;
  if (!ttyPath) return false;

  const escaped = escapeAppleScriptString(ttyPath);

  const tryITerm = async () => {
    const script = [
      'tell application "iTerm2"',
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      "      repeat with s in sessions of t",
      `        if tty of s is \"${escaped}\" then`,
      "          close t",
      '          return "ok"',
      "        end if",
      "      end repeat",
      "    end repeat",
      "  end repeat",
      "end tell",
      'return "not found"',
    ];
    const res = await runAppleScript(script);
    return res === "ok";
  };

  const tryTerminal = async () => {
    const script = [
      'tell application "Terminal"',
      "  repeat with w in windows",
      "    repeat with t in tabs of w",
      `      if tty of t is \"${escaped}\" then`,
      "        close t",
      "        if (count of tabs of w) is 0 then close w",
      '        return "ok"',
      "      end if",
      "    end repeat",
      "  end repeat",
      "end tell",
      'return "not found"',
    ];
    const res = await runAppleScript(script);
    return res === "ok";
  };

  const prefer = (preferApp || "").toLowerCase();
  const order = prefer === "terminal"
    ? [tryTerminal, tryITerm]
    : prefer === "iterm2"
      ? [tryITerm, tryTerminal]
      : [tryITerm, tryTerminal];

  for (const attempt of order) {
    try {
      if (await attempt()) return true;
    } catch {
      // ignore and try next
    }
  }
  return false;
}

function buildTitleCmd(title) {
  if (!title) return "";
  return `printf '\\033]0;%s\\007' ${shellEscape(title)}`;
}

function buildResumeCommand(projectRoot, agent, sessionId) {
  const binary = toTerminalBinary(agent);
  if (!binary) {
    throw new Error(`unsupported agent for resume: ${agent}`);
  }
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
async function spawnManagedTerminalAgent(
  projectRoot,
  agent,
  nickname = "",
  processManager = null,
  extraArgs = [],
  extraEnv = "",
  launchScope = "window",
  terminalApp = ""
) {
  const normalizedAgent = normalizeLaunchAgent(agent);
  const binary = toTerminalBinary(normalizedAgent);
  const agentType = toBusAgentType(normalizedAgent);
  if (!binary || !agentType) {
    throw new Error(`unsupported agent type: ${agent}`);
  }
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

  const runCmd = `cd ${shellEscape(projectRoot)} && ${prefix}${modeEnv}${nickEnv}${envPrefix}${binary}${argText}`;

  await openTerminalWindow(runCmd, { launchScope, terminalApp });

  const subscriberId = await waitForNewSubscriber(projectRoot, agentType, existing, 15000);
  return { child: null, subscriberId: subscriberId || null };
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
    const normalizedAgent = normalizeLaunchAgent(agent);
    const agentType = toBusAgentType(normalizedAgent);
    if (!agentType) {
      throw new Error(`unsupported agent type: ${agent}`);
    }
    const subscriberId = `${agentType}:${sessionId}`;
    subscriberIds.push(subscriberId);

    // Daemon 预先在 bus 中注册
    bus.loadBusData();
    process.env.UFOO_PARENT_PID = String(originalPid);

    // For ucode/ufoo agents, default nickname to "ucode" if not specified
    const defaultNickname = agentType === "ufoo-code" ? "ucode" : agent;
    const finalNickname = count > 1 ? `${nickname || defaultNickname}-${i + 1}` : (nickname || defaultNickname);
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

    // Update bus data with the actual child PID so isMetaActive
    // can detect when the ptyRunner process dies.
    try {
      bus.loadBusData();
      if (bus.busData.agents && bus.busData.agents[subscriberId]) {
        bus.busData.agents[subscriberId].pid = child.pid;
      }
      bus.saveBusData();
    } catch {
      // ignore pid update errors
    }

    // 本地日志记录
    child.on("exit", (code, signal) => {
      try {
        fs.closeSync(errLog);
      } catch {
        // ignore
      }

      // Mark agent as inactive when its process exits
      try {
        bus.loadBusData();
        if (bus.busData.agents && bus.busData.agents[subscriberId]) {
          bus.busData.agents[subscriberId].status = "inactive";
          bus.busData.agents[subscriberId].last_seen = new Date().toISOString();
        }
        bus.saveBusData();
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
    const normalizedAgent = normalizeLaunchAgent(agent);
    const binary = toTmuxBinary(normalizedAgent);
    if (!binary) {
      reject(new Error(`unsupported agent type: ${agent}`));
      return;
    }
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

function resolveTmuxPaneTarget() {
  const explicit = String(process.env.UFOO_TMUX_TARGET || "").trim();
  if (explicit) return explicit;
  const preferredPane = String(process.env.UFOO_TMUX_PANE || "").trim();
  if (preferredPane) return preferredPane;
  const currentPane = String(process.env.TMUX_PANE || "").trim();
  if (currentPane) return currentPane;
  return "";
}

function spawnTmuxPane(projectRoot, agent, nickname = "", extraArgs = [], extraEnv = "", target = "") {
  return new Promise((resolve, reject) => {
    const normalizedAgent = normalizeLaunchAgent(agent);
    const binary = toTmuxBinary(normalizedAgent);
    if (!binary) {
      reject(new Error(`unsupported agent type: ${agent}`));
      return;
    }
    const nickEnv = nickname ? `UFOO_NICKNAME=${shellEscape(nickname)} ` : "";
    const modeEnv = "UFOO_LAUNCH_MODE=tmux ";
    const ttyEnv = "UFOO_TTY_OVERRIDE=$(tty) ";
    const args = Array.isArray(extraArgs) ? extraArgs : [];
    const envPrefix = extraEnv ? `${String(extraEnv).trim()} ` : "";
    const argText = args.length > 0 ? ` ${args.map(shellEscape).join(" ")}` : "";
    const setPaneEnv = `export TMUX_PANE=$(tmux display-message -p '#{pane_id}'); `;
    const runCmd = `cd ${shellEscape(projectRoot)} && ${setPaneEnv}${modeEnv}${nickEnv}${ttyEnv}${envPrefix}${binary}${argText}`;

    const tmuxArgs = ["split-window", "-d"];
    const normalizedTarget = String(target || "").trim();
    if (normalizedTarget) {
      tmuxArgs.push("-t", normalizedTarget);
    }
    tmuxArgs.push(runCmd);

    const proc = spawn("tmux", tmuxArgs);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || "tmux split-window failed"));
    });
  });
}

async function launchAgent(projectRoot, agent, count = 1, nickname = "", processManager = null, options = {}) {
  const config = loadConfig(projectRoot);
  const mode = config.launchMode || "terminal";
  const launchScope = normalizeLaunchScope(options.launchScope, "inplace");
  const terminalApp = normalizeTerminalAppPreference(options.terminalApp);
  const normalizedAgent = normalizeLaunchAgent(agent);
  if (!normalizedAgent) {
    throw new Error(`unsupported agent type: ${agent}`);
  }

  if (mode === "internal") {
    const result = await spawnInternalAgent(projectRoot, normalizedAgent, count, nickname, processManager);
    return { mode: "internal", launchScope, subscriberIds: result.subscriberIds };
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
    const paneTarget = resolveTmuxPaneTarget();
    const useSeparateWindow = launchScope === "window";
    for (let i = 0; i < count; i += 1) {
      // Use "ucode" as default nickname for ufoo/ucode agents
      const defaultNick = normalizedAgent === "ufoo" ? "ucode" : normalizedAgent;
      const nick = count > 1 ? `${nickname || defaultNick}-${i + 1}` : (nickname || "");
      if (useSeparateWindow) {
        // eslint-disable-next-line no-await-in-loop
        await spawnTmuxWindow(projectRoot, normalizedAgent, nick);
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          await spawnTmuxPane(projectRoot, normalizedAgent, nick, [], "", paneTarget);
        } catch {
          // Fallback to new window when current pane target cannot be resolved.
          // eslint-disable-next-line no-await-in-loop
          await spawnTmuxWindow(projectRoot, normalizedAgent, nick);
        }
      }
    }
    return { mode: "tmux", launchScope, subscriberIds: [] };
  }
  // terminal mode - daemon 作为父进程，输出到终端窗口
  if (process.platform !== "darwin") {
    throw new Error("launchAgent with terminal mode is only supported on macOS Terminal.app");
  }

  const subscriberIds = [];
  for (let i = 0; i < count; i += 1) {
    // Use "ucode" as default nickname for ufoo/ucode agents
    const defaultNick = normalizedAgent === "ufoo" ? "ucode" : normalizedAgent;
    const nick = count > 1 ? `${nickname || defaultNick}-${i + 1}` : (nickname || "");
    // eslint-disable-next-line no-await-in-loop
    const result = await spawnManagedTerminalAgent(
      projectRoot,
      normalizedAgent,
      nick,
      processManager,
      [],
      "",
      launchScope,
      terminalApp
    );
    if (result.subscriberId) subscriberIds.push(result.subscriberId);
  }

  return { mode: "terminal", launchScope, subscriberIds };
}

function normalizeAgentType(agentType) {
  if (agentType === "claude-code") return "claude";
  if (agentType === "codex") return "codex";
  if (agentType === "ufoo-code") return "ufoo";
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

function collectRecoverableAgents(projectRoot, target = "") {
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
      targets = entries.filter(([id, meta]) => id === target || (meta && meta.nickname === target));
    }
  }

  const recoverableEntries = [];
  const skipped = [];

  if (target && targets.length === 0) {
    return {
      mode,
      data,
      recoverableEntries,
      skipped: [{ id: target, reason: "target not found" }],
    };
  }

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

    if (mode === "internal") {
      skipped.push({ id, reason: "internal mode not supported for resume" });
      continue;
    }

    recoverableEntries.push({ id, meta, agent });
  }

  return {
    mode,
    data,
    recoverableEntries,
    skipped,
  };
}

function getRecoverableAgents(projectRoot, target = "") {
  const { mode, recoverableEntries, skipped } = collectRecoverableAgents(projectRoot, target);
  const recoverable = recoverableEntries.map((item) => ({
    id: item.id,
    nickname: item.meta.nickname || "",
    agent: item.agent,
    sessionId: item.meta.provider_session_id || "",
    launchMode: item.meta.launch_mode || "",
    lastSeen: item.meta.last_seen || "",
  }));
  return { ok: true, mode, recoverable, skipped };
}

async function resumeAgents(projectRoot, target = "", processManager = null) {
  const filePath = getUfooPaths(projectRoot).agentsFile;
  const { mode, data, recoverableEntries, skipped } = collectRecoverableAgents(projectRoot, target);

  if (recoverableEntries.length === 0) {
    return { ok: true, resumed: [], skipped };
  }

  // Clear old nicknames to allow reuse.
  let updated = false;
  for (const item of recoverableEntries) {
    if (item.meta && item.meta.nickname) {
      data.agents[item.id] = { ...item.meta, nickname: "" };
      updated = true;
    }
  }
  if (updated) {
    saveAgentsData(filePath, data);
  }

  const resumed = [];
  for (const item of recoverableEntries) {
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
  let launchMode = "";
  let tty = "";
  let terminalApp = "";
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entry = bus.agents?.[resolvedId];
    if (entry) {
      if (entry.pid) pid = entry.pid;
      launchMode = entry.launch_mode || "";
      tty = entry.tty || "";
      terminalApp = entry.terminal_app || "";
    }
  } catch {
    pid = null;
  }
  const adapterRouter = createTerminalAdapterRouter();
  const adapter = adapterRouter.getAdapter({ launchMode, agentId: resolvedId });
  const canCloseWindow = adapter.capabilities.supportsWindowClose && tty;

  // Close process first for faster state transition in chat.
  let sentSignal = false;
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      sentSignal = true;
    } catch {
      sentSignal = false;
    }
  }

  if (sentSignal || (!pid && canCloseWindow)) {
    markAgentInactive(projectRoot, resolvedId);
  }

  if (canCloseWindow) {
    // Non-blocking: don't hold close response on AppleScript window operations.
    void closeTerminalWindowByTty(tty, terminalApp).catch(() => false);
  }

  return sentSignal || (!pid && canCloseWindow);
}

module.exports = { launchAgent, closeAgent, getRecoverableAgents, resumeAgents };

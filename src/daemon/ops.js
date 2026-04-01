const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../config");
const { getUfooPaths } = require("../ufoo/paths");
const { loadAgentsData, saveAgentsData } = require("../ufoo/agentsStore");
const { isAgentPidAlive, getTtyProcessInfo } = require("../bus/utils");
const { isITerm2 } = require("../terminal/detect");
const { createTerminalAdapterRouter } = require("../terminal/adapterRouter");
const { applyProjectNicknamePrefix } = require("./nicknameScope");
const {
  createSession: createHostSession,
} = require("../terminal/adapters/hostAdapter");

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

function normalizeOptionalString(value = "") {
  return typeof value === "string" ? value.trim() : "";
}

function resolveHostLaunchContext(options = {}) {
  return {
    hostInjectSock:
      normalizeOptionalString(options.hostInjectSock)
      || normalizeOptionalString(process.env.UFOO_HOST_INJECT_SOCK)
      || normalizeOptionalString(process.env.HORIZON_INJECT_SOCK),
    hostDaemonSock:
      normalizeOptionalString(options.hostDaemonSock)
      || normalizeOptionalString(process.env.UFOO_HOST_DAEMON_SOCK),
    hostName:
      normalizeOptionalString(options.hostName)
      || normalizeOptionalString(process.env.UFOO_HOST_NAME),
    hostSessionId:
      normalizeOptionalString(options.hostSessionId)
      || normalizeOptionalString(process.env.UFOO_HOST_SESSION_ID)
      || normalizeOptionalString(process.env.HORIZON_SESSION_ID),
    hostCapabilities:
      options.hostCapabilities && typeof options.hostCapabilities === "object"
        ? { ...options.hostCapabilities }
        : null,
    requireActivityMonitor: options.requireActivityMonitor === true,
  };
}

function resolveConfiguredLaunchMode(configuredMode = "", options = {}) {
  const mode = normalizeOptionalString(configuredMode);
  if (mode === "internal" || mode === "tmux" || mode === "terminal" || mode === "host") {
    return mode;
  }
  const hostContext = resolveHostLaunchContext(options);
  if (hostContext.hostDaemonSock) return "host";
  if (process.env.TMUX_PANE) return "tmux";
  return "terminal";
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
    const scopedNickname = applyProjectNicknamePrefix(projectRoot, agentId);
    if (scopedNickname && scopedNickname !== agentId) {
      const scopedMatch = entries.find(([, meta]) => meta?.nickname === scopedNickname);
      if (scopedMatch) return scopedMatch[0];
    }
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
    activity_state: "",
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

function buildShellEnvPrefix(extraEnv = {}) {
  if (!extraEnv || typeof extraEnv !== "object") return "";
  return Object.entries(extraEnv)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || "")))
    .map(([key, value]) => `${key}=${shellEscape(String(value ?? ""))}`)
    .join(" ");
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

async function spawnManagedHostAgent(
  projectRoot,
  agent,
  nickname = "",
  processManager = null,
  extraArgs = [],
  extraEnv = {},
  hostOptions = {}
) {
  void processManager;
  const normalizedAgent = normalizeLaunchAgent(agent);
  const binary = toTerminalBinary(normalizedAgent);
  const agentType = toBusAgentType(normalizedAgent);
  if (!binary || !agentType) {
    throw new Error(`unsupported agent type: ${agent}`);
  }

  const hostContext = resolveHostLaunchContext(hostOptions);
  const requireActivityMonitor = hostContext.requireActivityMonitor === true;
  if (!hostContext.hostDaemonSock) {
    throw new Error("host launch requires UFOO_HOST_DAEMON_SOCK");
  }

  const createOptions = {};
  if (hostOptions.groupId) {
    createOptions.group_id = String(hostOptions.groupId).trim();
  } else if (hostContext.hostSessionId) {
    createOptions.source_session_id = hostContext.hostSessionId;
  }

  // Pre-register subscriber on the bus so waitForNewSubscriber resolves immediately
  const crypto = require("crypto");
  const EventBus = require("../bus");
  const existing = listSubscribers(projectRoot, agentType);
  let subscriberId = "";
  let preRegistrationError = null;
  try {
    const bus = new EventBus(projectRoot);
    await bus.init();
    if (bus.subscriberManager) {
      const sessionToken = crypto.randomBytes(4).toString("hex");
      subscriberId = `${agentType}:${sessionToken}`;
      const defaultNickname = agentType === "ufoo-code" ? "ucode" : normalizedAgent;
      const finalNickname = nickname || defaultNickname;
      await bus.subscriberManager.join(sessionToken, agentType, finalNickname, {
        launchMode: "host",
        parentPid: process.pid,
      });
      bus.saveBusData();
    }
  } catch (err) {
    preRegistrationError = err;
    subscriberId = "";
  }

  const args = Array.isArray(extraArgs) ? extraArgs : [];
  const argText = args.length > 0 ? ` ${args.map(shellEscape).join(" ")}` : "";

  const titleCmd = buildTitleCmd(nickname);
  const hasPreRegisteredSubscriber = !!subscriberId;

  // Pass env vars to Horizon via the env parameter (Horizon will set them for the child process)
  const env = {
    UFOO_LAUNCH_MODE: "host",
  };
  if (requireActivityMonitor) {
    env.UFOO_FORCE_PTY = "1";
  }
  if (subscriberId) {
    env.UFOO_SUBSCRIBER_ID = subscriberId;
  }
  if (nickname) {
    env.UFOO_NICKNAME = nickname;
  }
  // Parse extraEnv string (e.g., "UFOO_UCODE_BOOTSTRAP_FILE=/path/to/file") and add to env
  if (extraEnv && typeof extraEnv === "object") {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || ""))) {
        env[String(key)] = String(value ?? "");
      }
    }
  }

  let runCmd;
  if (hasPreRegisteredSubscriber) {
    // Group mode: use ufoo launcher for activity_state monitoring
    // This enables ReadyDetector and bootstrap to work correctly
    const ufooRunner = path.join(projectRoot, "bin", "ufoo.js");
    const launchCmd = `${shellEscape(process.execPath)} ${shellEscape(ufooRunner)} agent-pty-runner ${shellEscape(normalizedAgent)}${argText}`.trim();
    runCmd = titleCmd
      ? `cd ${shellEscape(projectRoot)} && ${titleCmd} && ${launchCmd}`
      : `cd ${shellEscape(projectRoot)} && ${launchCmd}`;
    // Force PTY wrapper so ReadyDetector + ActivityDetector work for activity_state monitoring.
    // Horizon sets UFOO_DISABLE_PTY=1 unconditionally; UFOO_FORCE_PTY=1 takes priority over it.
    env.UFOO_FORCE_PTY = "1";
  } else {
    if (preRegistrationError) {
      console.error(
        `[host-launch] pre-registration failed for ${nickname || agentType}: ${preRegistrationError.message || String(preRegistrationError)}`
      );
    }
    // Fallback launch still goes through the regular agent launcher binary.
    // For group/bootstrap-monitored flows we also force the PTY wrapper so
    // activity_state can progress out of "starting" after self-registration.
    const directCmd = `${binary}${argText}`;
    runCmd = titleCmd
      ? `cd ${shellEscape(projectRoot)} && ${titleCmd} && ${directCmd}`
      : `cd ${shellEscape(projectRoot)} && ${directCmd}`;
  }
  createOptions.command = runCmd;
  createOptions.env = env;

  const created = await createHostSession(hostContext.hostDaemonSock, createOptions);
  const sessionId = normalizeOptionalString(created?.session_id);
  const injectSock = normalizeOptionalString(created?.inject_sock);
  if (!sessionId || !injectSock) {
    throw new Error("host create_session returned incomplete session info");
  }

  // If pre-registration succeeded we already have the subscriber ID;
  // otherwise fall back to polling (slower but still works).
  if (!subscriberId) {
    subscriberId = await waitForNewSubscriber(projectRoot, agentType, existing, 20000);
  }

  // Return format must match what launchAgent expects: { mode, launchScope, subscriberIds }
  // subscriberIds is an array for consistency with other launch modes
  const resultSubscriberId = subscriberId || null;
  return { child: null, subscriberId: resultSubscriberId, subscriberIds: [resultSubscriberId].filter(Boolean), sessionId, injectSock };
}

async function spawnInternalAgent(projectRoot, agent, count = 1, nickname = "", processManager = null, extraEnv = {}) {
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
        ...(extraEnv && typeof extraEnv === "object" ? extraEnv : {}),
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

function runTmuxCommand(tmuxArgs = [], failureMessage = "tmux command failed", captureStdout = false) {
  return new Promise((resolve, reject) => {
    const proc = spawn("tmux", tmuxArgs);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(captureStdout ? stdout.trim() : "");
      } else {
        reject(new Error(stderr || failureMessage));
      }
    });
  });
}

function applyTmuxLayout(layout = "", target = "") {
  const normalizedLayout = String(layout || "").trim();
  if (!normalizedLayout) return Promise.resolve("");
  const tmuxArgs = ["select-layout"];
  const normalizedTarget = String(target || "").trim();
  if (normalizedTarget) {
    tmuxArgs.push("-t", normalizedTarget);
  }
  tmuxArgs.push(normalizedLayout);
  return runTmuxCommand(tmuxArgs, "tmux select-layout failed");
}

function spawnTmuxPane(
  projectRoot,
  agent,
  nickname = "",
  extraArgs = [],
  extraEnv = "",
  target = "",
  splitOptions = {}
) {
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
    const orientation = String(splitOptions.orientation || "").trim().toLowerCase();
    if (orientation === "horizontal") {
      tmuxArgs.push("-h");
    } else if (orientation === "vertical") {
      tmuxArgs.push("-v");
    }
    const capturePaneId = splitOptions.capturePaneId === true;
    if (capturePaneId) {
      tmuxArgs.push("-P", "-F", "#{pane_id}");
    }
    const normalizedTarget = String(target || "").trim();
    if (normalizedTarget) {
      tmuxArgs.push("-t", normalizedTarget);
    }
    tmuxArgs.push(runCmd);

    runTmuxCommand(tmuxArgs, "tmux split-window failed", capturePaneId)
      .then((paneId) => resolve({ paneId: capturePaneId ? paneId : "" }))
      .catch(reject);
  });
}

async function launchAgent(projectRoot, agent, count = 1, nickname = "", processManager = null, options = {}) {
  const config = loadConfig(projectRoot);
  const mode = resolveConfiguredLaunchMode(config.launchMode, options);
  const launchScope = normalizeLaunchScope(options.launchScope, "inplace");
  const terminalApp = normalizeTerminalAppPreference(options.terminalApp);
  const extraEnvObject = options.extraEnv && typeof options.extraEnv === "object" ? options.extraEnv : {};
  const extraEnvPrefix = buildShellEnvPrefix(extraEnvObject);
  const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
  const normalizedAgent = normalizeLaunchAgent(agent);
  if (!normalizedAgent) {
    throw new Error(`unsupported agent type: ${agent}`);
  }

  if (mode === "internal") {
    const result = await spawnInternalAgent(
      projectRoot,
      normalizedAgent,
      count,
      nickname,
      processManager,
      extraEnvObject
    );
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
    const tmuxLayoutContext = options.tmuxLayoutContext && typeof options.tmuxLayoutContext === "object"
      ? options.tmuxLayoutContext
      : null;
    const useGroupRightColumnLayout = !useSeparateWindow
      && tmuxLayoutContext
      && tmuxLayoutContext.mode === "group-right-column";
    for (let i = 0; i < count; i += 1) {
      // Use "ucode" as default nickname for ufoo/ucode agents
      const defaultNick = normalizedAgent === "ufoo" ? "ucode" : normalizedAgent;
      const nick = count > 1 ? `${nickname || defaultNick}-${i + 1}` : (nickname || "");
      if (useSeparateWindow) {
        // eslint-disable-next-line no-await-in-loop
        await spawnTmuxWindow(projectRoot, normalizedAgent, nick, extraArgs, extraEnvPrefix);
      } else if (useGroupRightColumnLayout && paneTarget) {
        const basePane = String(tmuxLayoutContext.basePane || paneTarget).trim() || paneTarget;
        tmuxLayoutContext.basePane = basePane;
        const rightColumnPane = String(tmuxLayoutContext.rightColumnPane || "").trim();
        const splitTarget = rightColumnPane || basePane;
        const splitOrientation = rightColumnPane ? "vertical" : "horizontal";
        let splitResult;
        try {
          // eslint-disable-next-line no-await-in-loop
          splitResult = await spawnTmuxPane(projectRoot, normalizedAgent, nick, extraArgs, extraEnvPrefix, splitTarget, {
            orientation: splitOrientation,
            capturePaneId: !rightColumnPane,
          });
        } catch {
          // Fallback to new window when current pane target cannot be resolved.
          // eslint-disable-next-line no-await-in-loop
          await spawnTmuxWindow(projectRoot, normalizedAgent, nick, extraArgs, extraEnvPrefix);
          continue;
        }
        if (!rightColumnPane && splitResult && splitResult.paneId) {
          tmuxLayoutContext.rightColumnPane = splitResult.paneId;
        }
        // Keep the original chat pane on the left while stacking agents evenly on the right.
        // eslint-disable-next-line no-await-in-loop
        await applyTmuxLayout("main-vertical", basePane);
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          await spawnTmuxPane(projectRoot, normalizedAgent, nick, extraArgs, extraEnvPrefix, paneTarget);
        } catch {
          // Fallback to new window when current pane target cannot be resolved.
          // eslint-disable-next-line no-await-in-loop
          await spawnTmuxWindow(projectRoot, normalizedAgent, nick, extraArgs, extraEnvPrefix);
        }
      }
    }
    return { mode: "tmux", launchScope, subscriberIds: [] };
  }
  if (mode === "host") {
    const subscriberIds = [];
    const hostContext = resolveHostLaunchContext(options);
    for (let i = 0; i < count; i += 1) {
      const defaultNick = normalizedAgent === "ufoo" ? "ucode" : normalizedAgent;
      const nick = count > 1 ? `${nickname || defaultNick}-${i + 1}` : (nickname || "");
      // eslint-disable-next-line no-await-in-loop
      const result = await spawnManagedHostAgent(
        projectRoot,
        normalizedAgent,
        nick,
        processManager,
        [],
        extraEnvObject,
        hostContext
      );
      if (result.subscriberId) subscriberIds.push(result.subscriberId);
    }
    return { mode: "host", launchScope, subscriberIds };
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
      extraEnvPrefix,
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
    const scopedTarget = applyProjectNicknamePrefix(projectRoot, target);
    if (target.includes(":")) {
      targets = entries.filter(([id]) => id === target);
    } else {
      targets = entries.filter(([id, meta]) =>
        id === target
        || (meta && meta.nickname === target)
        || (scopedTarget && scopedTarget !== target && meta && meta.nickname === scopedTarget)
      );
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
  const resolvedId = resolveAgentId(projectRoot, agentId);
  const busPath = getUfooPaths(projectRoot).agentsFile;
  let pid = 0;
  let launchMode = "";
  let tty = "";
  let terminalApp = "";
  let tmuxPane = "";
  let meta = null;
  let found = false;
  try {
    const bus = JSON.parse(fs.readFileSync(busPath, "utf8"));
    const entry = bus.agents?.[resolvedId];
    if (entry) {
      found = true;
      meta = entry;
      const parsedPid = Number.parseInt(entry.pid, 10);
      pid = Number.isFinite(parsedPid) && parsedPid > 0 ? parsedPid : 0;
      launchMode = entry.launch_mode || "";
      tty = entry.tty || "";
      terminalApp = entry.terminal_app || "";
      tmuxPane = entry.tmux_pane || "";
    }
  } catch {
    found = false;
  }

  if (!found) {
    return { ok: true, already_stopped: true, resolved_agent_id: resolvedId };
  }

  const adapterRouter = createTerminalAdapterRouter();
  const adapter = adapterRouter.getAdapter({ launchMode, agentId: resolvedId, meta });
  const canCloseWindow = process.platform === "darwin"
    && Boolean(adapter.capabilities.supportsWindowClose)
    && Boolean(tty);

  // Close process first for faster state transition in chat.
  let sentSignal = false;
  let killErr = null;
  if (pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
      sentSignal = true;
    } catch (err) {
      killErr = err || null;
      sentSignal = false;
    }
  }

  const pidGone = pid > 0 && !sentSignal && !isAgentPidAlive(pid);
  if (sentSignal || pid === 0 || pidGone) {
    markAgentInactive(projectRoot, resolvedId);
  }

  if (canCloseWindow) {
    // Non-blocking: don't hold close response on AppleScript window operations.
    void closeTerminalWindowByTty(tty, terminalApp).catch(() => false);
  }

  // Tmux pane cleanup: kill the pane after sending SIGTERM to the process.
  if (launchMode === "tmux" && tmuxPane) {
    try {
      spawnSync("tmux", ["kill-pane", "-t", tmuxPane], { stdio: "ignore", timeout: 3000 });
    } catch {
      // ignore - pane may already be gone
    }
  }

  if (sentSignal) {
    return { ok: true, resolved_agent_id: resolvedId };
  }
  if (pid === 0 || pidGone) {
    return { ok: true, already_stopped: true, resolved_agent_id: resolvedId };
  }
  const reason = killErr && killErr.message
    ? killErr.message
    : "failed to stop process";
  return {
    ok: false,
    error: reason,
    resolved_agent_id: resolvedId,
  };
}

module.exports = { launchAgent, closeAgent, getRecoverableAgents, resumeAgents };

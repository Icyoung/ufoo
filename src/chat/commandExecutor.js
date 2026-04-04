const path = require("path");
const EventBus = require("../bus");
const { IPC_REQUEST_TYPES } = require("../shared/eventContract");
const UfooInit = require("../init");
const { runGroupCoreCommand } = require("../cli/groupCoreCommands");
const { loadConfig: loadProjectConfig, saveConfig: saveProjectConfig, loadGlobalUcodeConfig, saveGlobalUcodeConfig } = require("../config");
const { resolveTransport } = require("../code/nativeRunner");
const { parseIntervalMs, formatIntervalMs } = require("./cronScheduler");
const { isGlobalControllerProjectRoot, resolveGlobalControllerUfooDir } = require("../projects");
const { loadPromptProfileRegistry } = require("../group/promptProfiles");
const { resolveSoloAgentType } = require("../solo/commands");

function defaultCreateDoctor(projectRoot) {
  const UfooDoctor = require("../doctor");
  return new UfooDoctor(projectRoot);
}

function defaultCreateContext(projectRoot) {
  const UfooContext = require("../context");
  return new UfooContext(projectRoot);
}

function defaultCreateSkills(projectRoot) {
  const UfooSkills = require("../skills");
  return new UfooSkills(projectRoot);
}

function defaultResolveTerminalApp() {
  const program = String(process.env.TERM_PROGRAM || "").trim();
  if (program === "Apple_Terminal") return "terminal";
  if (program === "iTerm.app" || process.env.ITERM_SESSION_ID) return "iterm2";
  return "";
}

function collectHostLaunchRequestContext(env = process.env) {
  const hostInjectSock = String(env.UFOO_HOST_INJECT_SOCK || env.HORIZON_INJECT_SOCK || "").trim();
  const hostDaemonSock = String(env.UFOO_HOST_DAEMON_SOCK || "").trim();
  const hostName = String(env.UFOO_HOST_NAME || "").trim();
  const hostSessionId = String(env.UFOO_HOST_SESSION_ID || env.HORIZON_SESSION_ID || "").trim();
  const context = {};
  if (hostInjectSock) context.host_inject_sock = hostInjectSock;
  if (hostDaemonSock) context.host_daemon_sock = hostDaemonSock;
  if (hostName) context.host_name = hostName;
  if (hostSessionId) context.host_session_id = hostSessionId;
  return context;
}

async function withCapturedConsole(capture, fn) {
  const originalLog = console.log;
  const originalError = console.error;

  if (capture.log) {
    console.log = (...args) => capture.log(...args);
  }
  if (capture.error) {
    console.error = (...args) => capture.error(...args);
  }

  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function createCommandExecutor(options = {}) {
  const {
    projectRoot,
    parseCommand = () => null,
    escapeBlessed = (value) => String(value || ""),
    logMessage = () => {},
    renderScreen = () => {},
    getActiveAgents = () => [],
    getActiveAgentMetaMap = () => new Map(),
    getAgentLabel = (id) => id,
    isDaemonRunning = () => false,
    startDaemon = () => {},
    stopDaemon = () => {},
    restartDaemon = async () => {},
    send = () => {},
    requestStatus = () => {},
    createBus = (root) => new EventBus(root),
    createInit = (repoRoot) => new UfooInit(repoRoot),
    createDoctor = defaultCreateDoctor,
    createContext = defaultCreateContext,
    createSkills = defaultCreateSkills,
    activateAgent = async () => {},
    loadConfig = loadProjectConfig,
    saveConfig = saveProjectConfig,
    loadUcodeConfig = loadGlobalUcodeConfig,
    saveUcodeConfig = saveGlobalUcodeConfig,
    createCronTask = () => null,
    listCronTasks = () => [],
    stopCronTask = () => false,
    runGroupCore = runGroupCoreCommand,
    requestCron = null,
    globalMode = false,
    listProjects = () => [],
    getCurrentProject = () => ({ projectRoot }),
    switchProject = async () => ({ ok: false, error: "project switching unavailable" }),
    resolveTerminalApp = defaultResolveTerminalApp,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule = (fn, ms) => setTimeout(fn, ms),
  } = options;

  if (!projectRoot) {
    throw new Error("createCommandExecutor requires projectRoot");
  }

  async function handleDoctorCommand() {
    logMessage("system", "{white-fg}⚙{/white-fg} Running health check...");

    await withCapturedConsole(
      {
        log: (...args) => logMessage("system", args.join(" ")),
        error: (...args) => logMessage("error", args.join(" ")),
      },
      async () => {
        try {
          const doctor = createDoctor(projectRoot);
          const result = await Promise.resolve(doctor.run());

          if (result) {
            logMessage("system", "{white-fg}✓{/white-fg} System healthy");
          } else {
            logMessage("error", "{white-fg}✗{/white-fg} Health check failed");
          }
          renderScreen();
        } catch (err) {
          logMessage("error", `{white-fg}✗{/white-fg} Doctor check failed: ${escapeBlessed(err.message)}`);
          renderScreen();
        }
      }
    );
  }

  async function handleStatusCommand() {
    const activeAgents = getActiveAgents();
    const activeAgentMetaMap = getActiveAgentMetaMap();

    if (activeAgents.length === 0) {
      logMessage("system", "{cyan-fg}Status:{/cyan-fg} No active agents");
    } else {
      logMessage("system", `{cyan-fg}Status:{/cyan-fg} ${activeAgents.length} active agent(s)`);
      for (const id of activeAgents) {
        const label = getAgentLabel(id);
        const meta = activeAgentMetaMap.get(id);
        const mode = meta && meta.launch_mode ? meta.launch_mode : "unknown";
        logMessage("system", `  • {cyan-fg}${label}{/cyan-fg} {white-fg}[${mode}]{/white-fg}`);
      }
    }

    if (isDaemonRunning(projectRoot)) {
      logMessage("system", "{white-fg}✓{/white-fg} Daemon is running");
    } else {
      logMessage("system", "{white-fg}✗{/white-fg} Daemon is not running");
    }
  }

  async function handleDaemonCommand(args = []) {
    const subcommand = args[0];

    if (subcommand === "start") {
      if (isDaemonRunning(projectRoot)) {
        logMessage("system", "{white-fg}⚠{/white-fg} Daemon already running");
      } else {
        logMessage("system", "{white-fg}⚙{/white-fg} Starting daemon...");
        startDaemon(projectRoot);
        await sleep(1000);
        if (isDaemonRunning(projectRoot)) {
          logMessage("system", "{white-fg}✓{/white-fg} Daemon started");
        } else {
          logMessage("error", "{white-fg}✗{/white-fg} Failed to start daemon");
        }
      }
      return;
    }

    if (subcommand === "stop") {
      logMessage("system", "{white-fg}⚙{/white-fg} Stopping daemon...");
      stopDaemon(projectRoot);
      await sleep(1000);
      if (!isDaemonRunning(projectRoot)) {
        logMessage("system", "{white-fg}✓{/white-fg} Daemon stopped");
      } else {
        logMessage("error", "{white-fg}✗{/white-fg} Failed to stop daemon");
      }
      return;
    }

    if (subcommand === "restart") {
      await restartDaemon();
      return;
    }

    if (subcommand === "status") {
      if (isDaemonRunning(projectRoot)) {
        logMessage("system", "{white-fg}✓{/white-fg} Daemon is running");
      } else {
        logMessage("system", "{white-fg}✗{/white-fg} Daemon is not running");
      }
      return;
    }

    logMessage("error", "{white-fg}✗{/white-fg} Unknown daemon command. Use: start, stop, restart, status");
  }

  async function handleInitCommand(args = []) {
    logMessage("system", "{white-fg}⚙{/white-fg} Initializing ufoo modules...");

    await withCapturedConsole(
      {
        log: (...logArgs) => {
          const msg = logArgs.join(" ");
          logMessage("system", msg);
        },
        error: (...errorArgs) => {
          logMessage("error", errorArgs.join(" "));
        },
      },
      async () => {
        try {
          const repoRoot = path.join(__dirname, "..", "..");
          const init = createInit(repoRoot);
          const modules = args.length > 0 ? args.join(",") : "context,bus";
          await init.init({ modules, project: projectRoot });

          logMessage("system", "{white-fg}✓{/white-fg} Initialization complete");
          renderScreen();
        } catch (err) {
          logMessage("error", `{white-fg}✗{/white-fg} Init failed: ${escapeBlessed(err.message)}`);
          if (err.stack) {
            logMessage("error", escapeBlessed(err.stack));
          }
          renderScreen();
        }
      }
    );
  }

  async function handleBusCommand(args = []) {
    const subcommand = args[0];

    try {
      if (subcommand === "send") {
        let injectionMode = "immediate";
        let index = 1;
        while (index < args.length) {
          const arg = args[index];
          if (arg === "--queued") {
            injectionMode = "queued";
            index += 1;
            continue;
          }
          if (arg === "--immediate") {
            injectionMode = "immediate";
            index += 1;
            continue;
          }
          break;
        }
        const positionals = args.slice(index);
        if (positionals.length < 2) {
          logMessage("error", "{white-fg}✗{/white-fg} Usage: /bus send [--queued|--immediate] <target> <message>");
          return;
        }
        const target = positionals[0];
        const message = positionals.slice(1).join(" ");
        send({
          type: IPC_REQUEST_TYPES.BUS_SEND,
          target,
          message,
          injection_mode: injectionMode,
          source: "chat-command",
        });
        logMessage("system", `{white-fg}✓{/white-fg} Message sent to ${target}`);
        return;
      }

      const bus = createBus(projectRoot);

      if (subcommand === "rename") {
        if (args.length < 3) {
          logMessage("error", "{white-fg}✗{/white-fg} Usage: /bus rename <agent> <nickname>");
          return;
        }
        const agentId = args[1];
        const nickname = args[2];
        await bus.rename(agentId, nickname);
        logMessage("system", `{white-fg}✓{/white-fg} Renamed ${agentId} to ${nickname}`);
        requestStatus();
        return;
      }

      if (subcommand === "list") {
        bus.ensureBus();
        bus.loadBusData();
        const subscribers = Object.entries((bus.busData && bus.busData.agents) || {});
        if (subscribers.length === 0) {
          logMessage("system", "{white-fg}No active agents{/white-fg}");
        } else {
          logMessage("system", "{cyan-fg}Active agents:{/cyan-fg}");
          for (const [id, meta] of subscribers) {
            const nickname = meta && meta.nickname ? ` (${meta.nickname})` : "";
            const status = meta && meta.status ? meta.status : "unknown";
            logMessage("system", `  • ${id}${nickname} {white-fg}[${status}]{/white-fg}`);
          }
        }
        return;
      }

      if (subcommand === "status") {
        bus.ensureBus();
        bus.loadBusData();
        const count = Object.keys((bus.busData && bus.busData.agents) || {}).length;
        logMessage("system", `{cyan-fg}Bus status:{/cyan-fg} ${count} agent(s) registered`);
        return;
      }

      if (subcommand === "activate") {
        if (args.length < 2) {
          logMessage("error", "{white-fg}✗{/white-fg} Usage: /bus activate <agent>");
          return;
        }
        const target = args[1];
        await activateAgent(target);
        logMessage("system", `{white-fg}✓{/white-fg} Activated ${target}`);
        return;
      }

      logMessage("error", "{white-fg}✗{/white-fg} Unknown bus command. Use: send, rename, list, status, activate");
    } catch (err) {
      logMessage("error", `{white-fg}✗{/white-fg} Bus command failed: ${escapeBlessed(err.message)}`);
    }
  }

  async function handleCtxCommand(args = []) {
    logMessage("system", "{white-fg}⚙{/white-fg} Running context check...");

    await withCapturedConsole(
      {
        log: (...logArgs) => logMessage("system", logArgs.join(" ")),
        error: (...errorArgs) => logMessage("error", errorArgs.join(" ")),
      },
      async () => {
        try {
          const ctx = createContext(projectRoot);

          if (args.length === 0 || args[0] === "doctor") {
            await ctx.doctor();
          } else if (args[0] === "decisions") {
            await ctx.listDecisions();
          } else {
            await ctx.status();
          }

          renderScreen();
        } catch (err) {
          logMessage("error", `{white-fg}✗{/white-fg} Context check failed: ${escapeBlessed(err.message)}`);
          renderScreen();
        }
      }
    );
  }

  async function handleSkillsCommand(args = []) {
    const subcommand = args[0];

    await withCapturedConsole(
      {
        log: (...logArgs) => logMessage("system", logArgs.join(" ")),
      },
      async () => {
        try {
          const skills = createSkills(projectRoot);

          if (subcommand === "list") {
            const skillList = skills.list();
            if (skillList.length === 0) {
              logMessage("system", "{white-fg}No skills found{/white-fg}");
            } else {
              logMessage("system", `{cyan-fg}Available skills:{/cyan-fg} ${skillList.length}`);
              for (const skill of skillList) {
                logMessage("system", `  • ${skill}`);
              }
            }
          } else if (subcommand === "install") {
            const target = args[1] || "all";
            logMessage("system", `{white-fg}⚙{/white-fg} Installing skills: ${target}...`);
            await skills.install(target);
            logMessage("system", "{white-fg}✓{/white-fg} Skills installed");
          } else {
            logMessage("error", "{white-fg}✗{/white-fg} Unknown skills command. Use: list, install");
          }

          renderScreen();
        } catch (err) {
          logMessage("error", `{white-fg}✗{/white-fg} Skills command failed: ${escapeBlessed(err.message)}`);
          renderScreen();
        }
      }
    );
  }

  async function handleLaunchCommand(args = []) {
    if (args.length === 0) {
      logMessage(
        "error",
        "{white-fg}✗{/white-fg} Usage: /launch <claude|codex|ucode> [nickname=<name>] [profile=<id>] [count=<n>] [scope=inplace|window]"
      );
      return;
    }

    const agentType = String(args[0] || "").trim().toLowerCase();
    if (agentType !== "claude" && agentType !== "codex" && agentType !== "ucode") {
      logMessage("error", "{white-fg}✗{/white-fg} Unknown agent type. Use: claude, codex, or ucode");
      return;
    }
    const normalizedAgent = agentType === "ucode" ? "ufoo" : agentType;

    const parsedOptions = {};
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i];
      if (arg.includes("=")) {
        const [key, value] = arg.split("=", 2);
        parsedOptions[key] = value;
      }
    }

    function normalizeLaunchScopeOption(value, fallback = "inplace") {
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
      return "";
    }

    const nickname = parsedOptions.nickname || "";
    const promptProfile = parsedOptions.profile || parsedOptions.prompt_profile || "";
    const count = parseInt(parsedOptions.count || "1", 10);
    const scopeRaw = parsedOptions.scope || parsedOptions.launch_scope || parsedOptions.window || "";
    let launchScope = normalizeLaunchScopeOption(scopeRaw, "inplace");
    if (scopeRaw && !launchScope) {
      logMessage("error", "{white-fg}✗{/white-fg} scope must be inplace|window");
      return;
    }
    const rawFlags = args
      .slice(1)
      .filter((arg) => !String(arg || "").includes("="))
      .map((arg) => String(arg || "").trim().toLowerCase())
      .filter(Boolean);
    for (const flag of rawFlags) {
      const normalized = normalizeLaunchScopeOption(flag, "");
      if (normalized) launchScope = normalized;
    }
    if (!launchScope) launchScope = "inplace";
    if (nickname && count > 1) {
      logMessage("error", "{white-fg}✗{/white-fg} nickname requires count=1");
      return;
    }
    if (promptProfile && count > 1) {
      logMessage("error", "{white-fg}✗{/white-fg} profile requires count=1");
      return;
    }

    try {
      const request = {
        type: IPC_REQUEST_TYPES.LAUNCH_AGENT,
        agent: normalizedAgent,
        count: Number.isFinite(count) ? count : 1,
        nickname,
        prompt_profile: promptProfile,
        launch_scope: launchScope,
        ...collectHostLaunchRequestContext(),
      };
      const terminalApp = String(resolveTerminalApp() || "").trim().toLowerCase();
      if (terminalApp === "terminal" || terminalApp === "iterm2") {
        request.terminal_app = terminalApp;
      }
      send(request);
      schedule(requestStatus, 1000);
    } catch (err) {
      logMessage("error", `{white-fg}✗{/white-fg} Launch failed: ${escapeBlessed(err.message)}`);
    }
  }

  async function handleRoleCommand(args = []) {
    const action = String(args[0] || "").trim().toLowerCase();
    if (action === "list" || action === "ls") {
      try {
        const registry = loadPromptProfileRegistry(projectRoot);
        const profiles = registry.profiles || [];
        if (profiles.length === 0) {
          logMessage("system", "{white-fg}⚙{/white-fg} No prompt profiles found.");
          return;
        }
        logMessage("system", `{white-fg}⚙{/white-fg} Available prompt profiles (${profiles.length}):`);
        for (const p of profiles) {
          const aliases = p.aliases && p.aliases.length > 0 ? ` {gray-fg}(${p.aliases.join(", ")}){/gray-fg}` : "";
          const source = p.source ? ` {cyan-fg}[${p.source}]{/cyan-fg}` : "";
          const summary = p.summary ? `  ${p.summary}` : "";
          logMessage("system", `  {bold}${escapeBlessed(p.id)}{/bold}${aliases}${source}`);
          if (summary) {
            logMessage("system", `    ${escapeBlessed(summary)}`);
          }
        }
      } catch (err) {
        logMessage("error", `{white-fg}✗{/white-fg} Failed to list profiles: ${escapeBlessed(err.message)}`);
      }
      return;
    }

    const target = action === "assign"
      ? String(args[1] || "").trim()
      : String(args[0] || "").trim();
    const profile = action === "assign"
      ? String(args[2] || "").trim()
      : String(args[1] || "").trim();
    if (!target || !profile) {
      logMessage("error", "{white-fg}✗{/white-fg} Usage: /role assign <agent-id|nickname> <prompt-profile>");
      logMessage("error", "       /role <agent-id|nickname> <prompt-profile>");
      logMessage("error", "       /role list");
      return;
    }

    try {
      send({
        type: IPC_REQUEST_TYPES.ASSIGN_ROLE,
        target,
        prompt_profile: profile,
      });
      schedule(requestStatus, 1000);
    } catch (err) {
      logMessage("error", `{white-fg}✗{/white-fg} Role assignment failed: ${escapeBlessed(err.message)}`);
    }
  }

  async function handleSoloCommand(args = []) {
    const subcommand = String(args[0] || "").trim().toLowerCase();
    if (!subcommand) {
      logMessage("error", "{white-fg}✗{/white-fg} Usage: /solo <run|list> ...");
      return;
    }

    if (subcommand === "list" || subcommand === "ls") {
      try {
        const registry = loadPromptProfileRegistry(projectRoot);
        const profiles = registry.profiles || [];
        if (profiles.length === 0) {
          logMessage("system", "{white-fg}⚙{/white-fg} No solo roles found.");
          return;
        }
        logMessage("system", `{white-fg}⚙{/white-fg} Available solo roles (${profiles.length}):`);
        for (const p of profiles) {
          const aliases = p.aliases && p.aliases.length > 0 ? ` {gray-fg}(${p.aliases.join(", ")}){/gray-fg}` : "";
          const source = p.source ? ` {cyan-fg}[${p.source}]{/cyan-fg}` : "";
          const summary = p.summary ? `  ${p.summary}` : "";
          logMessage("system", `  {bold}${escapeBlessed(p.id)}{/bold}${aliases}${source}`);
          if (summary) {
            logMessage("system", `    ${escapeBlessed(summary)}`);
          }
        }
      } catch (err) {
        logMessage("error", `{white-fg}✗{/white-fg} Failed to list solo roles: ${escapeBlessed(err.message)}`);
      }
      return;
    }

    if (subcommand !== "run") {
      logMessage("error", `{white-fg}✗{/white-fg} Unknown solo action: ${escapeBlessed(subcommand)}`);
      return;
    }

    const profile = String(args[1] || "").trim();
    if (!profile) {
      logMessage("error", "{white-fg}✗{/white-fg} Usage: /solo run <prompt-profile> [agent=codex|claude|ucode] [nickname=<name>] [scope=inplace|window]");
      return;
    }

    const parsedOptions = {};
    for (let i = 2; i < args.length; i += 1) {
      const arg = args[i];
      if (arg.includes("=")) {
        const [key, value] = arg.split("=", 2);
        parsedOptions[key] = value;
      }
    }

    function normalizeLaunchScopeOption(value, fallback = "inplace") {
      const raw = String(value || "").trim().toLowerCase();
      if (!raw) return fallback;
      if (raw === "inplace" || raw === "same" || raw === "current" || raw === "tab" || raw === "pane") {
        return "inplace";
      }
      if (raw === "window" || raw === "separate" || raw === "new" || raw === "new-window" || raw === "external") {
        return "window";
      }
      return "";
    }

    const config = loadConfig(projectRoot);
    const agent = resolveSoloAgentType(config, parsedOptions.agent || parsedOptions.type || "");
    const nickname = String(parsedOptions.nickname || "").trim();
    const scopeRaw = parsedOptions.scope || parsedOptions.launch_scope || "";
    const launchScope = normalizeLaunchScopeOption(scopeRaw, "inplace");
    if (scopeRaw && !launchScope) {
      logMessage("error", "{white-fg}✗{/white-fg} scope must be inplace|window");
      return;
    }

    try {
      send({
        type: IPC_REQUEST_TYPES.LAUNCH_AGENT,
        agent: agent === "ucode" ? "ufoo" : agent,
        count: 1,
        nickname,
        prompt_profile: profile,
        launch_scope: launchScope,
        ...collectHostLaunchRequestContext(),
      });
      schedule(requestStatus, 1000);
    } catch (err) {
      logMessage("error", `{white-fg}✗{/white-fg} Solo launch failed: ${escapeBlessed(err.message)}`);
    }
  }

  async function handleResumeCommand(args = []) {
    const action = String(args[0] || "").toLowerCase();
    if (action === "list" || action === "ls") {
      const target = args[1] || "";
      const label = target ? ` (${target})` : "";
      logMessage("system", `{white-fg}⚙{/white-fg} Listing recoverable agents${label}...`);
      send({ type: IPC_REQUEST_TYPES.LIST_RECOVERABLE_AGENTS, target });
      schedule(requestStatus, 1000);
      return;
    }

    const target = args[0] || "";
    const label = target ? ` (${target})` : "";
    logMessage("system", `{white-fg}⚙{/white-fg} Resuming agents${label}...`);
    send({ type: IPC_REQUEST_TYPES.RESUME_AGENTS, target });
    schedule(requestStatus, 1000);
  }

  async function handleProjectCommand(args = []) {
    const subcommand = String(args[0] || "list").trim().toLowerCase();

    if (subcommand === "list") {
      const rowsRaw = await Promise.resolve(listProjects());
      const rows = (Array.isArray(rowsRaw) ? rowsRaw : []).filter((row) => {
        if (!globalMode) return true;
        const root = row && row.project_root ? String(row.project_root) : "";
        return !isGlobalControllerProjectRoot(root);
      });
      const current = await Promise.resolve(getCurrentProject());
      const currentRoot = current && current.project_root ? String(current.project_root) : "";
      if (rows.length === 0) {
        logMessage("system", "{white-fg}No projects found{/white-fg}");
        return;
      }
      logMessage("system", `{cyan-fg}Projects:{/cyan-fg} ${rows.length}`);
      rows.forEach((item, idx) => {
        const row = item || {};
        const root = String(row.project_root || "");
        const name = String(row.project_name || root || "-");
        const status = String(row.status || "unknown");
        const marker = root && root === currentRoot ? "*" : " ";
        logMessage(
          "system",
          `${marker}${idx + 1}. {cyan-fg}${escapeBlessed(name)}{/cyan-fg} [{white-fg}${escapeBlessed(status)}{/white-fg}] ${escapeBlessed(root)}`
        );
      });
      return;
    }

    if (subcommand === "current") {
      const current = await Promise.resolve(getCurrentProject());
      if (!current || !current.project_root) {
        logMessage("error", "{white-fg}✗{/white-fg} Current project unavailable");
        return;
      }
      if (globalMode && isGlobalControllerProjectRoot(current.project_root)) {
        logMessage(
          "system",
          `{cyan-fg}Current:{/cyan-fg} global controller (${escapeBlessed(resolveGlobalControllerUfooDir())})`
        );
        return;
      }
      logMessage("system", `{cyan-fg}Current:{/cyan-fg} ${escapeBlessed(current.project_root)}`);
      return;
    }

    if (subcommand === "switch") {
      const target = args.slice(1).join(" ").trim();
      if (!target) {
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /project switch <index|path>");
        return;
      }
      logMessage("system", `{white-fg}⚙{/white-fg} Switching project: ${escapeBlessed(target)}`);
      const result = await Promise.resolve(switchProject({ target }));
      if (!result || result.ok !== true) {
        const reason = result && result.error ? String(result.error) : "switch failed";
        logMessage("error", `{white-fg}✗{/white-fg} Switch failed: ${escapeBlessed(reason)}`);
        return;
      }
      const nextRoot = result.project_root || result.projectRoot || "";
      logMessage("system", `{white-fg}✓{/white-fg} Switched project: ${escapeBlessed(nextRoot)}`);
      return;
    }

    logMessage("error", "{white-fg}✗{/white-fg} Unknown project command. Use: list, current, switch");
  }

  async function handleOpenCommand(args = []) {
    if (!globalMode) {
      logMessage("error", "{white-fg}✗{/white-fg} /open is only available in global mode");
      return;
    }
    const target = args.join(" ").trim();
    if (!target) {
      logMessage("error", "{white-fg}✗{/white-fg} Usage: /open <path>");
      return;
    }
    logMessage("system", `{white-fg}⚙{/white-fg} Opening project: ${escapeBlessed(target)}`);
    const result = await Promise.resolve(switchProject({ target }));
    if (!result || result.ok !== true) {
      const reason = result && result.error ? String(result.error) : "open failed";
      logMessage("error", `{white-fg}✗{/white-fg} Open failed: ${escapeBlessed(reason)}`);
      return;
    }
    const nextRoot = result.project_root || result.projectRoot || "";
    logMessage("system", `{white-fg}✓{/white-fg} Opened project: ${escapeBlessed(nextRoot)}`);
  }

  function parseKeyValueArgs(args = []) {
    const parsed = {};
    for (const raw of args) {
      if (!raw || !String(raw).includes("=")) continue;
      const [keyRaw, ...valueParts] = String(raw).split("=");
      const key = String(keyRaw || "").trim().toLowerCase();
      const value = valueParts.join("=").trim();
      if (!key) continue;
      parsed[key] = value;
    }
    return parsed;
  }

  function parseCronTargets(raw = "") {
    return String(raw || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function parseCronAtMs(raw = "") {
    const text = String(raw || "").trim();
    if (!text) return 0;

    if (/^\d+$/.test(text)) {
      const value = Number.parseInt(text, 10);
      if (!Number.isFinite(value) || value <= 0) return 0;
      return text.length <= 10 ? value * 1000 : value;
    }

    const normalized = text.replace(/\//g, "-");
    const directMatch = normalized.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
    if (directMatch) {
      const seconds = directMatch[3] || "00";
      const parsed = Date.parse(`${directMatch[1]}T${directMatch[2]}:${seconds}`);
      return Number.isFinite(parsed) ? parsed : 0;
    }

    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatCronAt(ms = 0) {
    const ts = Number(ms) || 0;
    if (ts <= 0) return "";
    const d = new Date(ts);
    const pad = (v) => String(v).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function handleCronCommand(args = []) {
    const action = String(args[0] || "").trim().toLowerCase();
    if (action === "list" || action === "ls") {
      if (typeof requestCron === "function") {
        requestCron({ operation: "list" });
        schedule(requestStatus, 200);
        return;
      }
      const tasks = Array.isArray(listCronTasks()) ? listCronTasks() : [];
      if (tasks.length === 0) {
        logMessage("system", "{cyan-fg}Cron:{/cyan-fg} none");
        return;
      }
      logMessage("system", `{cyan-fg}Cron:{/cyan-fg} ${tasks.length} task(s)`);
      for (const task of tasks) {
        logMessage("system", `  • ${task.summary || task.id}`);
      }
      return;
    }

    if (action === "stop" || action === "rm" || action === "remove") {
      const target = String(args[1] || "").trim();
      if (!target) {
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /cron stop <id|all>");
        return;
      }
      if (typeof requestCron === "function") {
        requestCron({ operation: "stop", id: target });
        schedule(requestStatus, 200);
        return;
      }
      if (target === "all") {
        const tasks = Array.isArray(listCronTasks()) ? listCronTasks() : [];
        let stopped = 0;
        for (const task of tasks) {
          if (task && task.id && stopCronTask(task.id)) stopped += 1;
        }
        logMessage("system", `{white-fg}✓{/white-fg} Stopped ${stopped} cron task(s)`);
        return;
      }
      if (!stopCronTask(target)) {
        logMessage("error", `{white-fg}✗{/white-fg} Cron task not found: ${target}`);
        return;
      }
      logMessage("system", `{white-fg}✓{/white-fg} Stopped cron task ${target}`);
      return;
    }

    const startArgs = action === "start" ? args.slice(1) : args;
    const kv = parseKeyValueArgs(startArgs);
    const nonKvParts = startArgs.filter((item) => !String(item || "").includes("="));

    const intervalRaw = String(
      kv.every || kv.interval || kv.interval_ms || kv.ms || ""
    ).trim();
    const atRaw = String(
      kv.at ||
      kv.once ||
      kv.run_at ||
      kv.runat ||
      kv.datetime ||
      kv.date_time ||
      ((kv.date && kv.time) ? `${kv.date} ${kv.time}` : "") ||
      ""
    ).trim();
    const targetsRaw = String(
      kv.target || kv.targets || kv.agent || kv.agents || ""
    ).trim();
    const title = String(
      kv.title || kv.name || kv.label || ""
    ).trim();
    const prompt = String(
      kv.prompt || kv.message || kv.msg || nonKvParts.join(" ") || ""
    ).trim();

    if ((!intervalRaw && !atRaw) || !targetsRaw || !prompt) {
      logMessage(
        "error",
        "{white-fg}✗{/white-fg} Usage: /cron start every=<10s|5m> or at=\"YYYY-MM-DD HH:mm\" target=<agent1,agent2> [title=\"...\"] prompt=\"...\""
      );
      return;
    }

    if (intervalRaw && atRaw) {
      logMessage("error", "{white-fg}✗{/white-fg} Use either every=... or at=..., not both");
      return;
    }

    const intervalMs = intervalRaw ? parseIntervalMs(intervalRaw) : 0;
    if (intervalRaw && (!Number.isFinite(intervalMs) || intervalMs < 1000)) {
      logMessage("error", "{white-fg}✗{/white-fg} Invalid interval (min 1s)");
      return;
    }

    const atMs = atRaw ? parseCronAtMs(atRaw) : 0;
    if (atRaw && (!Number.isFinite(atMs) || atMs <= 0)) {
      logMessage("error", "{white-fg}✗{/white-fg} Invalid one-time schedule, use at=\"YYYY-MM-DD HH:mm\"");
      return;
    }
    if (atMs > 0 && atMs <= Date.now()) {
      logMessage("error", "{white-fg}✗{/white-fg} One-time schedule must be in the future");
      return;
    }

    const targets = parseCronTargets(targetsRaw);
    if (targets.length === 0) {
      logMessage("error", "{white-fg}✗{/white-fg} At least one target agent is required");
      return;
    }

    if (typeof requestCron === "function") {
      const request = {
        operation: "start",
        targets,
        prompt,
      };
      if (title) request.title = title;
      if (atMs > 0) {
        request.once_at_ms = atMs;
      } else {
        request.interval_ms = intervalMs;
      }
      requestCron(request);
      schedule(requestStatus, 200);
      return;
    }

    if (atMs > 0) {
      logMessage("error", "{white-fg}✗{/white-fg} One-time cron requires daemon-backed scheduler");
      return;
    }

    const taskPayload = {
      intervalMs,
      targets,
      prompt,
    };
    if (title) taskPayload.title = title;
    const task = createCronTask(taskPayload);
    if (!task) {
      logMessage("error", "{white-fg}✗{/white-fg} Failed to create cron task");
      return;
    }

    logMessage(
      "system",
      `{white-fg}✓{/white-fg} Cron started ${task.id}: ${task.label || `${atMs > 0 ? `at ${formatCronAt(atMs)}` : `every ${formatIntervalMs(intervalMs)}`} -> ${targets.join(", ")}`}`
    );
  }

  function parseBooleanOption(value, fallback = false) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return fallback;
    if (text === "1" || text === "true" || text === "yes" || text === "y" || text === "on") return true;
    if (text === "0" || text === "false" || text === "no" || text === "n" || text === "off") return false;
    return fallback;
  }

  function logGroupCoreOutput(text) {
    const lines = String(text || "").split(/\r?\n/);
    lines.forEach((line) => {
      logMessage("system", escapeBlessed(line));
    });
  }

  async function handleGroupCommand(args = []) {
    const subcommand = String(args[0] || "").trim().toLowerCase();
    if (!subcommand) {
      logMessage(
        "error",
        "{white-fg}✗{/white-fg} Usage: /group <templates|template|run|status|stop|diagram> ..."
      );
      return;
    }

    if (subcommand === "templates") {
      const action = String(args[1] || "list").trim().toLowerCase();
      if (action !== "list" && action !== "ls") {
        logMessage("error", `{white-fg}✗{/white-fg} Unknown group templates action: ${escapeBlessed(action)}`);
        return;
      }
      try {
        await runGroupCore("templates", [action], {
          cwd: projectRoot,
          write: logGroupCoreOutput,
        });
      } catch (err) {
        logMessage("error", `{white-fg}✗{/white-fg} Group templates failed: ${escapeBlessed(err.message)}`);
      }
      return;
    }

    if (subcommand === "template") {
      const action = String(args[1] || "list").trim().toLowerCase();
      if (action === "validate") {
        const target = String(args[2] || "").trim();
        if (!target) {
          logMessage("error", "{white-fg}✗{/white-fg} Usage: /group template validate <alias|path>");
          return;
        }
        send({
          type: IPC_REQUEST_TYPES.GROUP_TEMPLATE_VALIDATE,
          target,
          alias: target,
          path: target,
        });
        return;
      }
      try {
        await runGroupCore("template", [action, ...args.slice(2)], {
          cwd: projectRoot,
          write: logGroupCoreOutput,
        });
      } catch (err) {
        logMessage("error", `{white-fg}✗{/white-fg} Group template failed: ${escapeBlessed(err.message)}`);
      }
      return;
    }

    if (subcommand === "run") {
      const alias = String(args[1] || "").trim();
      if (!alias) {
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /group run <alias> [instance=<name>] [dry_run=true]");
        return;
      }
      const runArgs = args.slice(2);
      const kv = parseKeyValueArgs(runArgs);
      let instance = String(kv.instance || kv.group_id || "").trim();
      const instanceIndex = runArgs.indexOf("--instance");
      if (instanceIndex !== -1) {
        instance = String(runArgs[instanceIndex + 1] || "").trim();
      }
      let dryRun = runArgs.includes("--dry-run");
      if (!dryRun && Object.prototype.hasOwnProperty.call(kv, "dry_run")) {
        dryRun = parseBooleanOption(kv.dry_run, false);
      }
      if (!dryRun && Object.prototype.hasOwnProperty.call(kv, "dryrun")) {
        dryRun = parseBooleanOption(kv.dryrun, false);
      }
      send({
        type: IPC_REQUEST_TYPES.LAUNCH_GROUP,
        alias,
        instance,
        dry_run: dryRun,
        ...collectHostLaunchRequestContext(),
      });
      schedule(requestStatus, 1000);
      return;
    }

    if (subcommand === "status") {
      const statusArgs = args.slice(1);
      const kv = parseKeyValueArgs(statusArgs);
      const groupId = String(
        kv.group_id ||
        kv.group ||
        (statusArgs[0] && !String(statusArgs[0]).includes("=") ? statusArgs[0] : "")
      ).trim();
      send({
        type: IPC_REQUEST_TYPES.GROUP_STATUS,
        group_id: groupId,
      });
      return;
    }

    if (subcommand === "stop") {
      const stopArgs = args.slice(1);
      const kv = parseKeyValueArgs(stopArgs);
      const groupId = String(
        kv.group_id ||
        kv.group ||
        (stopArgs[0] && !String(stopArgs[0]).includes("=") ? stopArgs[0] : "")
      ).trim();
      if (!groupId) {
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /group stop <groupId>");
        return;
      }
      send({
        type: IPC_REQUEST_TYPES.STOP_GROUP,
        group_id: groupId,
      });
      schedule(requestStatus, 1000);
      return;
    }

    if (subcommand === "diagram") {
      const diagramArgs = args.slice(1);
      const kv = parseKeyValueArgs(diagramArgs);
      const target = String(
        kv.group_id ||
        kv.group ||
        kv.alias ||
        (diagramArgs[0] && !String(diagramArgs[0]).includes("=") ? diagramArgs[0] : "")
      ).trim();
      if (!target) {
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /group diagram <alias|groupId> [format=ascii|mermaid]");
        return;
      }
      const format = diagramArgs.includes("--mermaid")
        ? "mermaid"
        : (diagramArgs.includes("--ascii")
          ? "ascii"
          : String(kv.format || "ascii").trim().toLowerCase());
      send({
        type: IPC_REQUEST_TYPES.GROUP_DIAGRAM,
        alias: target,
        group_id: target,
        format: format === "mermaid" ? "mermaid" : "ascii",
      });
      return;
    }

    logMessage(
      "error",
      "{white-fg}✗{/white-fg} Unknown group command. Use: templates, template, run, status, stop, diagram"
    );
  }

  async function handleSettingsCommand(args = []) {
    const section = String(args[0] || "").trim().toLowerCase();
    if (!section) {
      logMessage("error", "{white-fg}✗{/white-fg} Usage: /settings ucode [show|set|clear ...]");
      return;
    }

    if (section === "ucode") {
      const subArgs = args.slice(1);
      if (subArgs.length === 0) {
        await handleUcodeConfigCommand(["show"]);
      } else {
        await handleUcodeConfigCommand(subArgs);
      }
      return;
    }

    logMessage("error", "{white-fg}✗{/white-fg} Unknown settings section. Use: ucode");
  }

  function parseUcodeConfigKv(args = []) {
    return parseKeyValueArgs(args);
  }

  function maskSecret(value = "") {
    const text = String(value || "");
    if (!text) return "(unset)";
    if (text.length <= 8) return "***";
    return `${text.slice(0, 4)}...${text.slice(-4)}`;
  }

  function inferUcodeTransport(provider = "", url = "") {
    return resolveTransport({
      provider: String(provider || "").trim(),
      baseUrl: String(url || "").trim(),
    });
  }

  async function handleUfooCommand(args = []) {
    // Handle /ufoo command (session marker from daemon)
    // When daemon sends /ufoo <marker>, we should just check for pending messages
    if (args.length > 0) {
      // This is a probe marker, check for pending messages
      const subscriberId = process.env.UFOO_SUBSCRIBER_ID;
      if (subscriberId) {
        try {
          const bus = createBus(projectRoot);
          bus.ensureBus();
          const pendingMessages = bus.checkMessages(subscriberId);
          if (pendingMessages && pendingMessages.length > 0) {
            logMessage("system", `{cyan-fg}[bus]{/cyan-fg} ${pendingMessages.length} pending message(s)`);
          }
        } catch {
          // Ignore errors when checking messages
        }
      }
      // Don't log anything else for probe markers
      return;
    }

    // Without arguments, show ufoo protocol documentation
    logMessage("system", "{cyan-fg}ufoo Protocol{/cyan-fg}");
    logMessage("system", "");
    logMessage("system", "This project uses ufoo for agent coordination:");
    logMessage("system", "  • Context decisions: /ctx");
    logMessage("system", "  • Event bus: /bus");
    logMessage("system", "  • Initialize: /init");
    logMessage("system", "");
    logMessage("system", "For detailed documentation, see .ufoo/docs/");
  }

  async function handleUcodeConfigCommand(args = []) {
    const first = String(args[0] || "").trim().toLowerCase();
    const hasInlineKv = args.some((item) => String(item || "").includes("="));
    const action = (!first || hasInlineKv) ? "set" : first;

    if (action === "show" || action === "status") {
      const config = loadUcodeConfig() || {};
      const provider = String(config.ucodeProvider || "").trim();
      const model = String(config.ucodeModel || "").trim();
      const url = String(config.ucodeBaseUrl || "").trim();
      const key = String(config.ucodeApiKey || "").trim();
      const transport = inferUcodeTransport(provider, url);
      logMessage("system", "{cyan-fg}ucode config:{/cyan-fg}");
      logMessage("system", `  • provider: ${provider || "(unset)"}`);
      logMessage("system", `  • model: ${model || "(unset)"}`);
      logMessage("system", `  • url: ${url || "(unset)"}`);
      logMessage("system", `  • key: ${maskSecret(key)}`);
      logMessage("system", `  • transport: ${transport} (auto)`);
      logMessage("system", "  • tip: url supports generic gateway base, transport is auto-detected");
      return;
    }

    if (action === "set") {
      const kvArgs = hasInlineKv ? args : args.slice(1);
      const kv = parseUcodeConfigKv(kvArgs);
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(kv, "provider")) updates.ucodeProvider = String(kv.provider || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "model")) updates.ucodeModel = String(kv.model || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "url")) updates.ucodeBaseUrl = String(kv.url || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "baseurl")) updates.ucodeBaseUrl = String(kv.baseurl || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "base_url")) updates.ucodeBaseUrl = String(kv.base_url || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "key")) updates.ucodeApiKey = String(kv.key || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "apikey")) updates.ucodeApiKey = String(kv.apikey || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "api_key")) updates.ucodeApiKey = String(kv.api_key || "").trim();
      if (Object.prototype.hasOwnProperty.call(kv, "token")) updates.ucodeApiKey = String(kv.token || "").trim();

      if (Object.keys(updates).length === 0) {
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /settings ucode set provider=<openai|anthropic> model=<id> url=<baseUrl> key=<apiKey>");
        return;
      }
      saveUcodeConfig(updates);
      logMessage("system", "{white-fg}✓{/white-fg} ucode config updated (global)");
      if (Object.prototype.hasOwnProperty.call(updates, "ucodeProvider")) {
        logMessage("system", `  • provider: ${updates.ucodeProvider || "(unset)"}`);
      }
      if (Object.prototype.hasOwnProperty.call(updates, "ucodeModel")) {
        logMessage("system", `  • model: ${updates.ucodeModel || "(unset)"}`);
      }
      if (Object.prototype.hasOwnProperty.call(updates, "ucodeBaseUrl")) {
        logMessage("system", `  • url: ${updates.ucodeBaseUrl || "(unset)"}`);
      }
      if (Object.prototype.hasOwnProperty.call(updates, "ucodeApiKey")) {
        logMessage("system", `  • key: ${maskSecret(updates.ucodeApiKey)}`);
      }
      const nextConfig = loadUcodeConfig() || {};
      logMessage("system", `  • transport: ${inferUcodeTransport(nextConfig.ucodeProvider, nextConfig.ucodeBaseUrl)} (auto)`);
      return;
    }

    if (action === "clear") {
      const fieldsRaw = args.slice(1).map((item) => String(item || "").trim().toLowerCase()).filter(Boolean);
      const fields = fieldsRaw.length === 0 ? ["all"] : fieldsRaw;
      const updates = {};
      const clearAll = fields.includes("all");
      if (clearAll || fields.includes("provider")) updates.ucodeProvider = "";
      if (clearAll || fields.includes("model")) updates.ucodeModel = "";
      if (clearAll || fields.includes("url") || fields.includes("baseurl") || fields.includes("base_url")) updates.ucodeBaseUrl = "";
      if (clearAll || fields.includes("key") || fields.includes("apikey") || fields.includes("api_key") || fields.includes("token")) updates.ucodeApiKey = "";
      if (Object.keys(updates).length === 0) {
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /settings ucode clear [provider|model|url|key|all]");
        return;
      }
      saveUcodeConfig(updates);
      logMessage("system", "{white-fg}✓{/white-fg} ucode config cleared (global)");
      return;
    }

    logMessage("error", "{white-fg}✗{/white-fg} Unknown settings ucode action. Use: show, set, clear");
  }

  async function executeCommand(text) {
    const parsed = parseCommand(text);
    if (!parsed) return false;

    const { command, args } = parsed;

    switch (command) {
      case "doctor":
        await handleDoctorCommand();
        return true;
      case "status":
        await handleStatusCommand();
        return true;
      case "daemon":
        await handleDaemonCommand(args);
        return true;
      case "init":
        await handleInitCommand(args);
        return true;
      case "bus":
        await handleBusCommand(args);
        return true;
      case "ctx":
        await handleCtxCommand(args);
        return true;
      case "skills":
        await handleSkillsCommand(args);
        return true;
      case "launch":
        await handleLaunchCommand(args);
        return true;
      case "open":
        await handleOpenCommand(args);
        return true;
      case "resume":
        await handleResumeCommand(args);
        return true;
      case "project":
        await handleProjectCommand(args);
        return true;
      case "role":
        await handleRoleCommand(args);
        return true;
      case "solo":
        await handleSoloCommand(args);
        return true;
      case "cron":
        await handleCronCommand(args);
        return true;
      case "group":
        await handleGroupCommand(args);
        return true;
      case "settings":
        await handleSettingsCommand(args);
        return true;
      case "ufoo":
        await handleUfooCommand(args);
        return true;
      default:
        logMessage("error", `{white-fg}✗{/white-fg} Unknown command: /${command}`);
        return true;
    }
  }

  return {
    executeCommand,
    handleDoctorCommand,
    handleStatusCommand,
    handleDaemonCommand,
    handleInitCommand,
    handleBusCommand,
    handleCtxCommand,
    handleSkillsCommand,
    handleLaunchCommand,
    handleOpenCommand,
    handleResumeCommand,
    handleProjectCommand,
    handleRoleCommand,
    handleSoloCommand,
    handleCronCommand,
    handleGroupCommand,
    handleSettingsCommand,
    handleUcodeConfigCommand,
    handleUfooCommand,
  };
}

module.exports = {
  createCommandExecutor,
  collectHostLaunchRequestContext,
};

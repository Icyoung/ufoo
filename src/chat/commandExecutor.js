const path = require("path");
const EventBus = require("../bus");
const { IPC_REQUEST_TYPES } = require("../shared/eventContract");
const UfooInit = require("../init");
const { loadConfig: loadProjectConfig, saveConfig: saveProjectConfig, loadGlobalUcodeConfig, saveGlobalUcodeConfig } = require("../config");
const { resolveTransport } = require("../code/nativeRunner");
const { parseIntervalMs, formatIntervalMs } = require("./cronScheduler");

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
      logMessage("system", "{white-fg}⚙{/white-fg} Restarting daemon...");
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
        if (args.length < 3) {
          logMessage("error", "{white-fg}✗{/white-fg} Usage: /bus send <target> <message>");
          return;
        }
        const target = args[1];
        const message = args.slice(2).join(" ");
        send({ type: IPC_REQUEST_TYPES.BUS_SEND, target, message });
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
      logMessage("error", "{white-fg}✗{/white-fg} Usage: /launch <claude|codex|ucode> [nickname=<name>] [count=<n>]");
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

    const nickname = parsedOptions.nickname || "";
    const count = parseInt(parsedOptions.count || "1", 10);
    if (nickname && count > 1) {
      logMessage("error", "{white-fg}✗{/white-fg} nickname requires count=1");
      return;
    }

    try {
      const label = nickname ? ` (${nickname})` : "";
      logMessage("system", `{white-fg}⚙{/white-fg} Launching ${normalizedAgent}${label}...`);
      send({
        type: IPC_REQUEST_TYPES.LAUNCH_AGENT,
        agent: normalizedAgent,
        count: Number.isFinite(count) ? count : 1,
        nickname,
      });
      schedule(requestStatus, 1000);
    } catch (err) {
      logMessage("error", `{white-fg}✗{/white-fg} Launch failed: ${escapeBlessed(err.message)}`);
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

  function parseCronTargets(raw = "") {
    return String(raw || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function handleCornCommand(args = []) {
    const action = String(args[0] || "").trim().toLowerCase();
    if (action === "list" || action === "ls") {
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
        logMessage("error", "{white-fg}✗{/white-fg} Usage: /corn stop <id|all>");
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
    const kv = parseUcodeConfigKv(startArgs);
    const nonKvParts = startArgs.filter((item) => !String(item || "").includes("="));

    const intervalRaw = String(
      kv.every || kv.interval || kv.interval_ms || kv.ms || ""
    ).trim();
    const targetsRaw = String(
      kv.target || kv.targets || kv.agent || kv.agents || ""
    ).trim();
    const prompt = String(
      kv.prompt || kv.message || kv.msg || nonKvParts.join(" ") || ""
    ).trim();

    if (!intervalRaw || !targetsRaw || !prompt) {
      logMessage(
        "error",
        "{white-fg}✗{/white-fg} Usage: /corn start every=<10s|5m> target=<agent1,agent2> prompt=\"...\""
      );
      return;
    }

    const intervalMs = parseIntervalMs(intervalRaw);
    if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      logMessage("error", "{white-fg}✗{/white-fg} Invalid interval (min 1s)");
      return;
    }

    const targets = parseCronTargets(targetsRaw);
    if (targets.length === 0) {
      logMessage("error", "{white-fg}✗{/white-fg} At least one target agent is required");
      return;
    }

    const task = createCronTask({
      intervalMs,
      targets,
      prompt,
    });
    if (!task) {
      logMessage("error", "{white-fg}✗{/white-fg} Failed to create cron task");
      return;
    }

    logMessage(
      "system",
      `{white-fg}✓{/white-fg} Cron started ${task.id}: every ${formatIntervalMs(intervalMs)} -> ${targets.join(", ")}`
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
      case "resume":
        await handleResumeCommand(args);
        return true;
      case "corn":
        await handleCornCommand(args);
        return true;
      case "settings":
        await handleSettingsCommand(args);
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
    handleResumeCommand,
    handleCornCommand,
    handleSettingsCommand,
    handleUcodeConfigCommand,
  };
}

module.exports = {
  createCommandExecutor,
};

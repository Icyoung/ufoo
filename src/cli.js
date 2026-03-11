const path = require("path");
const { spawnSync } = require("child_process");
const net = require("net");
const fs = require("fs");
const { socketPath, isRunning } = require("./daemon");
const { runBusCoreCommand } = require("./cli/busCoreCommands");
const { runCtxCommand } = require("./cli/ctxCoreCommands");
const { runOnlineCommand } = require("./cli/onlineCoreCommands");
const { runGroupCoreCommand } = require("./cli/groupCoreCommands");
const { listProjectRuntimes, getCurrentProjectRuntime } = require("./projects/registry");
const { canonicalProjectRoot, buildProjectId } = require("./projects/projectId");
const { getUfooPaths } = require("./ufoo/paths");

function getPackageRoot() {
  return path.resolve(__dirname, "..");
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    stdio: "inherit",
    ...options,
  });
  if (res.error) throw res.error;
  if (typeof res.status === "number" && res.status !== 0) {
    const e = new Error(`${cmd} exited with code ${res.status}`);
    e.code = res.status;
    throw e;
  }
}

function getPackageScript(rel) {
  return path.join(getPackageRoot(), rel);
}

function connectSocket(sockPath) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => resolve(client));
    client.on("error", reject);
  });
}

async function connectWithRetry(sockPath, retries, delayMs) {
  for (let i = 0; i < retries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const client = await connectSocket(sockPath);
      return client;
    } catch {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
}

async function ensureDaemonRunning(projectRoot) {
  if (isRunning(projectRoot)) return;
  const repoRoot = getPackageRoot();
  run(process.execPath, [path.join(repoRoot, "bin", "ufoo.js"), "daemon", "start"]);
  const sock = socketPath(projectRoot);
  for (let i = 0; i < 30; i += 1) {
    if (fs.existsSync(sock)) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Failed to start ufoo daemon");
}

async function sendDaemonRequest(projectRoot, payload) {
  const sock = socketPath(projectRoot);
  const client = await connectWithRetry(sock, 25, 200);
  if (!client) {
    throw new Error("Failed to connect to ufoo daemon");
  }
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      try {
        client.destroy();
      } catch {
        // ignore
      }
      reject(new Error("Daemon request timeout"));
    }, 8000);
    const cleanup = () => {
      clearTimeout(timeout);
      client.removeAllListeners();
      try {
        client.end();
      } catch {
        // ignore
      }
    };
    client.on("data", (data) => {
      buffer += data.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.type === "response" || msg.type === "error") {
          cleanup();
          if (msg.type === "error") {
            reject(new Error(msg.error || "Daemon error"));
          } else {
            resolve(msg);
          }
          return;
        }
      }
    });
    client.on("error", (err) => {
      cleanup();
      reject(err);
    });
    client.write(`${JSON.stringify(payload)}\n`);
  });
}

function requireOptional(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(name);
  } catch {
    return null;
  }
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

function collectOption(value, previous) {
  const next = Array.isArray(previous) ? previous.slice() : [];
  const parts = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return next.concat(parts);
}

function collectOptionValues(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== name) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    values.push(value);
    i += 1;
  }
  return values;
}

function parseJsonObject(text, fallback = {}) {
  const raw = String(text || "").trim();
  if (!raw) return fallback;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected JSON object");
  }
  return parsed;
}

function formatProjectRuntimeLine(row, index = 0) {
  const idx = String(index + 1).padStart(2, " ");
  const name = String(row.project_name || "-");
  const status = String(row.status || "-");
  const seen = row.last_seen || "-";
  const projectRoot = String(row.project_root || "-");
  return `${idx}. ${name}  [${status}]  last_seen=${seen}  ${projectRoot}`;
}

function printProjectList(rows = [], write = (line) => console.log(line)) {
  if (!Array.isArray(rows) || rows.length === 0) {
    write("No projects found.");
    return;
  }
  write("=== Projects ===");
  rows.forEach((row, index) => {
    write(formatProjectRuntimeLine(row, index));
  });
}

function buildCurrentProjectFallback(projectRoot) {
  let canonical = "";
  let projectId = "";
  try {
    canonical = canonicalProjectRoot(projectRoot);
  } catch {
    canonical = path.resolve(projectRoot || process.cwd());
  }
  try {
    projectId = buildProjectId(canonical);
  } catch {
    projectId = "";
  }
  const paths = getUfooPaths(canonical);
  return {
    version: 1,
    project_id: projectId || null,
    project_root: canonical,
    project_name: path.basename(canonical) || canonical,
    daemon_pid: null,
    socket_path: paths.ufooSock,
    status: "untracked",
    last_seen: null,
  };
}

function printCurrentProject(runtime, write = (line) => console.log(line)) {
  const row = runtime || {};
  write("=== Current Project ===");
  write(`name: ${row.project_name || "-"}`);
  write(`status: ${row.status || "-"}`);
  write(`path: ${row.project_root || "-"}`);
  write(`daemon_pid: ${row.daemon_pid || "-"}`);
  write(`socket: ${row.socket_path || "-"}`);
  write(`last_seen: ${row.last_seen || "-"}`);
}

function projectSwitchV1Error() {
  const err = new Error("project switch is chat-only in v1");
  err.code = "UFOO_PROJECT_SWITCH_CHAT_ONLY";
  err.exitCode = 2;
  return err;
}

function runProjectCommand({
  subcommand = "list",
  outputJson = false,
  cwd = process.cwd(),
  write = (line) => console.log(line),
  writeError = (line) => console.error(line),
} = {}) {
  const sub = String(subcommand || "list").trim().toLowerCase();
  try {
    if (sub === "list") {
      const rows = listProjectRuntimes({ validate: true, cleanupTmp: true });
      if (outputJson) {
        write(JSON.stringify(rows, null, 2));
        return 0;
      }
      printProjectList(rows, write);
      return 0;
    }
    if (sub === "current") {
      const current = getCurrentProjectRuntime(cwd, { validate: true })
        || buildCurrentProjectFallback(cwd);
      if (outputJson) {
        write(JSON.stringify(current, null, 2));
        return 0;
      }
      printCurrentProject(current, write);
      return 0;
    }
    if (sub === "switch") {
      const err = projectSwitchV1Error();
      writeError(err.message);
      return err.exitCode || 2;
    }
    writeError("project requires list|current|switch subcommand");
    return 1;
  } catch (err) {
    writeError(err.message || String(err));
    return 1;
  }
}

function normalizeReportPhase(action = "") {
  const value = String(action || "").trim().toLowerCase();
  if (value === "start") return "start";
  if (value === "progress") return "progress";
  if (value === "error" || value === "fail" || value === "failed") return "error";
  if (value === "done" || value === "finish" || value === "finished") return "done";
  return "";
}

function resolveOnlineAuthToken(opts) {
  if (!opts) return "";
  if (opts.authToken) return opts.authToken;
  let tokens = null;
  try {
    // eslint-disable-next-line global-require
    tokens = require("./online/tokens");
  } catch {
    return "";
  }
  const filePath = opts.tokenFile || tokens.defaultTokensPath();
  let entry = null;
  if (opts.subscriber) entry = tokens.getToken(filePath, opts.subscriber);
  if (!entry && opts.nickname) entry = tokens.getTokenByNickname(filePath, opts.nickname);
  if (!entry) return "";
  return entry.token_hash || entry.token || "";
}

function onlineAuthHeaders(opts) {
  const token = resolveOnlineAuthToken(opts);
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function runCli(argv) {
  const pkg = require(path.resolve(getPackageRoot(), "package.json"));

  const commander = requireOptional("commander");
  const chalk = requireOptional("chalk") || { cyan: (s) => s, red: (s) => s };

  if (commander && commander.Command) {
    const { Command } = commander;
    const program = new Command();

    program
      .name("ufoo")
      .description("ufoo CLI (wrapper-first; prefers project-local scripts).")
      .version(pkg.version, "-v, --version", "Display version with banner");

    program
      .command("doctor")
      .description("Run repo doctor checks")
      .action(() => {
        const repoRoot = getPackageRoot();
        const RepoDoctor = require("./doctor");
        const doctor = new RepoDoctor(repoRoot);
        const ok = doctor.run();
        if (!ok) process.exitCode = 1;
      });
    program
      .command("status")
      .description("Show project status (banner, unread bus, open decisions)")
      .action(async () => {
        const StatusDisplay = require("./status");
        const status = new StatusDisplay(process.cwd());
        await status.show();
      });
    program
      .command("daemon")
      .description("Start/stop ufoo daemon")
      .option("--start", "Start daemon")
      .option("--stop", "Stop daemon")
      .option("--status", "Check daemon status")
      .action((opts) => {
        const repoRoot = getPackageRoot();
        const args = ["daemon"];
        if (opts.start) args.push("start");
        else if (opts.stop) args.push("stop");
        else if (opts.status) args.push("status");
        run(process.execPath, [path.join(repoRoot, "bin", "ufoo.js"), ...args]);
      });
    program
      .command("chat")
      .description("Launch ufoo chat UI")
      .option("-g, --global", "Launch in global multi-project mode")
      .action((opts) => {
        const repoRoot = getPackageRoot();
        const args = ["chat"];
        if (opts.global === true) args.push("-g");
        run(process.execPath, [path.join(repoRoot, "bin", "ufoo.js"), ...args]);
      });
    const project = program.command("project").description("Project runtime commands");
    project
      .command("list")
      .description("List runtime projects discovered from global registry")
      .option("--json", "Output as JSON")
      .action((opts) => {
        process.exitCode = runProjectCommand({
          subcommand: "list",
          outputJson: opts.json === true,
          cwd: process.cwd(),
        });
      });
    project
      .command("current")
      .description("Show current project runtime context")
      .option("--json", "Output as JSON")
      .action((opts) => {
        process.exitCode = runProjectCommand({
          subcommand: "current",
          outputJson: opts.json === true,
          cwd: process.cwd(),
        });
      });
    project
      .command("switch")
      .description("Switch active project (chat-only in v1)")
      .argument("<indexOrPath>", "Project index from list output or absolute path")
      .action(() => {
        process.exitCode = runProjectCommand({
          subcommand: "switch",
          outputJson: false,
          cwd: process.cwd(),
        });
      });
    program
      .command("launch")
      .description("Launch an agent (ucode, uclaude, ucodex)")
      .argument("<agent>", "Agent type: ucode|uclaude|ucodex|claude|codex")
      .argument("[nickname]", "Optional nickname for the agent")
      .action(async (agent, nickname) => {
        try {
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);

          // Normalize agent type
          const agentLower = agent.toLowerCase();
          let normalizedAgent = "";
          if (agentLower === "ucode" || agentLower === "ufoo-code" || agentLower === "ufoo") {
            normalizedAgent = "ucode";
          } else if (agentLower === "uclaude" || agentLower === "claude-code" || agentLower === "claude") {
            normalizedAgent = "claude";
          } else if (agentLower === "ucodex" || agentLower === "codex" || agentLower === "openai") {
            normalizedAgent = "codex";
          } else {
            console.error(`Unknown agent type: ${agent}`);
            console.error("Valid types: ucode, uclaude, ucodex, claude, codex");
            process.exitCode = 1;
            return;
          }

          const resp = await sendDaemonRequest(projectRoot, {
            type: "launch_agent",
            agent: normalizedAgent,
            nickname: nickname || "",
            count: 1,
            ...collectHostLaunchRequestContext(),
          });
          const reply = resp?.data?.reply || `Launching ${normalizedAgent} agent...`;
          console.log(reply);
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });
    program
      .command("resume")
      .description("Resume agent sessions (optional nickname)")
      .argument("[nickname]", "Nickname or subscriber ID to resume")
      .action(async (nickname) => {
        try {
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "resume_agents",
            target: nickname || "",
          });
          const reply = resp?.data?.reply || "Resume requested";
          console.log(reply);
          if (resp?.data?.resume?.resumed?.length) {
            resp.data.resume.resumed.forEach((item) => {
              const label = item.nickname ? ` (${item.nickname})` : "";
              console.log(`  - ${item.agent}${label}`);
            });
          }
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });
    program
      .command("recover")
      .description("List recoverable agents or recover a specific one")
      .argument("[action]", "list|run", "list")
      .argument("[target]", "Nickname or subscriber ID")
      .option("--json", "Output recoverable list as JSON")
      .action(async (action, target, opts) => {
        try {
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const normalizedAction = (action || "list").toLowerCase();

          if (normalizedAction === "list") {
            const resp = await sendDaemonRequest(projectRoot, {
              type: "list_recoverable_agents",
              target: target || "",
            });
            const result = resp?.data?.recoverable || { recoverable: [], skipped: [] };
            if (opts.json) {
              console.log(JSON.stringify(result, null, 2));
              return;
            }

            const recoverable = result.recoverable || [];
            console.log(resp?.data?.reply || `Found ${recoverable.length} recoverable agent(s)`);
            recoverable.forEach((item) => {
              const nickname = item.nickname ? ` (${item.nickname})` : "";
              const meta = item.launchMode ? ` [${item.agent}/${item.launchMode}]` : ` [${item.agent}]`;
              console.log(`  - ${item.id}${nickname}${meta}`);
            });
            return;
          }

          if (normalizedAction === "run") {
            if (!target) {
              console.error("recover run requires <target>");
              process.exitCode = 1;
              return;
            }
            const resp = await sendDaemonRequest(projectRoot, {
              type: "resume_agents",
              target,
            });
            const reply = resp?.data?.reply || "Recover requested";
            console.log(reply);
            if (resp?.data?.resume?.resumed?.length) {
              resp.data.resume.resumed.forEach((item) => {
                const label = item.nickname ? ` (${item.nickname})` : "";
                console.log(`  - ${item.id}${label}`);
              });
            }
            return;
          }

          console.error("recover action must be list|run");
          process.exitCode = 1;
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    program
      .command("report")
      .description("Report agent task status to daemon/ufoo-agent")
      .argument("<action>", "start|progress|done|error|list")
      .argument("[message...]", "Task message/summary")
      .option("--task <id>", "Task ID (default: task-<timestamp>)")
      .option("--agent <id>", "Agent ID (default: UFOO_SUBSCRIBER_ID)")
      .option("--scope <scope>", "Report visibility: public|private", "public")
      .option("--controller <id>", "Controller ID for private channel", "ufoo-agent")
      .option("--summary <text>", "Summary text for done")
      .option("--error <text>", "Error text for error")
      .option("--meta <json>", "JSON metadata object")
      .option("-n, --num <n>", "List count", "20")
      .option("--json", "Output as JSON")
      .action(async (action, messageParts, opts) => {
        const normalized = normalizeReportPhase(action);
        const text = Array.isArray(messageParts) ? messageParts.join(" ").trim() : String(messageParts || "").trim();
        const projectRoot = process.cwd();
        const { listReports } = require("./report/store");

        if ((action || "").toLowerCase() === "list") {
          try {
            const rows = listReports(projectRoot, {
              num: parseInt(opts.num, 10),
              agent: opts.agent || "",
            });
            if (opts.json) {
              console.log(JSON.stringify(rows, null, 2));
              return;
            }
            console.log(`=== Reports (${rows.length} shown) ===`);
            rows.forEach((row) => {
              const detail = row.phase === "error"
                ? (row.error || row.summary || row.message || row.task_id)
                : (row.summary || row.message || row.task_id);
              console.log(`${row.ts || "-"} [${row.phase}] ${row.agent_id || "unknown-agent"} ${row.task_id || ""} ${detail}`);
            });
            if (rows.length === 0) console.log("No reports found.");
          } catch (err) {
            console.error(err.message || String(err));
            process.exitCode = 1;
          }
          return;
        }

        if (!normalized) {
          console.error("report action must be start|progress|done|error|list");
          process.exitCode = 1;
          return;
        }

        let meta = {};
        try {
          meta = parseJsonObject(opts.meta, {});
        } catch (err) {
          console.error(`Invalid --meta: ${err.message}`);
          process.exitCode = 1;
          return;
        }

        const agentId = String(opts.agent || process.env.UFOO_SUBSCRIBER_ID || "unknown-agent").trim() || "unknown-agent";
        const taskId = String(opts.task || `task-${Date.now()}`).trim();
        const summary = String(opts.summary || (normalized === "done" ? text : "")).trim();
        const error = String(opts.error || (normalized === "error" ? text : "")).trim();
        const report = {
          phase: normalized,
          task_id: taskId,
          agent_id: agentId,
          message: text,
          summary,
          error,
          ok: normalized !== "error",
          source: "cli",
          scope: opts.scope || "public",
          controller_id: opts.controller || "ufoo-agent",
          meta,
        };

        try {
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "agent_report",
            report,
          });
          const out = resp?.data?.report || report;
          if (opts.json) {
            console.log(JSON.stringify(out, null, 2));
            return;
          }
          const detail = out.phase === "error"
            ? (out.error || out.summary || out.message || out.task_id)
            : (out.summary || out.message || out.task_id);
          console.log(`[report] ${out.phase} ${out.agent_id} ${out.task_id} ${detail}`);
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    program
      .command("ucode")
      .description("ucode core preparation helpers")
      .argument("[action]", "doctor|prepare|build", "doctor")
      .option("--skip-install", "Skip npm install even if node_modules is missing")
      .action((action, opts) => {
        const { inspectUcodeSetup, formatUcodeDoctor, prepareAndInspectUcode } = require("./agent/ucodeDoctor");
        const { buildUcodeCore } = require("./agent/ucodeBuild");
        const normalized = String(action || "doctor").trim().toLowerCase();
        if (normalized !== "doctor" && normalized !== "prepare" && normalized !== "build") {
          console.error("ucode action must be doctor|prepare|build");
          process.exitCode = 1;
          return;
        }
        if (normalized === "build") {
          try {
            const built = buildUcodeCore({
              projectRoot: process.cwd(),
              installIfMissing: !opts.skipInstall,
              stdio: "inherit",
            });
            console.log("=== ucode build ===");
            console.log(`workspace: ${built.workspaceRoot}`);
            console.log(`core: ${built.coreRoot}`);
            console.log(`dist: ${built.distCliPath}`);
            console.log(`steps: ${built.steps.join(", ")}`);
            return;
          } catch (err) {
            console.error(err.message || String(err));
            process.exitCode = 1;
            return;
          }
        }
        const result = normalized === "prepare"
          ? prepareAndInspectUcode({ projectRoot: process.cwd() })
          : inspectUcodeSetup({ projectRoot: process.cwd() });
        console.log(formatUcodeDoctor(result));
        if (normalized === "prepare" && result.bootstrapPrepared && result.bootstrapPrepared.file) {
          console.log(`prepared bootstrap: ${result.bootstrapPrepared.file}`);
        }
      });

    program
      .command("init")
      .description("Initialize modules in a project")
      .option("--modules <list>", "Comma-separated modules (context,bus,resources)", "context")
      .option("--project <dir>", "Target project directory", process.cwd())
      .action(async (opts) => {
        const UfooInit = require("./init");
        const repoRoot = getPackageRoot();
        const init = new UfooInit(repoRoot);
        try {
          await init.init(opts);
        } catch (err) {
          console.error(err.message);
          process.exitCode = 1;
        }
      });

    const skills = program.command("skills").description("Manage skills templates");
    skills
      .command("list")
      .description("List available skills")
      .action(() => {
        const SkillsManager = require("./skills");
        const repoRoot = getPackageRoot();
        const manager = new SkillsManager(repoRoot);
        const skillsList = manager.list();
        skillsList.forEach((skill) => console.log(skill));
      });
    skills
      .command("install")
      .description("Install one skill or all skills")
      .argument("<name>", "Skill name or 'all'")
      .option("--target <dir>", "Install target directory")
      .option("--codex", "Install into ~/.codex/skills")
      .option("--agents", "Install into ~/.agents/skills")
      .action(async (name, opts) => {
        const SkillsManager = require("./skills");
        const repoRoot = getPackageRoot();
        const manager = new SkillsManager(repoRoot);
        try {
          await manager.install(name, opts);
        } catch (err) {
          console.error(err.message);
          process.exitCode = 1;
        }
      });

    const group = program.command("group").description("Agent group template commands");
    group
      .command("templates")
      .description("List available group templates")
      .argument("[action]", "list", "list")
      .option("--json", "Output as JSON")
      .action(async (action, opts) => {
        const normalizedAction = String(action || "list").trim().toLowerCase();
        if (normalizedAction !== "list" && normalizedAction !== "ls") {
          console.error(`Unknown group templates action: ${normalizedAction}`);
          process.exitCode = 1;
          return;
        }
        try {
          await runGroupCoreCommand("templates", [normalizedAction], {
            cwd: process.cwd(),
            json: opts.json,
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    group
      .command("template")
      .description("Group template operations")
      .argument("<action>", "list|show|validate|new")
      .argument("[target]", "Template alias (or path for validate)")
      .option("--from <alias>", "Builtin template alias (for template new)")
      .option("--global", "Create template in ~/.ufoo/templates/groups")
      .option("--project", "Create template in .ufoo/templates/groups (default)")
      .option("--force", "Overwrite existing file (for template new)")
      .option("--json", "Output as JSON")
      .action(async (action, target, opts) => {
        const args = [action];
        if (target) args.push(target);
        if (opts.from) args.push("--from", opts.from);
        if (opts.global) args.push("--global");
        if (opts.project) args.push("--project");
        if (opts.force) args.push("--force");
        if (opts.json) args.push("--json");

        try {
          await runGroupCoreCommand("template", args, {
            cwd: process.cwd(),
            json: opts.json,
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    group
      .command("run")
      .description("Launch an agent group from template")
      .argument("<alias>", "Template alias")
      .option("--instance <name>", "Group instance ID")
      .option("--dry-run", "Validate and compile launch plan without starting agents")
      .option("--json", "Output daemon response as JSON")
      .action(async (alias, opts) => {
        try {
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "launch_group",
            alias,
            instance: opts.instance || "",
            dry_run: opts.dryRun === true,
          });
          if (opts.json) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          const reply = resp?.data?.reply || "Group run requested";
          console.log(reply);
          if (resp?.data?.group?.ok === false) {
            process.exitCode = 1;
          }
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    group
      .command("status")
      .description("Show group runtime status (single group or list)")
      .argument("[groupId]", "Group ID (optional)")
      .option("--json", "Output daemon response as JSON")
      .action(async (groupId, opts) => {
        try {
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "group_status",
            group_id: groupId || "",
          });
          if (opts.json) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          const reply = resp?.data?.reply || "Group status requested";
          console.log(reply);
          const group = resp?.data?.group || {};
          if (groupId && group?.group) {
            console.log(JSON.stringify(group.group, null, 2));
          } else if (!groupId && Array.isArray(group?.groups)) {
            group.groups.forEach((item) => {
              console.log(`- ${item.group_id} [${item.status}] ${item.template_alias} active=${item.members_active}/${item.members_total}`);
            });
          }
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    group
      .command("diagram")
      .description("Render group diagram from template alias or group runtime ID")
      .argument("<target>", "Template alias or group ID")
      .option("--ascii", "Render ASCII diagram (default)")
      .option("--mermaid", "Render Mermaid flowchart")
      .option("--json", "Output daemon response as JSON")
      .action(async (target, opts) => {
        try {
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const format = opts.mermaid ? "mermaid" : "ascii";
          const resp = await sendDaemonRequest(projectRoot, {
            type: "group_diagram",
            alias: target,
            group_id: target,
            format,
          });
          if (opts.json) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          const reply = resp?.data?.reply || "Group diagram requested";
          console.log(reply);
          if (resp?.data?.group?.diagram) {
            console.log(resp.data.group.diagram);
          }
          if (resp?.data?.group?.ok === false) {
            process.exitCode = 1;
          }
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    group
      .command("stop")
      .description("Stop a running group instance")
      .argument("<groupId>", "Group ID")
      .option("--json", "Output daemon response as JSON")
      .action(async (groupId, opts) => {
        try {
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "stop_group",
            group_id: groupId,
          });
          if (opts.json) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          const reply = resp?.data?.reply || "Group stop requested";
          console.log(reply);
          if (resp?.data?.group?.ok === false) {
            process.exitCode = 1;
          }
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    const online = program.command("online").description("ufoo online helpers");
    online
      .command("server")
      .description("Start ufoo-online relay server")
      .option("--port <port>", "Listen port", "8787")
      .option("--host <host>", "Listen host", "127.0.0.1")
      .option("--token-file <path>", "Token file for auth validation")
      .option("--idle-timeout <ms>", "Idle timeout in ms", "30000")
      .option("--insecure", "Allow any token (dev only)")
      .option("--tls-cert <path>", "TLS certificate file")
      .option("--tls-key <path>", "TLS private key file")
      .action(async (opts) => {
        try {
          await runOnlineCommand("server", { opts }, {
            mode: "commander",
            onlineAuthHeaders,
            projectRoot: process.cwd(),
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });
    online
      .command("token")
      .description("Generate and store a ufoo-online token")
      .argument("<subscriber>", "Subscriber ID (e.g., claude-code:abc123)")
      .option("--nickname <name>", "Nickname for this agent")
      .option("--server <url>", "Online server URL", "https://online.ufoo.dev")
      .option("--file <path>", "Tokens file path")
      .action(async (subscriber, opts) => {
        try {
          await runOnlineCommand("token", { subscriber, opts }, {
            mode: "commander",
            onlineAuthHeaders,
            projectRoot: process.cwd(),
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    online
      .command("room")
      .description("Manage online rooms (HTTP)")
      .argument("<action>", "create|list")
      .option("--server <url>", "Online server base URL (default: https://online.ufoo.dev)")
      .option("--auth-token <token>", "Bearer token for HTTP auth (token or token_hash)")
      .option("--token-file <path>", "Token file path for auth lookup")
      .option("--subscriber <id>", "Subscriber ID to resolve token")
      .option("--nickname <name>", "Nickname to resolve token")
      .option("--name <room>", "Room name (optional)")
      .option("--type <type>", "Room type (public|private)")
      .option("--password <pwd>", "Room password (private only)")
      .option("--created-by <name>", "Room creator nickname metadata")
      .action(async (action, opts) => {
        try {
          await runOnlineCommand("room", { action, opts }, {
            mode: "commander",
            onlineAuthHeaders,
            projectRoot: process.cwd(),
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    online
      .command("channel")
      .description("Manage online channels (HTTP)")
      .argument("<action>", "create|list")
      .option("--server <url>", "Online server base URL (default: https://online.ufoo.dev)")
      .option("--auth-token <token>", "Bearer token for HTTP auth (token or token_hash)")
      .option("--token-file <path>", "Token file path for auth lookup")
      .option("--subscriber <id>", "Subscriber ID to resolve token")
      .option("--nickname <name>", "Nickname to resolve token")
      .option("--name <name>", "Channel name (unique)")
      .option("--type <type>", "Channel type (world|public)")
      .option("--created-by <name>", "Channel creator nickname metadata")
      .action(async (action, opts) => {
        try {
          await runOnlineCommand("channel", { action, opts }, {
            mode: "commander",
            onlineAuthHeaders,
            projectRoot: process.cwd(),
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    online
      .command("connect")
      .description("Connect to ufoo-online relay (long-running)")
      .requiredOption("--nickname <name>", "Agent nickname")
      .option("--url <url>", "WebSocket URL", "wss://online.ufoo.dev/ufoo/online")
      .option("--subscriber <id>", "Subscriber ID (auto-generated if omitted)")
      .option("--token <tok>", "Auth token")
      .option("--token-hash <hash>", "Auth token hash")
      .option("--token-file <path>", "Token file path")
      .option("--world <name>", "World name", "default")
      .option("--ping-ms <ms>", "Keepalive ping interval (ms)")
      .option("--join <channel>", "Join channel after connect")
      .option("--room <room>", "Join private room (enables bus/decisions/wake sync)")
      .option("--room-password <pwd>", "Room password")
      .option("--interval <ms>", "Bus sync poll interval in ms", "1500")
      .option("--allow-insecure-ws", "Allow ws:// to non-localhost (insecure)")
      .option("--trust-remote", "Trust all private-room members for bus/decisions/wake sync")
      .option("--allow-from <subscriberId>", "Allow bus/decisions/wake from subscriber ID (repeatable)", collectOption)
      .action(async (opts) => {
        try {
          await runOnlineCommand("connect", { opts }, {
            mode: "commander",
            onlineAuthHeaders,
            projectRoot: process.cwd(),
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    online
      .command("send")
      .description("Send a message to a channel or room via outbox")
      .requiredOption("--nickname <name>", "Agent nickname (must match a running connect)")
      .requiredOption("--text <message>", "Message text")
      .option("--channel <name>", "Target channel")
      .option("--room <id>", "Target room")
      .action(async (opts) => {
        try {
          await runOnlineCommand("send", { opts }, {
            mode: "commander",
            onlineAuthHeaders,
            projectRoot: process.cwd(),
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    online
      .command("inbox")
      .description("View ufoo-online inbox for a nickname")
      .argument("<nickname>", "Agent nickname")
      .option("--clear", "Clear the inbox")
      .option("--unread", "Show unread messages only")
      .action(async (nickname, opts) => {
        try {
          await runOnlineCommand("inbox", { nickname, opts }, {
            mode: "commander",
            onlineAuthHeaders,
            projectRoot: process.cwd(),
          });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      });

    const bus = program.command("bus").description("Project bus commands");
    bus
      .command("alert")
      .description("Start/stop background notification daemon")
      .argument("<subscriber>", "Subscriber ID (e.g., claude-code:abc123)")
      .argument("[interval]", "Poll interval in seconds", "2")
      .option("--notify", "Enable macOS Notification Center")
      .option("--daemon", "Run in background")
      .option("--stop", "Stop running alert for this subscriber")
      .option("--no-title", "Disable terminal title badge")
      .option("--no-bell", "Disable terminal bell")
      .allowUnknownOption(true)
      .action((subscriber, interval, opts) => {
        const EventBus = require("./bus");
        const eventBus = new EventBus(process.cwd());
        const parsedInterval = parseInt(interval, 10);
        eventBus
          .alert(subscriber, Number.isFinite(parsedInterval) ? parsedInterval : 2, {
            notify: opts.notify,
            daemon: opts.daemon,
            stop: opts.stop,
            title: opts.title !== false,
            bell: opts.bell !== false,
          })
          .catch((err) => {
            console.error(err.message);
            process.exitCode = 1;
          });
      });
    bus
      .command("listen")
      .description("Foreground listener for incoming messages")
      .argument("[subscriber]", "Subscriber ID")
      .option("--from-beginning", "Print existing queued messages first")
      .option("--reset", "Truncate pending queue before listening")
      .option("--auto-join", "Auto-join bus to get subscriber ID")
      .action((subscriber, opts) => {
        const EventBus = require("./bus");
        const eventBus = new EventBus(process.cwd());
        eventBus
          .listen(subscriber, {
            fromBeginning: opts.fromBeginning,
            reset: opts.reset,
            autoJoin: opts.autoJoin,
          })
          .catch((err) => {
            console.error(err.message);
            process.exitCode = 1;
          });
      });
    bus
      .command("daemon")
      .description("Start/stop daemon that auto-injects /bus into terminals")
      .option("--interval <n>", "Poll interval in seconds", "2")
      .option("--daemon", "Run in background")
      .option("--stop", "Stop running daemon")
      .option("--status", "Check daemon status")
      .action((opts) => {
        const EventBus = require("./bus");
        const eventBus = new EventBus(process.cwd());
        (async () => {
          try {
            const interval = parseInt(opts.interval, 10) * 1000 || 2000;
            if (opts.stop) {
              await eventBus.daemon("stop");
            } else if (opts.status) {
              await eventBus.daemon("status");
            } else {
              await eventBus.daemon("start", { background: opts.daemon, interval });
            }
          } catch (err) {
            console.error(err.message);
            process.exitCode = 1;
          }
        })();
      });
    bus
      .command("inject")
      .description("Inject /bus into a Terminal.app tab by subscriber ID")
      .argument("<subscriber>", "Subscriber ID to inject into")
      .action((subscriber) => {
        const EventBus = require("./bus");
        const eventBus = new EventBus(process.cwd());
        (async () => {
          try {
            await eventBus.inject(subscriber);
          } catch (err) {
            console.error(err.message);
            process.exitCode = 1;
          }
        })();
      });
    bus
      .command("wake")
      .description("Wake an agent (inject /ubus into its terminal)")
      .argument("<target>", "Subscriber ID or nickname")
      .option("--reason <reason>", "Wake reason")
      .option("--no-shake", "Disable window shake")
      .action((target, opts) => {
        const EventBus = require("./bus");
        const eventBus = new EventBus(process.cwd());
        (async () => {
          try {
            await eventBus.wake(target, { reason: opts.reason || "remote", shake: opts.shake !== false });
          } catch (err) {
            console.error(err.message || String(err));
            process.exitCode = 1;
          }
        })();
      });
    bus
      .command("activate")
      .description("Activate (focus) the terminal/tmux window of an agent")
      .argument("<agent-id>", "Agent ID or nickname to activate")
      .action((agentId) => {
        const AgentActivator = require("./bus/activate");
        const activator = new AgentActivator(process.cwd());
        (async () => {
          try {
            await activator.activate(agentId);
          } catch (err) {
            console.error(err.message);
            process.exitCode = 1;
          }
        })();
      });
    bus
      .command("run", { isDefault: true })
      .description("Run bus commands (join, check, send, status, etc.)")
      .allowUnknownOption(true)
      .argument("<args...>", "Arguments passed to bus module")
      .action(async (args) => {
        const EventBus = require("./bus");
        const eventBus = new EventBus(process.cwd());
        const cmd = args[0];
        const cmdArgs = args.slice(1);

        try {
          const result = await runBusCoreCommand(eventBus, cmd, cmdArgs);
          if (result && result.subscriber) console.log(result.subscriber);
        } catch (err) {
          console.error(err.message);
          process.exitCode = 1;
        }
      });

    program
      .command("ctx")
      .description("Project context commands (doctor|lint|decisions|sync)")
      .argument("[subcmd]", "Subcommand (doctor|lint|decisions|sync)", "doctor")
      .allowUnknownOption(true)
      .argument("[subargs...]", "Subcommand args")
      .action(async (subcmd, subargs = []) => {
        const cwd = process.cwd();

        try {
          await runCtxCommand(subcmd, subargs, {
            cwd,
            allowIndexNew: true,
            updateDecisionIndexPaths: true,
          });
        } catch (err) {
          if (err && err.code === "UFOO_CTX_UNKNOWN") {
            console.error(chalk.red(err.message));
          } else {
            console.error(chalk.red(`Error: ${err.message}`));
          }
          process.exitCode = 1;
        }
      });

    program.addHelpText(
      "after",
      `\nNotes:\n  - If 'ufoo' isn't in PATH, run it via ${chalk.cyan(
        "./bin/ufoo"
      )} (repo) or install globally via npm.\n  - For bus notifications inside Codex, prefer ${chalk.cyan(
        "ufoo bus alert"
      )} / ${chalk.cyan("ufoo bus listen")} (no IME issues).\n`
    );

    // 检查是否是 --version 或 -V 参数
    if (argv.includes("--version") || argv.includes("-V")) {
      const { showUfooBanner } = require("./utils/banner");
      showUfooBanner({ version: pkg.version });
      return;
    }

    await program.parseAsync(argv);
    return;
  }

  // Dependency-free fallback parser (good for local testing without npm install).
  const cmd = argv[2] || "";
  const rest = argv.slice(3);
  const repoRoot = getPackageRoot();

  const help = () => {
    console.log(`ufoo ${pkg.version}`);
    console.log("");
    console.log("Usage:");
    console.log("  ufoo doctor");
    console.log("  ufoo status");
    console.log("  ufoo daemon --start|--stop|--status");
    console.log("  ufoo -g");
    console.log("  ufoo chat [-g]");
    console.log("  ufoo project list [--json]");
    console.log("  ufoo project current [--json]");
    console.log("  ufoo project switch <index|path>");
    console.log("  ufoo resume [nickname]");
    console.log("  ufoo recover [list [target] | run <target>] [--json]");
    console.log("  ufoo report <start|progress|done|error|list> [message] [--task <id>] [--agent <id>]");
    console.log("  ufoo ucode [doctor|prepare|build] [--skip-install]");
    console.log("  ufoo init [--modules <list>] [--project <dir>]");
    console.log("  ufoo skills list");
    console.log("  ufoo skills install <name|all> [--target <dir> | --codex | --agents]");
    console.log("  ufoo group templates [list|ls] [--json]");
    console.log("  ufoo group template <list|show|validate|new> [target] [--from <builtin>] [--global] [--force] [--json]");
    console.log("  ufoo group run <alias> [--instance <name>] [--dry-run] [--json]");
    console.log("  ufoo group status [groupId] [--json]");
    console.log("  ufoo group diagram <alias|groupId> [--ascii|--mermaid] [--json]");
    console.log("  ufoo group stop <groupId> [--json]");
    console.log("  ufoo online server [--port 8787] [--host 127.0.0.1] [--token-file <path>]");
    console.log("  ufoo online token <subscriber> [--nickname <name>] [--server <url>] [--file <path>]");
    console.log("  ufoo online room create [--name <room>] --type public|private [--password <pwd>] [--created-by <name>] [--server <url>]");
    console.log("  ufoo online room list [--server <url>]");
    console.log("  ufoo online channel create --name <name> [--type world|public] [--created-by <name>] [--server <url>]");
    console.log("  ufoo online channel list [--server <url>]");
    console.log("  ufoo online connect --nickname <name> [--join <ch>] [--room <id> --room-password <pwd>] [...]");
    console.log("  ufoo online send --nickname <name> --text <msg> [--channel <ch>] [--room <id>]");
    console.log("  ufoo online inbox <nickname> [--clear] [--unread]");
    console.log("  ufoo bus wake <target> [--reason <reason>] [--no-shake]");
    console.log("  ufoo bus <args...>    (JS bus implementation)");
    console.log("  ufoo ctx <subcmd> ... (doctor|lint|decisions|sync)");
    console.log("");
    console.log("Notes:");
    console.log("  - For Codex notifications, use ufoo bus alert / ufoo bus listen");
  };

  if (cmd === "" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  if (cmd === "--version" || cmd === "-V") {
    const { showUfooBanner } = require("./utils/banner");
    showUfooBanner({ version: pkg.version });
    return;
  }

  if (cmd === "doctor") {
    const RepoDoctor = require("./doctor");
    const doctor = new RepoDoctor(repoRoot);
    const ok = doctor.run();
    if (!ok) process.exitCode = 1;
    return;
  }
  if (cmd === "status") {
    const StatusDisplay = require("./status");
    const status = new StatusDisplay(process.cwd());
    status.show().catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
    return;
  }
  if (cmd === "daemon") {
    run(process.execPath, [path.join(repoRoot, "bin", "ufoo.js"), "daemon", ...rest]);
    return;
  }
  if (cmd === "chat") {
    const chatArgs = ["chat"];
    if (rest.includes("-g") || rest.includes("--global")) {
      chatArgs.push("-g");
    }
    run(process.execPath, [path.join(repoRoot, "bin", "ufoo.js"), ...chatArgs]);
    return;
  }
  if (cmd === "project") {
    const sub = String(rest[0] || "list").trim().toLowerCase();
    const outputJson = rest.includes("--json");
    process.exitCode = runProjectCommand({
      subcommand: sub,
      outputJson,
      cwd: process.cwd(),
    });
    return;
  }
  if (cmd === "resume") {
    const nickname = rest[0] || "";
    (async () => {
      try {
        const projectRoot = process.cwd();
        await ensureDaemonRunning(projectRoot);
        const resp = await sendDaemonRequest(projectRoot, {
          type: "resume_agents",
          target: nickname,
        });
        const reply = resp?.data?.reply || "Resume requested";
        console.log(reply);
      } catch (err) {
        console.error(err.message || String(err));
        process.exitCode = 1;
      }
    })();
    return;
  }
  if (cmd === "recover") {
    const first = rest[0] || "";
    const action = first && !first.startsWith("--") ? first.toLowerCase() : "list";
    const targetIdx = first && !first.startsWith("--") ? 1 : 0;
    const target = rest[targetIdx] && !rest[targetIdx].startsWith("--") ? rest[targetIdx] : "";
    const outputJson = rest.includes("--json");
    (async () => {
      try {
        const projectRoot = process.cwd();
        await ensureDaemonRunning(projectRoot);

        if (action === "list") {
          const resp = await sendDaemonRequest(projectRoot, {
            type: "list_recoverable_agents",
            target,
          });
          const result = resp?.data?.recoverable || { recoverable: [], skipped: [] };
          if (outputJson) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          const recoverable = result.recoverable || [];
          console.log(resp?.data?.reply || `Found ${recoverable.length} recoverable agent(s)`);
          recoverable.forEach((item) => {
            const nickname = item.nickname ? ` (${item.nickname})` : "";
            const meta = item.launchMode ? ` [${item.agent}/${item.launchMode}]` : ` [${item.agent}]`;
            console.log(`  - ${item.id}${nickname}${meta}`);
          });
          return;
        }

        if (action === "run") {
          if (!target) {
            console.error("recover run requires <target>");
            process.exitCode = 1;
            return;
          }
          const resp = await sendDaemonRequest(projectRoot, {
            type: "resume_agents",
            target,
          });
          const reply = resp?.data?.reply || "Recover requested";
          console.log(reply);
          return;
        }

        console.error("recover action must be list|run");
        process.exitCode = 1;
      } catch (err) {
        console.error(err.message || String(err));
        process.exitCode = 1;
      }
    })();
    return;
  }
  if (cmd === "report") {
    const action = String(rest[0] || "").toLowerCase();
    const normalized = normalizeReportPhase(action);
    const { listReports } = require("./report/store");

    if (action === "list") {
      const agentIdx = rest.indexOf("--agent");
      const numIdx = rest.indexOf("--num");
      const nIdx = rest.indexOf("-n");
      const json = rest.includes("--json");
      const agent = agentIdx !== -1 ? (rest[agentIdx + 1] || "") : "";
      const numRaw = numIdx !== -1
        ? rest[numIdx + 1]
        : (nIdx !== -1 ? rest[nIdx + 1] : "20");
      try {
        const rows = listReports(process.cwd(), { agent, num: parseInt(numRaw, 10) });
        if (json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        console.log(`=== Reports (${rows.length} shown) ===`);
        rows.forEach((row) => {
          const detail = row.phase === "error"
            ? (row.error || row.summary || row.message || row.task_id)
            : (row.summary || row.message || row.task_id);
          console.log(`${row.ts || "-"} [${row.phase}] ${row.agent_id || "unknown-agent"} ${row.task_id || ""} ${detail}`);
        });
        if (rows.length === 0) console.log("No reports found.");
      } catch (err) {
        console.error(err.message || String(err));
        process.exitCode = 1;
      }
      return;
    }

    if (!normalized) {
      console.error("report action must be start|progress|done|error|list");
      process.exitCode = 1;
      return;
    }

    const getOpt = (name, fallback = "") => {
      const idx = rest.indexOf(name);
      if (idx === -1 || idx + 1 >= rest.length) return fallback;
      const value = rest[idx + 1];
      if (!value || value.startsWith("--")) return fallback;
      return value;
    };

    const isValueToken = (token) =>
      token && !token.startsWith("--") && token !== action;
    const message = rest.slice(1).filter((token, idx, arr) => {
      if (!isValueToken(token)) return false;
      const prev = arr[idx - 1] || "";
      if (
        prev === "--task"
        || prev === "--agent"
        || prev === "--scope"
        || prev === "--controller"
        || prev === "--summary"
        || prev === "--error"
        || prev === "--meta"
        || prev === "--num"
        || prev === "-n"
      ) {
        return false;
      }
      return true;
    }).join(" ").trim();

    let meta = {};
    try {
      meta = parseJsonObject(getOpt("--meta", ""), {});
    } catch (err) {
      console.error(`Invalid --meta: ${err.message}`);
      process.exitCode = 1;
      return;
    }

    const report = {
      phase: normalized,
      task_id: getOpt("--task", `task-${Date.now()}`),
      agent_id: getOpt("--agent", process.env.UFOO_SUBSCRIBER_ID || "unknown-agent"),
      message,
      summary: getOpt("--summary", normalized === "done" ? message : ""),
      error: getOpt("--error", normalized === "error" ? message : ""),
      ok: normalized !== "error",
      source: "cli",
      scope: getOpt("--scope", "public"),
      controller_id: getOpt("--controller", "ufoo-agent"),
      meta,
    };

    (async () => {
      try {
        await ensureDaemonRunning(process.cwd());
        const resp = await sendDaemonRequest(process.cwd(), {
          type: "agent_report",
          report,
        });
        const out = resp?.data?.report || report;
        if (rest.includes("--json")) {
          console.log(JSON.stringify(out, null, 2));
          return;
        }
        const detail = out.phase === "error"
          ? (out.error || out.summary || out.message || out.task_id)
          : (out.summary || out.message || out.task_id);
        console.log(`[report] ${out.phase} ${out.agent_id} ${out.task_id} ${detail}`);
      } catch (err) {
        console.error(err.message || String(err));
        process.exitCode = 1;
      }
    })();
    return;
  }
  if (cmd === "ucode") {
    const action = String(rest[0] || "doctor").trim().toLowerCase();
    const { inspectUcodeSetup, formatUcodeDoctor, prepareAndInspectUcode } = require("./agent/ucodeDoctor");
    const { buildUcodeCore } = require("./agent/ucodeBuild");
    const skipInstall = rest.includes("--skip-install");
    if (action !== "doctor" && action !== "prepare" && action !== "build") {
      console.error("ucode action must be doctor|prepare|build");
      process.exitCode = 1;
      return;
    }
    if (action === "build") {
      try {
        const built = buildUcodeCore({
          projectRoot: process.cwd(),
          installIfMissing: !skipInstall,
          stdio: "inherit",
        });
        console.log("=== ucode build ===");
        console.log(`workspace: ${built.workspaceRoot}`);
        console.log(`core: ${built.coreRoot}`);
        console.log(`dist: ${built.distCliPath}`);
        console.log(`steps: ${built.steps.join(", ")}`);
      } catch (err) {
        console.error(err.message || String(err));
        process.exitCode = 1;
      }
      return;
    }
    const result = action === "prepare"
      ? prepareAndInspectUcode({ projectRoot: process.cwd() })
      : inspectUcodeSetup({ projectRoot: process.cwd() });
    console.log(formatUcodeDoctor(result));
    if (action === "prepare" && result.bootstrapPrepared && result.bootstrapPrepared.file) {
      console.log(`prepared bootstrap: ${result.bootstrapPrepared.file}`);
    }
    return;
  }
  if (cmd === "init") {
    const UfooInit = require("./init");
    const init = new UfooInit(repoRoot);

    const getOpt = (name, def) => {
      const i = rest.indexOf(name);
      if (i === -1) return def;
      if (i + 1 >= rest.length) throw new Error(`Missing value for ${name}`);
      return rest[i + 1];
    };

    const opts = {
      modules: getOpt("--modules", "context"),
      project: getOpt("--project", process.cwd()),
    };

    init.init(opts).catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
    return;
  }
  if (cmd === "skills") {
    const SkillsManager = require("./skills");
    const manager = new SkillsManager(repoRoot);
    const sub = rest[0] || "";

    if (sub === "list") {
      const skillsList = manager.list();
      skillsList.forEach((skill) => console.log(skill));
      return;
    }
    if (sub === "install") {
      const name = rest[1];
      if (!name) throw new Error("skills install requires <name|all>");

      const options = {};
      for (let i = 2; i < rest.length; i++) {
        if (rest[i] === "--target" && i + 1 < rest.length) {
          options.target = rest[i + 1];
          i++;
        } else if (rest[i] === "--codex") {
          options.codex = true;
        } else if (rest[i] === "--agents") {
          options.agents = true;
        }
      }

      manager.install(name, options).catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
      });
      return;
    }
    help();
    process.exitCode = 1;
    return;
  }
  if (cmd === "group") {
    const sub = String(rest[0] || "").trim().toLowerCase();

    (async () => {
      try {
        if (sub === "templates") {
          const action = String(rest[1] || "list").trim().toLowerCase();
          if (action !== "list" && action !== "ls") {
            throw new Error(`Unknown group templates action: ${action}`);
          }
          const json = rest.includes("--json");
          await runGroupCoreCommand("templates", [action], {
            cwd: process.cwd(),
            json,
          });
          return;
        }

        if (sub === "template") {
          const action = String(rest[1] || "list").trim().toLowerCase();
          const args = [action, ...rest.slice(2)];
          const json = rest.includes("--json");
          await runGroupCoreCommand("template", args, {
            cwd: process.cwd(),
            json,
          });
          return;
        }

        if (sub === "run") {
          const alias = String(rest[1] || "").trim();
          if (!alias) throw new Error("group run requires <alias>");
          const instanceIdx = rest.indexOf("--instance");
          const instance = instanceIdx !== -1 ? String(rest[instanceIdx + 1] || "").trim() : "";
          const dryRun = rest.includes("--dry-run");
          const outputJson = rest.includes("--json");

          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "launch_group",
            alias,
            instance,
            dry_run: dryRun,
          });
          if (outputJson) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          console.log(resp?.data?.reply || "Group run requested");
          if (resp?.data?.group?.ok === false) process.exitCode = 1;
          return;
        }

        if (sub === "status") {
          const groupId = rest[1] && !rest[1].startsWith("--") ? rest[1] : "";
          const outputJson = rest.includes("--json");
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "group_status",
            group_id: groupId,
          });
          if (outputJson) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          console.log(resp?.data?.reply || "Group status requested");
          const group = resp?.data?.group || {};
          if (groupId && group?.group) {
            console.log(JSON.stringify(group.group, null, 2));
          } else if (!groupId && Array.isArray(group?.groups)) {
            group.groups.forEach((item) => {
              console.log(`- ${item.group_id} [${item.status}] ${item.template_alias} active=${item.members_active}/${item.members_total}`);
            });
          }
          return;
        }

        if (sub === "stop") {
          const groupId = String(rest[1] || "").trim();
          if (!groupId) throw new Error("group stop requires <groupId>");
          const outputJson = rest.includes("--json");
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "stop_group",
            group_id: groupId,
          });
          if (outputJson) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          console.log(resp?.data?.reply || "Group stop requested");
          if (resp?.data?.group?.ok === false) process.exitCode = 1;
          return;
        }

        if (sub === "diagram") {
          const target = String(rest[1] || "").trim();
          if (!target) throw new Error("group diagram requires <alias|groupId>");
          const outputJson = rest.includes("--json");
          const format = rest.includes("--mermaid") ? "mermaid" : "ascii";
          const projectRoot = process.cwd();
          await ensureDaemonRunning(projectRoot);
          const resp = await sendDaemonRequest(projectRoot, {
            type: "group_diagram",
            alias: target,
            group_id: target,
            format,
          });
          if (outputJson) {
            console.log(JSON.stringify(resp?.data || {}, null, 2));
            return;
          }
          console.log(resp?.data?.reply || "Group diagram requested");
          if (resp?.data?.group?.diagram) {
            console.log(resp.data.group.diagram);
          }
          if (resp?.data?.group?.ok === false) process.exitCode = 1;
          return;
        }

        throw new Error("group requires templates|template|run|status|diagram|stop subcommand");
      } catch (err) {
        console.error(err.message || String(err));
        process.exitCode = 1;
      }
    })();
    return;
  }
  if (cmd === "online") {
    const sub = rest[0] || "";
    if (!sub) {
      help();
      process.exitCode = 1;
      return;
    }

    (async () => {
      try {
        await runOnlineCommand(sub, { argv: rest }, {
          mode: "fallback",
          onlineAuthHeaders,
          projectRoot: process.cwd(),
          collectOptionValues,
          collectOption,
          defaultChannelType: "public",
        });
      } catch (err) {
        if (err && err.code === "UFOO_ONLINE_UNKNOWN") {
          help();
        } else {
          console.error(err.message || String(err));
        }
        process.exitCode = 1;
      }
    })();
    return;
  }
  if (cmd === "bus") {
    const sub = rest[0] || "";
    if (sub === "alert") {
      const EventBus = require("./bus");
      const eventBus = new EventBus(process.cwd());
      const args = rest.slice(1);
      const subscriber = args[0];
      let interval = 2;
      let idx = 1;
      if (args[1] && /^[0-9]+$/.test(args[1])) {
        interval = parseInt(args[1], 10);
        idx = 2;
      }
      const options = {
        notify: args.includes("--notify"),
        daemon: args.includes("--daemon"),
        stop: args.includes("--stop"),
        title: !args.includes("--no-title"),
        bell: !args.includes("--no-bell"),
      };
      eventBus
        .alert(subscriber, interval, options)
        .catch((err) => {
          console.error(err.message);
          process.exitCode = 1;
        });
      return;
    }
    if (sub === "listen") {
      const EventBus = require("./bus");
      const eventBus = new EventBus(process.cwd());
      const args = rest.slice(1);
      const subscriber = args.find((arg) => !arg.startsWith("--"));
      const options = {
        fromBeginning: args.includes("--from-beginning"),
        reset: args.includes("--reset"),
        autoJoin: args.includes("--auto-join"),
      };
      eventBus
        .listen(subscriber, options)
        .catch((err) => {
          console.error(err.message);
          process.exitCode = 1;
        });
      return;
    }
    if (sub === "daemon") {
      // 使用 JavaScript daemon
      const EventBus = require("./bus");
      const eventBus = new EventBus(process.cwd());

      (async () => {
        try {
          const hasStop = rest.includes("--stop");
          const hasStatus = rest.includes("--status");
          const hasDaemon = rest.includes("--daemon");
          const intervalIdx = rest.indexOf("--interval");
          const interval = intervalIdx !== -1 ? parseInt(rest[intervalIdx + 1], 10) * 1000 : 2000;

          if (hasStop) {
            await eventBus.daemon("stop");
          } else if (hasStatus) {
            await eventBus.daemon("status");
          } else {
            await eventBus.daemon("start", { background: hasDaemon, interval });
          }
        } catch (err) {
          console.error(err.message);
          process.exitCode = 1;
        }
      })();
      return;
    }
    if (sub === "inject") {
      // 使用 JavaScript inject
      const EventBus = require("./bus");
      const eventBus = new EventBus(process.cwd());

      (async () => {
        try {
          const subscriber = rest[1];
          if (!subscriber) {
            throw new Error("inject requires <subscriber-id>");
          }
          await eventBus.inject(subscriber);
        } catch (err) {
          console.error(err.message);
          process.exitCode = 1;
        }
      })();
      return;
    }
    if (sub === "wake") {
      const EventBus = require("./bus");
      const eventBus = new EventBus(process.cwd());
      (async () => {
        try {
          const target = rest[1];
          if (!target) throw new Error("wake requires <subscriber-id|nickname>");
          const reasonIdx = rest.indexOf("--reason");
          const reason = reasonIdx !== -1 ? rest[reasonIdx + 1] : "remote";
          const shake = !rest.includes("--no-shake");
          await eventBus.wake(target, { reason, shake });
        } catch (err) {
          console.error(err.message || String(err));
          process.exitCode = 1;
        }
      })();
      return;
    }

    // Use JavaScript EventBus module for core commands
    const EventBus = require("./bus");
    const eventBus = new EventBus(process.cwd());

    (async () => {
      try {
        const cmdArgs = rest.slice(1);
        const result = await runBusCoreCommand(eventBus, sub, cmdArgs);
        if (result && result.subscriber) console.log(result.subscriber);
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
    })();
    return;
  }
  if (cmd === "ctx") {
    const sub = rest[0] || "doctor";
    const subargs = rest.slice(1);
    const cwd = process.cwd();

    (async () => {
      try {
        await runCtxCommand(sub, subargs, {
          cwd,
          allowIndexNew: false,
          updateDecisionIndexPaths: false,
        });
      } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    })();
    return;
  }

  help();
  process.exitCode = 1;
}

module.exports = { runCli };

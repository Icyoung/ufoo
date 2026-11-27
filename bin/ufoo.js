#!/usr/bin/env node
/* eslint-disable no-console */
const { runCli } = require("../src/app/cli/run");
const { runDaemonCli } = require("../src/runtime/daemon/run");
const { runMcpServer } = require("../src/runtime/daemon/mcpServer");
const { runChat } = require("../src/app/chat");
const { runInternalRunner } = require("../src/agents/internal/internalRunner");
const { resolveGlobalControllerProjectRoot } = require("../src/runtime/projects");
const { maybeRunFirstTimeSetup } = require("../src/app/cli/setupCommands");

const rawArgv = process.argv.slice(2);

function hasGlobalModeFlag(args = []) {
  return args.includes("-g") || args.includes("--global");
}

function printMcpHelp() {
  console.log("Usage: ufoo mcp [status|restart|configure codex|channel] [options]");
  console.log("");
  console.log("Run the stdio compatibility proxy or control the global MCP listener.");
  console.log("");
  console.log("Options:");
  console.log("  --no-auto-start  Do not auto-start the home-scoped global controller daemon");
  console.log("  --json           Print status or restart results as JSON");
  console.log("  --dry-run        Print a sanitized Codex migration preview without writing it");
  console.log("  -h, --help       Display help for the MCP bridge command");
  console.log("");
  console.log("Notes:");
  console.log("  Configure MCP-capable clients with command: ufoo mcp");
  console.log("  Inspect the singleton listener: ufoo mcp status");
  console.log("  Restart only the listener: ufoo mcp restart");
  console.log("  Configure Codex App/CLI/IDE: ufoo mcp configure codex");
  console.log("  Example without daemon auto-start: ufoo mcp --no-auto-start");
  console.log("  Human diagnostics are available in chat: /mcp status, /mcp tools, /mcp help");
}

function parseChatFlags(args = []) {
  let project = "";
  let initialWindowMode = "";
  let initialAgentId = "";
  for (let i = 0; i < args.length; i += 1) {
    const val = String(args[i] || "");
    if ((val === "--project" || val === "-p") && args[i + 1]) {
      project = String(args[++i]);
    } else if (val === "--window" && args[i + 1]) {
      initialWindowMode = String(args[++i]).toLowerCase();
    } else if (val === "--agent" && args[i + 1]) {
      initialAgentId = String(args[++i]);
    }
  }
  return { project, initialWindowMode, initialAgentId };
}

async function main() {
  const globalMode = hasGlobalModeFlag(rawArgv);
  const argv = rawArgv.filter((arg) => arg !== "-g" && arg !== "--global");
  const cmd = argv[0];
  const chatFlags = parseChatFlags(argv);
  const chatProjectRoot = globalMode
    ? resolveGlobalControllerProjectRoot()
    : (chatFlags.project ? require("path").resolve(chatFlags.project) : process.cwd());

  if (!cmd) {
    await maybeRunFirstTimeSetup({ surface: "ufoo", argv: rawArgv });
    await runChat(chatProjectRoot, {
      globalMode,
      initialWindowMode: chatFlags.initialWindowMode,
      initialAgentId: chatFlags.initialAgentId,
    });
    return;
  }
  if (cmd === "app") {
    const { runAppCommand } = require("../src/app/cli/appCommands");
    await runAppCommand(argv.slice(1));
    return;
  }
  if (cmd === "daemon") {
    runDaemonCli(["daemon", ...argv.slice(1)]);
    return;
  }
  if (cmd === "acp") {
    const { runUfooAcpServer } = require("../src/agents/acp/acpServer");
    const agentIdx = argv.indexOf("--agent");
    const agent = agentIdx >= 0 && argv[agentIdx + 1] ? String(argv[agentIdx + 1]).trim() : "main";
    await runUfooAcpServer({
      projectRoot: chatProjectRoot,
      agent,
    });
    return;
  }
  if (cmd === "mcp") {
    if (argv.includes("--help") || argv.includes("-h")) {
      printMcpHelp();
      return;
    }
    const operation = argv[1];
    if (operation === "status" || operation === "restart") {
      const { runMcpControlCli } = require("../src/runtime/daemon/mcpControl");
      await runMcpControlCli(operation, { json: argv.includes("--json") });
    } else if (operation === "configure") {
      const { runMcpConfigureCli } = require("../src/runtime/daemon/mcpConfigure");
      runMcpConfigureCli(argv[2], { dryRun: argv.includes("--dry-run") });
    } else {
      await runMcpServer({
        autoStart: !argv.includes("--no-auto-start"),
      });
    }
    return;
  }
  if (cmd === "agent-runner") {
    const agentType = argv[1] || "codex";
    const extraArgs = argv.slice(2);
    await runInternalRunner({ projectRoot: process.cwd(), agentType, extraArgs });
    return;
  }
  if (cmd === "chat") {
    await maybeRunFirstTimeSetup({ surface: "ufoo", argv: rawArgv });
    await runChat(chatProjectRoot, {
      globalMode,
      initialWindowMode: chatFlags.initialWindowMode,
      initialAgentId: chatFlags.initialAgentId,
    });
    return;
  }

  // Handle resume command to resume/launch agent sessions
  if (cmd === "resume") {
    const target = argv[1];
    if (!target) {
      console.error("Error: resume requires an agent type or nickname");
      console.error("Usage: ufoo resume <ucode|claude|codex|agy|acp:<id>|nickname>");
      console.error("");
      console.error("Examples:");
      console.error("  ufoo resume ucode      # Start interactive native ucode agent");
      console.error("  ufoo resume claude     # Launch managed Claude Code SDK worker");
      console.error("  ufoo resume codex      # Launch managed Codex SDK worker");
      console.error("  ufoo resume agy        # Launch managed Antigravity (agy) worker");
      process.exitCode = 1;
      return;
    }

    const path = require("path");
    const { spawn } = require("child_process");
    const targetLower = target.toLowerCase();

    if (targetLower === "ucode") {
      const scriptPath = path.join(__dirname, "ucode.js");
      console.log("Starting new ucode session...");
      const child = spawn(process.execPath, [scriptPath, ...argv.slice(2)], {
        stdio: "inherit",
        cwd: process.cwd(),
        env: process.env,
      });
      child.on("exit", (code) => {
        process.exit(code || 0);
      });
      return;
    }

    const { requestDaemon, ensureDaemonRunning } = require("../src/app/chat/transport");
    const projectRoot = process.cwd();
    await ensureDaemonRunning(projectRoot);
    const normalized = targetLower === "claude-code"
      ? "claude"
      : (targetLower === "openai"
        ? "codex"
        : (targetLower === "antigravity" || targetLower === "agy-cli" ? "agy" : targetLower));
    const isDirectEngine = normalized === "claude"
      || normalized === "codex"
      || normalized === "agy"
      || normalized.startsWith("acp:");
    const resp = await requestDaemon(projectRoot, isDirectEngine
      ? { type: "launch_agent", agent: normalized, count: 1, internal_only: true }
      : { type: "resume_agent", target }, { fullResponse: true });
    console.log(resp?.data?.reply || resp?.reply || `Resumed ${target}`);
    return;
  }

  await runCli(process.argv);
}

main().catch((err) => {
  const message = err && err.stack ? err.stack : String(err);
  console.error(message);
  process.exitCode = 1;
});

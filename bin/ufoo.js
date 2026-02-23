#!/usr/bin/env node
/* eslint-disable no-console */
const { runCli } = require("../src/cli");
const { runDaemonCli } = require("../src/daemon/run");
const { runChat } = require("../src/chat");
const { runInternalRunner } = require("../src/agent/internalRunner");
const { runPtyRunner } = require("../src/agent/ptyRunner");

const cmd = process.argv[2];

async function main() {
  if (!cmd) {
    await runChat(process.cwd());
    return;
  }
  if (cmd === "daemon") {
    runDaemonCli(process.argv.slice(2));
    return;
  }
  if (cmd === "agent-runner") {
    const agentType = process.argv[3] || "codex";
    await runInternalRunner({ projectRoot: process.cwd(), agentType });
    return;
  }
  if (cmd === "agent-pty-runner") {
    const agentType = process.argv[3] || "codex";
    try {
      await runPtyRunner({ projectRoot: process.cwd(), agentType });
    } catch (err) {
      const normalized = String(agentType || "").trim().toLowerCase();
      if (normalized === "ufoo" || normalized === "ucode" || normalized === "ufoo-code") {
        throw err;
      }
      // Fallback to headless runner if PTY is unavailable
      // eslint-disable-next-line no-console
      console.error(`[pty-runner] ${err.message || err}. Falling back to headless internal runner.`);
      await runInternalRunner({ projectRoot: process.cwd(), agentType });
    }
    return;
  }
  if (cmd === "chat") {
    await runChat(process.cwd());
    return;
  }

  // Handle resume command to launch agent in interactive mode
  if (cmd === "resume") {
    const target = process.argv[3];
    if (!target) {
      console.error("Error: resume requires an agent type");
      console.error("Usage: ufoo resume <ucode|uclaude|ucodex>");
      console.error("");
      console.error("Examples:");
      console.error("  ufoo resume ucode      # Resume/start ucode agent");
      console.error("  ufoo resume uclaude    # Resume/start uclaude agent");
      console.error("  ufoo resume ucodex     # Resume/start ucodex agent");
      process.exitCode = 1;
      return;
    }

    // Map agent type to script path
    const targetLower = target.toLowerCase();
    const path = require("path");
    const { spawn } = require("child_process");

    let scriptName = "";
    if (targetLower === "ucode" || targetLower === "ufoo-code" || targetLower === "ufoo") {
      scriptName = "ucode.js";
    } else if (targetLower === "uclaude" || targetLower === "claude-code" || targetLower === "claude") {
      scriptName = "uclaude.js";
    } else if (targetLower === "ucodex" || targetLower === "codex" || targetLower === "openai") {
      scriptName = "ucodex.js";
    } else {
      console.error(`Error: Unknown agent type '${target}'`);
      console.error("Valid types: ucode, uclaude, ucodex");
      process.exitCode = 1;
      return;
    }

    // Run the agent script directly
    const scriptPath = path.join(__dirname, scriptName);
    console.log(`Starting ${target} session...`);

    // Spawn the agent process and inherit stdio for interactive mode
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });

    child.on("exit", (code) => {
      process.exit(code || 0);
    });

    return;
  }

  await runCli(process.argv);
}

main().catch((err) => {
  const message = err && err.stack ? err.stack : String(err);
  console.error(message);
  process.exitCode = 1;
});

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

  // Handle resume command to connect to existing agent or launch new one
  if (cmd === "resume") {
    const target = process.argv[3];
    if (!target) {
      console.error("Error: resume requires an agent type or nickname");
      console.error("Usage: ufoo resume <ucode|uclaude|ucodex|nickname>");
      console.error("");
      console.error("Examples:");
      console.error("  ufoo resume ucode      # Start new ucode agent");
      console.error("  ufoo resume ucode-1    # Connect to existing agent with nickname");
      console.error("  ufoo resume uclaude    # Start new uclaude agent");
      process.exitCode = 1;
      return;
    }

    const { execSync } = require("child_process");
    const path = require("path");
    const { spawn } = require("child_process");

    // First check if it's a nickname for an existing online agent
    try {
      const statusOutput = execSync("ufoo bus status", { encoding: "utf8", cwd: process.cwd() });

      // Parse online agents
      const onlineAgents = [];
      const lines = statusOutput.split("\n");
      let inOnlineSection = false;

      for (const line of lines) {
        if (line.includes("Online agents:")) {
          inOnlineSection = true;
          continue;
        }
        if (inOnlineSection) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          if (trimmedLine.includes("Event statistics:") || trimmedLine.includes("===")) {
            inOnlineSection = false;
            continue;
          }
          // Parse agent line: "ufoo-code:abc123 (nickname)"
          const agentMatch = trimmedLine.match(/^[-\s]*([a-z-]+:[a-f0-9]+|[a-z-]+)(?:\s+\(([^)]+)\))?/i);
          if (agentMatch) {
            const subscriberId = agentMatch[1];
            const nickname = agentMatch[2] || "";
            onlineAgents.push({ subscriberId, nickname });
          }
        }
      }

      // Check if target matches any online agent's nickname
      for (const agent of onlineAgents) {
        if (agent.nickname && agent.nickname === target) {
          // Found an online agent with this nickname - connect to it via chat
          console.log(`Connecting to existing agent: ${agent.subscriberId} (${agent.nickname})`);
          console.log("Opening chat interface...");

          // Set environment variable to auto-connect
          process.env.UFOO_RESUME_TARGET = agent.subscriberId;
          await runChat(process.cwd());
          return;
        }
      }
    } catch (err) {
      // Ignore errors from bus status check
    }

    // Not an existing online agent - check if it's an agent type to launch
    const targetLower = target.toLowerCase();
    let scriptName = "";

    if (targetLower === "ucode" || targetLower === "ufoo-code" || targetLower === "ufoo") {
      scriptName = "ucode.js";
    } else if (targetLower === "uclaude" || targetLower === "claude-code" || targetLower === "claude") {
      scriptName = "uclaude.js";
    } else if (targetLower === "ucodex" || targetLower === "codex" || targetLower === "openai") {
      scriptName = "ucodex.js";
    } else {
      // Not a valid agent type - might be an offline agent nickname
      console.error(`Error: Agent '${target}' is not online and is not a valid agent type`);
      console.error("");
      console.error("Valid agent types: ucode, uclaude, ucodex");
      console.error("");
      console.error("To see online agents, run: ufoo bus status");
      process.exitCode = 1;
      return;
    }

    // Run the agent script directly for a new session
    const scriptPath = path.join(__dirname, scriptName);
    console.log(`Starting new ${target} session...`);

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

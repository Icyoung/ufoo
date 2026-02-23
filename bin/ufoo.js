#!/usr/bin/env node
/* eslint-disable no-console */
const { runCli } = require("../src/cli");
const { runDaemonCli } = require("../src/daemon/run");
const { runChat } = require("../src/chat");
const { runInternalRunner } = require("../src/agent/internalRunner");
const { runPtyRunner } = require("../src/agent/ptyRunner");
const { execSync } = require("child_process");

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

  // Handle resume command to launch/resume agent sessions
  if (cmd === "resume") {
    const target = process.argv[3];
    if (!target) {
      console.error("Error: resume requires an agent type or nickname");
      console.error("Usage: ufoo resume <ucode|uclaude|ucodex|nickname>");
      console.error("");
      console.error("Examples:");
      console.error("  ufoo resume ucode      # Resume/start ucode agent");
      console.error("  ufoo resume uclaude    # Resume/start uclaude agent");
      console.error("  ufoo resume ucodex     # Resume/start ucodex agent");
      process.exitCode = 1;
      return;
    }

    // Map common agent names to their types
    const targetLower = target.toLowerCase();
    let agentType = "";

    // Direct agent type mapping
    if (targetLower === "ucode" || targetLower === "ufoo-code" || targetLower === "ufoo") {
      agentType = "ufoo";  // ucode uses "ufoo" as internal type
    } else if (targetLower === "uclaude" || targetLower === "claude-code" || targetLower === "claude") {
      agentType = "claude";
    } else if (targetLower === "ucodex" || targetLower === "codex" || targetLower === "openai") {
      agentType = "codex";
    } else {
      // Try to check if it's a nickname for an existing agent
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
            const agentMatch = trimmedLine.match(/^[-\s]*([a-z-]+:[a-f0-9]+|[a-z-]+)(?:\s+\(([^)]+)\))?/i);
            if (agentMatch) {
              const subscriberId = agentMatch[1];
              const nickname = agentMatch[2] || "";
              onlineAgents.push({ subscriberId, nickname });
            }
          }
        }

        // Find matching agent by nickname
        for (const agent of onlineAgents) {
          if (agent.nickname && agent.nickname.toLowerCase() === targetLower) {
            // Determine agent type from subscriber ID
            if (agent.subscriberId.startsWith("ufoo-code:")) {
              agentType = "ufoo";
            } else if (agent.subscriberId.startsWith("claude-code:")) {
              agentType = "claude";
            } else if (agent.subscriberId.startsWith("codex:")) {
              agentType = "codex";
            }
            break;
          }
        }
      } catch {
        // Ignore errors from bus status check
      }

      if (!agentType) {
        console.error(`Error: Unknown agent type '${target}'`);
        console.error("Valid types: ucode, uclaude, ucodex");
        process.exitCode = 1;
        return;
      }
    }

    // Launch the agent using agent-pty-runner
    console.log(`Resuming ${target} session...`);
    try {
      await runPtyRunner({ projectRoot: process.cwd(), agentType });
    } catch (err) {
      // Fallback to headless runner if PTY is unavailable
      console.error(`[pty-runner] ${err.message || err}. Falling back to headless internal runner.`);
      await runInternalRunner({ projectRoot: process.cwd(), agentType });
    }
    return;
  }

  await runCli(process.argv);
}

main().catch((err) => {
  const message = err && err.stack ? err.stack : String(err);
  console.error(message);
  process.exitCode = 1;
});

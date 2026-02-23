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

  // Handle resume command specially to connect to online agents
  if (cmd === "resume") {
    const target = process.argv[3];
    if (!target) {
      console.error("Error: resume requires a nickname or subscriber ID");
      console.error("Usage: ufoo resume <nickname|subscriber-id>");
      process.exitCode = 1;
      return;
    }

    try {
      // Get bus status to check online agents
      const statusOutput = execSync("ufoo bus status", { encoding: "utf8", cwd: process.cwd() });

      // Parse online agents from status output
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
          if (!trimmedLine) {
            // Empty line might indicate section end
            continue;
          }
          // Check for lines that don't look like agent entries
          if (trimmedLine.includes("Event statistics:") || trimmedLine.includes("===")) {
            inOnlineSection = false;
            continue;
          }
          // Parse agent line - handle both formats with/without leading dash
          // Format 1: "- ufoo-code:abc123 (ucode)"
          // Format 2: "  ufoo-code:abc123 (ucode)"
          const agentMatch = trimmedLine.match(/^[-\s]*([a-z-]+:[a-f0-9]+|[a-z-]+)(?:\s+\(([^)]+)\))?/i);
          if (agentMatch) {
            const subscriberId = agentMatch[1];
            const nickname = agentMatch[2] || "";
            onlineAgents.push({ subscriberId, nickname });
          }
        }
      }

      // Find matching agent
      let matchedAgent = null;
      const targetLower = target.toLowerCase();

      for (const agent of onlineAgents) {
        // Check exact subscriber ID match
        if (agent.subscriberId === target) {
          matchedAgent = agent;
          break;
        }
        // Check nickname match (case insensitive)
        if (agent.nickname && agent.nickname.toLowerCase() === targetLower) {
          matchedAgent = agent;
          break;
        }
        // Check partial subscriber ID match (e.g., "ucode" matches "ufoo-code:xxx")
        if (agent.subscriberId.toLowerCase().startsWith(targetLower + ":")) {
          matchedAgent = agent;
          break;
        }
      }

      if (!matchedAgent) {
        console.error(`Error: Agent '${target}' is not online`);
        console.error("\nOnline agents:");
        if (onlineAgents.length === 0) {
          console.error("  (none)");
        } else {
          for (const agent of onlineAgents) {
            const label = agent.nickname ? ` (${agent.nickname})` : "";
            console.error(`  - ${agent.subscriberId}${label}`);
          }
        }
        process.exitCode = 1;
        return;
      }

      // Start chat session with auto-connect to the matched agent
      const label = matchedAgent.nickname ? ` (${matchedAgent.nickname})` : "";
      console.log(`Resuming session with ${matchedAgent.subscriberId}${label}...`);

      // Set environment variable to auto-connect to the agent
      process.env.UFOO_RESUME_TARGET = matchedAgent.subscriberId;
      await runChat(process.cwd());
    } catch (err) {
      console.error(`Error: ${err.message || err}`);
      process.exitCode = 1;
      return;
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

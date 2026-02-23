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

  // Handle resume command as an alias for launch
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

    // Pass through to launch command
    const args = ["launch", target];
    await runCli(["node", "ufoo", ...args]);
    return;
  }

  await runCli(process.argv);
}

main().catch((err) => {
  const message = err && err.stack ? err.stack : String(err);
  console.error(message);
  process.exitCode = 1;
});

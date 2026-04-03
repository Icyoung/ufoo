#!/usr/bin/env node
/**
 * uclaude: Launch Claude Code and auto-join event bus
 *
 * Usage: uclaude [claude args...]
 */

const AgentLauncher = require("../src/agent/launcher");
const { resolveDefaultManualBootstrap } = require("../src/agent/defaultBootstrap");

const launcher = new AgentLauncher("claude-code", "claude");
const resolved = resolveDefaultManualBootstrap({
  projectRoot: process.cwd(),
  agentType: "claude-code",
  args: process.argv.slice(2),
  env: process.env,
});

for (const [key, value] of Object.entries(resolved.env || {})) {
  process.env[key] = String(value);
}

launcher.launch(resolved.args);

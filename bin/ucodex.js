#!/usr/bin/env node
/**
 * ucodex: Launch Codex and auto-join event bus
 *
 * Usage: ucodex [codex args...]
 */

const AgentLauncher = require("../src/agent/launcher");
const { resolveDefaultManualBootstrap } = require("../src/agent/defaultBootstrap");

const launcher = new AgentLauncher("codex", "codex");
const resolved = resolveDefaultManualBootstrap({
  projectRoot: process.cwd(),
  agentType: "codex",
  args: process.argv.slice(2),
  env: process.env,
});

for (const [key, value] of Object.entries(resolved.env || {})) {
  process.env[key] = String(value);
}

launcher.launch(resolved.args);

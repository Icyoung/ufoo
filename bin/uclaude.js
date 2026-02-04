#!/usr/bin/env node
/**
 * uclaude: Launch Claude Code and auto-join event bus
 *
 * Usage: uclaude [claude args...]
 */

const AgentLauncher = require("../src/agent/launcher");

const launcher = new AgentLauncher("claude-code", "claude");
const args = process.argv.slice(2);

launcher.launch(args);

#!/usr/bin/env node
/**
 * ucodex: Launch Codex and auto-join event bus
 *
 * Usage: ucodex [codex args...]
 */

const AgentLauncher = require("../src/agent/launcher");

const launcher = new AgentLauncher("codex", "codex");
const args = process.argv.slice(2);

launcher.launch(args);

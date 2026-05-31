#!/usr/bin/env node
/**
 * ucodex: Launch Codex and auto-join event bus
 *
 * Usage: ucodex [codex args...]
 */

const AgentLauncher = require("../src/agents/launch/launcher");
const { resolveDefaultManualBootstrap } = require("../src/agents/prompts/defaultBootstrap");

function extractUfooParamsFromArgs(args = []) {
  const nextArgs = [];
  let nickname = "";
  let role = "";
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] || "");
    if (arg === "--nickname") {
      if (i + 1 < args.length) {
        nickname = String(args[i + 1]).trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--nickname=")) {
      nickname = arg.slice("--nickname=".length).trim();
      continue;
    }
    if (arg === "--role") {
      if (i + 1 < args.length) {
        role = String(args[i + 1]).trim();
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--role=")) {
      role = arg.slice("--role=".length).trim();
      continue;
    }
    nextArgs.push(args[i]);
  }
  return { args: nextArgs, nickname, role };
}

const { args: cleanArgs, nickname, role } = extractUfooParamsFromArgs(process.argv.slice(2));
if (nickname) {
  process.env.UFOO_NICKNAME = nickname;
}
if (role) {
  process.env.UFOO_PROMPT_PROFILE = role;
}

const launcher = new AgentLauncher("codex", "codex");
const resolved = resolveDefaultManualBootstrap({
  projectRoot: process.cwd(),
  agentType: "codex",
  args: cleanArgs,
  env: process.env,
});

for (const [key, value] of Object.entries(resolved.env || {})) {
  process.env[key] = String(value);
}

launcher.launch(resolved.args);

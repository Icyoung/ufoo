#!/usr/bin/env node
/**
 * ugrok: Launch Grok Build CLI (grok) and auto-join the ufoo event bus.
 *
 * Usage: ugrok [grok args...]
 *
 * Grok Build accepts an initial positional prompt and a --rules system
 * prompt extension, so ufoo bootstrap is prepared before launch instead of
 * relying on post-launch PTY injection.
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

const launcher = new AgentLauncher("grok", "grok");
const resolved = resolveDefaultManualBootstrap({
  projectRoot: process.cwd(),
  agentType: "grok",
  args: cleanArgs,
  env: process.env,
});

for (const [key, value] of Object.entries(resolved.env || {})) {
  process.env[key] = String(value);
}

launcher.launch(resolved.args);

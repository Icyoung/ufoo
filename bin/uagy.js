#!/usr/bin/env node
/**
 * uagy: Launch Antigravity CLI (agy) and auto-join the ufoo event bus.
 *
 * Usage: uagy [agy args...]
 *
 * Differences vs ucodex / uclaude:
 *   - agy is authenticated via Google OAuth + the OS keyring; ufoo does NOT
 *     manage credentials. Requires an account that is eligible for
 *     Antigravity (18+, supported region).
 *   - Model selection is in-REPL via `/model` (no command-line flag),
 *     so we never inject --model.
 *   - Session resume uses agy's own conversation UUIDs: when a previous
 *     session is found for the current tty/tmux pane, we pass
 *     `--conversation=<UUID>`. The id is captured on the previous exit by
 *     grepping the `Resume: agy --conversation=<UUID>` line agy prints to
 *     stdout right before quitting (see src/agent/launcher.js +
 *     src/agent/agyConversation.js).
 */

const AgentLauncher = require("../src/agent/launcher");
const { resolveDefaultManualBootstrap } = require("../src/agent/defaultBootstrap");
const {
  readPreviousConversationId,
  buildAgyLaunchArgs,
} = require("../src/agent/agyConversation");

const cwd = process.cwd();

// Resume: read the most recent conversation UUID recorded for the current
// tty/tmux pane. If found, agy will receive --conversation=<id>.
//
// IMPORTANT: use the launcher's own tty detection (shell `tty` command) so
// the value here matches what the launcher will later record on the agent
// meta. Reading only env vars (UFOO_TTY_OVERRIDE / TMUX_PANE) means
// autoResume silently no-ops for typical terminal users.
const ttyForLookup = (AgentLauncher._getEnvTtyOverride && AgentLauncher._getEnvTtyOverride())
  || (AgentLauncher._detectTtyOnce && AgentLauncher._detectTtyOnce())
  || "";
const previousConversationId = readPreviousConversationId(cwd, {
  tty: ttyForLookup,
  tmuxPane: process.env.TMUX_PANE || "",
});

// In internal / unattended modes, auto-approve tool prompts so the agent
// doesn't stall waiting on a y/n the operator can't see. Terminal/tmux
// modes leave permissions in the user's hands (agy's default).
const launchMode = String(process.env.UFOO_LAUNCH_MODE || "").trim().toLowerCase();
const skipPermissions = launchMode === "internal" || launchMode === "internal-pty";

const launchArgs = buildAgyLaunchArgs({
  userArgs: process.argv.slice(2),
  previousConversationId,
  skipPermissions,
});

const launcher = new AgentLauncher("agy", "agy");
const resolved = resolveDefaultManualBootstrap({
  projectRoot: cwd,
  agentType: "agy",
  args: launchArgs,
  env: process.env,
});

for (const [key, value] of Object.entries(resolved.env || {})) {
  process.env[key] = String(value);
}

launcher.launch(resolved.args);

"use strict";

/**
 * Agy (Antigravity CLI) conversation-id capture and reuse.
 *
 * Agy ends every TUI session by printing a single line to stdout:
 *
 *   Resume: agy --conversation=<UUID> (or -c)
 *
 * We grep this line out of the PTY output ring buffer and persist the UUID
 * onto the agent meta as `provider_session_id`, so the next launch of agy
 * on the same tty/tmux pane can pass `--conversation=<UUID>` to pick up
 * exactly that conversation.
 *
 * The launcher writes the id; bin/uagy.js reads it back before spawning.
 */

const fs = require("fs");
const path = require("path");

const { getUfooPaths } = require("../ufoo/paths");
const { isAgentPidAlive } = require("../bus/utils");

// Capture group is a UUID v4-ish; agy uses standard 8-4-4-4-12 hex form.
// Allow trailing whitespace and anything after the close paren on the line.
const RESUME_LINE_RE =
  /Resume:\s+agy\s+--conversation=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

function extractResumeConversationId(text = "") {
  const str = String(text || "");
  if (!str) return "";
  const match = str.match(RESUME_LINE_RE);
  return match ? match[1] : "";
}

function readAgentsRegistry(projectRoot) {
  try {
    const file = getUfooPaths(projectRoot).agentsFile;
    if (!fs.existsSync(file)) return { file, data: null };
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return { file, data };
  } catch {
    return { file: "", data: null };
  }
}

/**
 * Look up the most recent agy conversation id for the given tty/tmux pane.
 *
 * Mirrors src/agent/launcher.js#findPreviousSession but only inspects
 * `meta.provider_session_id`. Returns "" when none found.
 *
 * Selection rules (in this order):
 *   1. Only `agy:` subscribers
 *   2. tmux_pane match (when supplied) or tty match (fallback)
 *   3. Skip entries whose pid is still alive — that session is still
 *      running, stealing its id would resume into the live process
 *   4. Among remaining candidates, pick the one with the most recent
 *      `provider_session_updated_at` (insertion-order fallback when no
 *      timestamp is present)
 */
function readPreviousConversationId(projectRoot, { tty = "", tmuxPane = "" } = {}) {
  if (!projectRoot) return "";
  if (!tty && !tmuxPane) return "";
  const { data } = readAgentsRegistry(projectRoot);
  if (!data || !data.agents) return "";

  const candidates = [];
  for (const [subscriberId, meta] of Object.entries(data.agents)) {
    if (!subscriberId.startsWith("agy:")) continue;
    if (!meta || typeof meta !== "object") continue;
    if (tmuxPane) {
      if (meta.tmux_pane !== tmuxPane) continue;
    } else if (tty) {
      if (meta.tty !== tty) continue;
    } else {
      continue;
    }
    const id = String(meta.provider_session_id || "").trim();
    if (!id) continue;

    // Skip sessions whose owning process is still alive — their
    // conversation id belongs to a running TUI, not a closed one.
    const pid = Number.parseInt(meta.pid, 10);
    if (Number.isFinite(pid) && pid > 0 && isAgentPidAlive(pid)) continue;

    const updatedAt = Date.parse(String(meta.provider_session_updated_at || "")) || 0;
    candidates.push({ id, updatedAt });
  }
  if (candidates.length === 0) return "";
  candidates.sort((a, b) => b.updatedAt - a.updatedAt);
  return candidates[0].id;
}

function persistConversationId(projectRoot, subscriberId, conversationId) {
  const id = String(conversationId || "").trim();
  if (!projectRoot || !subscriberId || !id) return false;
  try {
    const file = getUfooPaths(projectRoot).agentsFile;
    if (!fs.existsSync(file)) return false;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || !data.agents || !data.agents[subscriberId]) return false;
    if (data.agents[subscriberId].provider_session_id === id) return false;
    data.agents[subscriberId].provider_session_id = id;
    data.agents[subscriberId].provider_session_updated_at = new Date().toISOString();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the agy command-line args for a fresh launch:
 *   - prepend --conversation=<uuid> if previousConversationId is set
 *     (unless the user already passed --continue / -c / --conversation)
 *   - prepend --dangerously-skip-permissions in internal/auto-approve mode
 *   - return the args caller hands to AgentLauncher.launch()
 *
 * Bootstrap merging (i.e. `-i <text>`) is handled by defaultBootstrap.js;
 * this helper only deals with the resume + permission flags.
 */
function buildAgyLaunchArgs({
  userArgs = [],
  previousConversationId = "",
  skipPermissions = false,
} = {}) {
  const args = Array.isArray(userArgs) ? userArgs.slice() : [];
  const flat = args.map((item) => String(item || "").trim()).filter(Boolean);

  const userHasResume = flat.some((item) =>
    item === "-c"
    || item === "--continue"
    || item === "--conversation"
    || item.startsWith("--conversation=")
  );
  const userHasSkipPerms = flat.includes("--dangerously-skip-permissions");

  const out = [];
  if (skipPermissions && !userHasSkipPerms) {
    out.push("--dangerously-skip-permissions");
  }
  const resumeId = String(previousConversationId || "").trim();
  if (resumeId && !userHasResume) {
    out.push(`--conversation=${resumeId}`);
  }
  out.push(...args);
  return out;
}

module.exports = {
  RESUME_LINE_RE,
  extractResumeConversationId,
  readPreviousConversationId,
  persistConversationId,
  buildAgyLaunchArgs,
};

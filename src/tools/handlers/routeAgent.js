"use strict";

const fs = require("fs");
const { getUfooPaths } = require("../../coordination/state/paths");
const { isMetaActive } = require("../../coordination/bus/utils");
const { isInternalAgentMeta } = require("../../runtime/contracts/agentMode");
const { buildToolError } = require("./common");

/** Read-only routing preview. Selection never launches or dispatches work. */
function routeAgentHandler(ctx = {}, args = {}) {
  if (typeof args.request !== "string" || !args.request.trim()) throw buildToolError("invalid_arguments", "route_agent requires request");
  const file = getUfooPaths(ctx.projectRoot).agentsFile;
  const bus = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { agents: {} };
  const hint = String(args.context_hint || "").toLowerCase();
  const text = `${args.request} ${hint}`.toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9_-]{3,}/g) || []);
  const candidates = Object.entries(bus.agents || {}).filter(([id, meta]) => (
    id !== "ufoo-agent" && meta.agent_type !== "ufoo-agent" && isMetaActive(meta)
      && (!ctx.internalAgentsOnly || isInternalAgentMeta(meta))
  )).map(([id, meta]) => {
    const nickname = String(meta.nickname || "");
    const role = String(meta.role || meta.solo_role || meta.prompt_profile || "").toLowerCase();
    const explicit = [id, nickname].some((name) => name && (hint === name.toLowerCase() || text.includes(`@${name.toLowerCase()}`)));
    const matches = [...tokens].filter((token) => role.includes(token)).length;
    const idle = ["idle", "waiting", ""].includes(meta.activity_state || "");
    return { id, nickname, explicit, matches, idle, score: (explicit ? 100 : 0) + matches * 10 + (idle ? 1 : 0) };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = candidates[0];
  if (!selected) return { target: "", nickname: "", reason: "No active worker in this project; choose direct execution or launch explicitly.", confidence: 0 };
  return { target: selected.id, nickname: selected.nickname,
    reason: selected.explicit ? "Explicit worker reference" : selected.matches ? "Matching role/profile" : selected.idle ? "Available project worker" : "Active project worker; currently busy",
    confidence: selected.explicit ? 1 : selected.matches ? 0.8 : 0.4 };
}

module.exports = { routeAgentHandler };

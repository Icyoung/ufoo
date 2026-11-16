"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../../coordination/state/paths");
const { getReportPaths } = require("../../coordination/report/store");
const { isMetaActive } = require("../../coordination/bus/utils");
const { isInternalAgentMeta } = require("../../runtime/contracts/agentMode");
const { buildToolError } = require("./common");

function extractRoutingTokens(text) {
  const input = String(text || "").toLowerCase();
  const tokens = new Set(input.match(/[a-z0-9_.-]{3,}/g) || []);
  const paths = input.match(/[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)+/g) || [];
  for (const p of paths) {
    tokens.add(p);
    const base = path.posix.basename(p);
    if (base) tokens.add(base);
  }
  const cjkRuns = input.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.add(run.slice(i, i + 2));
    }
  }
  return tokens;
}

function readRecentReportsByAgent(projectRoot, maxLines = 100) {
  const byAgent = new Map();
  if (!projectRoot) return byAgent;
  try {
    const { reportsFile } = getReportPaths(projectRoot);
    if (!fs.existsSync(reportsFile)) return byAgent;
    const raw = fs.readFileSync(reportsFile, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim()).slice(-maxLines);
    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const agentId = String(row && (row.agent_id || row.agentId) || "").trim();
      if (!agentId) continue;
      if (!byAgent.has(agentId)) byAgent.set(agentId, []);
      byAgent.get(agentId).push(row);
    }
  } catch {}
  return byAgent;
}

function buildWorkerHistorySignals(ctx = {}) {
  const signals = new Map();
  const appendText = (agentId, chunk) => {
    const id = String(agentId || "").trim();
    if (!id) return;
    if (!signals.has(id)) signals.set(id, { text: "", consecutiveErrors: 0 });
    const entry = signals.get(id);
    if (chunk) entry.text += `\n${String(chunk).toLowerCase()}`;
  };

  try {
    const tasks = ctx.agentManagement && typeof ctx.agentManagement.snapshot === "function"
      ? Object.values(ctx.agentManagement.snapshot().tasks || {})
      : [];
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      const workerId = task.agentId || task.target || task.workerId || "";
      if (!workerId) continue;
      appendText(workerId, [
        task.objective,
        task.topic,
        task.summary,
        ...(Array.isArray(task.modifiedFiles) ? task.modifiedFiles : []),
        ...(Array.isArray(task.touchedFiles) ? task.touchedFiles : []),
      ].filter(Boolean).join(" "));
    }
  } catch {}

  const reportsByAgent = readRecentReportsByAgent(ctx.projectRoot, 100);
  for (const [agentId, rows] of reportsByAgent.entries()) {
    for (const row of rows) {
      appendText(agentId, [
        row.summary,
        row.message,
        row.error,
        row.meta ? JSON.stringify(row.meta) : "",
      ].filter(Boolean).join(" "));
    }
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.phase === "start" || row.phase === "progress") continue;
      if (row.ok === false || row.phase === "error") streak += 1;
      else break;
    }
    if (!signals.has(agentId)) signals.set(agentId, { text: "", consecutiveErrors: streak });
    else signals.get(agentId).consecutiveErrors = streak;
  }

  return signals;
}

/** Read-only routing preview. Selection never launches or dispatches work. */
function routeAgentHandler(ctx = {}, args = {}) {
  if (typeof args.request !== "string" || !args.request.trim()) throw buildToolError("invalid_arguments", "route_agent requires request");
  const file = getUfooPaths(ctx.projectRoot).agentsFile;
  const bus = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { agents: {} };
  const hint = String(args.context_hint || "").toLowerCase();
  const text = `${args.request} ${hint}`.toLowerCase();
  const tokens = extractRoutingTokens(text);
  const historySignals = buildWorkerHistorySignals(ctx);
  const candidates = Object.entries(bus.agents || {}).filter(([id, meta]) => (
    id !== "ufoo-agent" && meta.agent_type !== "ufoo-agent" && isMetaActive(meta)
      && (!ctx.internalAgentsOnly || ctx.includeExternalAgents || isInternalAgentMeta(meta))
  )).map(([id, meta]) => {
    const nickname = String(meta.nickname || "");
    const role = String(meta.role || meta.solo_role || meta.prompt_profile || "").toLowerCase();
    const explicit = [id, nickname].some((name) => name && (hint === name.toLowerCase() || text.includes(`@${name.toLowerCase()}`)));
    const matches = [...tokens].filter((token) => role.includes(token)).length;
    const workerHistory = historySignals.get(id) || { text: "", consecutiveErrors: 0 };
    const historyMatches = workerHistory.text
      ? [...tokens].filter((token) => workerHistory.text.includes(token)).length
      : 0;
    const idle = ["idle", "waiting", ""].includes(meta.activity_state || "");
    const errorPenalty = workerHistory.consecutiveErrors >= 2 ? 5 : 0;
    const score = (explicit ? 100 : 0)
      + matches * 10
      + Math.min(32, historyMatches * 8)
      + (idle ? 2 : 0)
      - errorPenalty;
    return { id, nickname, explicit, matches, historyMatches, idle, score };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = candidates[0];
  if (!selected) return { target: "", nickname: "", reason: "No active worker in this project; choose direct execution or launch explicitly.", confidence: 0 };
  return { target: selected.id, nickname: selected.nickname,
    reason: selected.explicit
      ? "Explicit worker reference"
      : selected.matches && selected.historyMatches
        ? "Matching role and prior file/topic history"
        : selected.historyMatches
          ? "Prior file/topic experience in recent reports/tasks"
          : selected.matches
            ? "Matching role/profile"
            : selected.idle
              ? "Available project worker"
              : "Active project worker; currently busy",
    confidence: selected.explicit ? 1 : (selected.matches || selected.historyMatches) ? 0.85 : 0.4 };
}

module.exports = { routeAgentHandler };

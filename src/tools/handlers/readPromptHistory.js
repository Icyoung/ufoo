const fs = require("fs");
const path = require("path");

const { buildStatus } = require("../../daemon/status");
const { getUfooPaths } = require("../../ufoo/paths");

function clipPromptText(value = "", maxChars = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...[truncated]`;
}

function buildPromptHistory(projectRoot, activeAgents = [], args = {}) {
  const perAgentLimit = Number.isFinite(Number(args.per_agent_limit)) && Number(args.per_agent_limit) > 0
    ? Math.floor(Number(args.per_agent_limit))
    : 6;
  const maxFiles = Number.isFinite(Number(args.max_files)) && Number(args.max_files) > 0
    ? Math.floor(Number(args.max_files))
    : 3;
  const target = String(args.target || "").trim();
  const eventsDir = getUfooPaths(projectRoot).busEventsDir;
  const activeIds = new Set(activeAgents.map((item) => String(item.id || "")).filter(Boolean));
  const nicknames = {};
  const rows = new Map();

  for (const item of activeAgents) {
    if (!item || !item.id) continue;
    const id = String(item.id);
    const nickname = String(item.nickname || "");
    if (nickname) nicknames[nickname] = id;
    rows.set(id, {
      agent_id: id,
      nickname,
      samples: [],
      sample_count: 0,
      total_count: 0,
      last_ts: "",
    });
  }

  if (target) {
    const resolved = activeIds.has(target) ? target : nicknames[target];
    if (resolved) {
      for (const id of Array.from(rows.keys())) {
        if (id !== resolved) rows.delete(id);
      }
    }
  }

  let files = [];
  try {
    files = fs.readdirSync(eventsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .slice(-maxFiles)
      .reverse();
  } catch {
    return { scanned_files: 0, matched_events: 0, per_agent: [] };
  }

  let matchedEvents = 0;
  for (const file of files) {
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(eventsDir, file), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .reverse();
    } catch {
      continue;
    }

    for (const line of lines) {
      let event = null;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || event.event !== "message") continue;
      const message = clipPromptText(event.data && event.data.message);
      if (!message) continue;
      const rawTarget = String(event.target || "").trim();
      const agentId = rows.has(rawTarget) ? rawTarget : nicknames[rawTarget];
      if (!agentId || !rows.has(agentId)) continue;

      const row = rows.get(agentId);
      matchedEvents += 1;
      row.total_count += 1;
      if (!row.last_ts) row.last_ts = String(event.timestamp || "");
      if (row.samples.length < perAgentLimit) {
        row.samples.push({
          ts: String(event.timestamp || ""),
          publisher: String(event.publisher || ""),
          prompt: message,
        });
        row.sample_count = row.samples.length;
      }
    }
  }

  const perAgent = Array.from(rows.values())
    .filter((row) => row.total_count > 0)
    .sort((a, b) => String(b.last_ts || "").localeCompare(String(a.last_ts || "")));

  return {
    scanned_files: files.length,
    matched_events: matchedEvents,
    per_agent: perAgent,
  };
}

function readPromptHistoryHandler(ctx = {}, args = {}) {
  const status = buildStatus(ctx.projectRoot);
  const activeAgents = Array.isArray(status.active_meta) ? status.active_meta : [];
  return buildPromptHistory(ctx.projectRoot, activeAgents, args);
}

module.exports = {
  buildPromptHistory,
  readPromptHistoryHandler,
};

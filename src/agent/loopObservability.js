"use strict";

const fs = require("fs");
const path = require("path");
const { getUfooPaths } = require("../ufoo/paths");
const { redactSecrets } = require("../providerapi/redactor");

const LOOP_EVENT_SCHEMA_VERSION = 1;

function getLoopObservabilityPaths(projectRoot) {
  const { agentDir } = getUfooPaths(projectRoot);
  return {
    eventsFile: path.join(agentDir, "ufoo-agent.loop-events.jsonl"),
    auditFile: path.join(agentDir, "ufoo-agent.audit.jsonl"),
  };
}

function getShadowObservabilityPaths(projectRoot, now = new Date()) {
  const { ufooDir } = getUfooPaths(projectRoot);
  const stamp = now.toISOString().slice(0, 10);
  return {
    shadowDir: path.join(ufooDir, "shadow"),
    diffFile: path.join(ufooDir, "shadow", `diff-${stamp}.jsonl`),
  };
}

function appendJsonLine(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(redactSecrets(payload))}\n`, "utf8");
}

function appendShadowDiff(projectRoot, payload = {}, now = new Date()) {
  if (!projectRoot) return null;
  const { diffFile } = getShadowObservabilityPaths(projectRoot, now);
  appendJsonLine(diffFile, {
    schema_version: LOOP_EVENT_SCHEMA_VERSION,
    ts: now.toISOString(),
    shadow_only: true,
    ...payload,
  });
  return diffFile;
}

function createLoopObserver({ projectRoot, enabled = true, defaults = {} } = {}) {
  const paths = projectRoot ? getLoopObservabilityPaths(projectRoot) : null;
  const baseDefaults = defaults && typeof defaults === "object" ? { ...defaults } : {};

  function emit(event, payload = {}) {
    if (!enabled || !paths) return;
    appendJsonLine(paths.eventsFile, {
      schema_version: LOOP_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      event: String(event || "").trim() || "unknown",
      ...baseDefaults,
      ...payload,
    });
  }

  function audit(payload = {}) {
    if (!enabled || !paths) return;
    appendJsonLine(paths.auditFile, {
      schema_version: LOOP_EVENT_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      ...baseDefaults,
      ...payload,
    });
  }

  return {
    emit,
    audit,
    paths,
  };
}

function readRecentLoopSummary(projectRoot, options = {}) {
  if (!projectRoot) return null;
  const { eventsFile } = getLoopObservabilityPaths(projectRoot);
  if (!fs.existsSync(eventsFile)) return null;

  const maxLines = Number.isFinite(options.maxLines) && options.maxLines > 0
    ? Math.floor(options.maxLines)
    : 400;

  let rows = [];
  try {
    rows = fs.readFileSync(eventsFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-maxLines)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return null;
  }

  if (rows.length === 0) return null;

  let startIndex = 0;
  let endIndex = rows.length;
  let terminalIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] && rows[i].event === "loop_terminal") {
      terminalIndex = i;
      endIndex = i + 1;
      break;
    }
  }
  if (terminalIndex >= 0) {
    for (let i = terminalIndex - 1; i >= 0; i -= 1) {
      if (rows[i] && rows[i].event === "loop_terminal") {
        startIndex = i + 1;
        break;
      }
    }
  }

  const segment = rows.slice(startIndex, endIndex);
  if (segment.length === 0) return null;

  const toolCounts = new Map();
  const summary = {
    status: terminalIndex >= 0 ? "completed" : "in_progress",
    event_count: segment.length,
    model_calls: 0,
    rounds: 0,
    tool_calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cache_semistatic_hit: 0,
    cache_semistatic_miss: 0,
    memory_prefix_tokens: 0,
    dynamic_memory_tokens: 0,
    total_tokens: 0,
    total_latency_ms: 0,
    first_token_ms: 0,
    terminal_reason: "",
    started_at: "",
    ended_at: "",
    tools: [],
  };

  for (const row of segment) {
    if (!summary.started_at && row.ts) summary.started_at = String(row.ts);
    if (row.ts) summary.ended_at = String(row.ts);
    if (row.event === "model_call") {
      summary.model_calls += 1;
      summary.rounds = Math.max(summary.rounds, Number(row.round) || 0);
      summary.input_tokens += Number(row.input_tokens) || 0;
      summary.output_tokens += Number(row.output_tokens) || 0;
      summary.cache_read_tokens += Number(row.cache_read_tokens) || 0;
      summary.cache_creation_tokens += Number(row.cache_creation_tokens) || 0;
      summary.cache_semistatic_hit += Number(row.cache_semistatic_hit) || 0;
      summary.cache_semistatic_miss += Number(row.cache_semistatic_miss) || 0;
      summary.memory_prefix_tokens += Number(row.memory_prefix_tokens) || 0;
      summary.dynamic_memory_tokens += Number(row.dynamic_memory_tokens) || 0;
      summary.total_latency_ms += Number(row.latency_ms) || 0;
      summary.first_token_ms += Number(row.first_token_ms) || 0;
    } else if (row.event === "tool_call") {
      summary.tool_calls += 1;
      const name = String(row.tool_name || "").trim() || "unknown";
      toolCounts.set(name, (toolCounts.get(name) || 0) + 1);
      summary.dynamic_memory_tokens += Number(row.dynamic_memory_tokens) || 0;
    } else if (row.event === "loop_terminal") {
      summary.terminal_reason = String(row.terminal_reason || "").trim();
      if ((Number(row.rounds) || 0) > 0) summary.rounds = Number(row.rounds) || summary.rounds;
      if ((Number(row.tool_calls) || 0) >= 0) summary.tool_calls = Number(row.tool_calls) || summary.tool_calls;
      if ((Number(row.total_tokens) || 0) > 0) summary.total_tokens = Number(row.total_tokens) || 0;
      if ((Number(row.total_latency_ms) || 0) > 0) summary.total_latency_ms = Number(row.total_latency_ms) || 0;
      if ((Number(row.dynamic_memory_tokens) || 0) > 0) summary.dynamic_memory_tokens = Number(row.dynamic_memory_tokens) || summary.dynamic_memory_tokens;
    }
  }

  if (summary.total_tokens <= 0) {
    summary.total_tokens = summary.input_tokens + summary.output_tokens;
  }

  summary.tools = Array.from(toolCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));

  return summary;
}

module.exports = {
  LOOP_EVENT_SCHEMA_VERSION,
  appendShadowDiff,
  getLoopObservabilityPaths,
  getShadowObservabilityPaths,
  createLoopObserver,
  readRecentLoopSummary,
};

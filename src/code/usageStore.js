const fs = require("fs");
const path = require("path");

function getUsageFilePath(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot || process.cwd());
  return path.join(root, ".ufoo", "agent", "ucode", "usage.jsonl");
}

function toUsageCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function buildUsageRecord(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    ts: String(source.ts || "").trim() || new Date().toISOString(),
    sessionId: String(source.sessionId || "").trim(),
    model: String(source.model || "").trim(),
    provider: String(source.provider || "").trim(),
    turns: toUsageCount(source.turns),
    input: toUsageCount(source.input),
    output: toUsageCount(source.output),
    cacheRead: toUsageCount(source.cacheRead),
    cacheCreation: toUsageCount(source.cacheCreation),
  };
}

function appendUsageRecord(workspaceRoot = process.cwd(), record = {}) {
  const row = buildUsageRecord(record);
  const filePath = getUsageFilePath(workspaceRoot);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
    return {
      ok: true,
      error: "",
      filePath,
      record: row,
    };
  } catch (err) {
    // Usage accounting is observability only: never let a write failure
    // break the agent loop.
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to append usage",
      filePath,
      record: row,
    };
  }
}

function createUsageSummary() {
  return {
    records: 0,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    cacheInput: 0,
  };
}

function promptTokenTotal(row = {}) {
  const input = toUsageCount(row.input);
  const provider = String(row.provider || "").trim().toLowerCase();
  // OpenAI-compatible usage.prompt_tokens already includes cached tokens.
  // Anthropic reports uncached, cache-read, and cache-creation tokens as
  // disjoint counters, so reconstruct the total prompt-token denominator.
  if (provider === "anthropic") {
    return input + toUsageCount(row.cacheRead) + toUsageCount(row.cacheCreation);
  }
  return input;
}

function summarizeSessionUsage({ workspaceRoot = process.cwd(), sessionId = "" } = {}) {
  const summary = createUsageSummary();
  const targetSessionId = String(sessionId || "").trim();
  let raw = "";
  try {
    raw = fs.readFileSync(getUsageFilePath(workspaceRoot), "utf8");
  } catch {
    return summary;
  }
  for (const line of String(raw).split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    let row = null;
    try {
      row = JSON.parse(text);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (targetSessionId && String(row.sessionId || "").trim() !== targetSessionId) continue;
    summary.records += 1;
    summary.turns += toUsageCount(row.turns);
    summary.input += toUsageCount(row.input);
    summary.output += toUsageCount(row.output);
    summary.cacheRead += toUsageCount(row.cacheRead);
    summary.cacheCreation += toUsageCount(row.cacheCreation);
    summary.cacheInput += promptTokenTotal(row);
  }
  return summary;
}

function formatSessionUsageStatus(summary = {}) {
  const source = summary && typeof summary === "object" ? summary : {};
  const input = Number(source.input) || 0;
  const output = Number(source.output) || 0;
  const cacheRead = Number(source.cacheRead) || 0;
  const cacheCreation = Number(source.cacheCreation) || 0;
  const reportedCacheInput = Number(source.cacheInput);
  const denominator = Number.isFinite(reportedCacheInput) && reportedCacheInput > 0
    ? reportedCacheInput
    : input;
  const hitRate = denominator > 0 ? (cacheRead / denominator) * 100 : 0;
  return [
    `Session tokens: input=${input} output=${output} cache_read=${cacheRead} cache_creation=${cacheCreation}`,
    `Cache hit rate: ${hitRate.toFixed(1)}% (cache_read/prompt_input)`,
  ].join("\n");
}

module.exports = {
  getUsageFilePath,
  buildUsageRecord,
  appendUsageRecord,
  createUsageSummary,
  summarizeSessionUsage,
  formatSessionUsageStatus,
};

const MemoryManager = require("../../memory");
const { estimateTokens } = require("../../memory");
const { searchHistory } = require("../../memory/historySearch");
const { buildToolError, extractAuditFields, requireSubscriber } = require("./common");

const BANNED_TIME_PATTERNS = [
  /\bjust decided\b/i,
  /\bjust now\b/i,
  /\btoday\b/i,
  /\bcurrent\b/i,
  /现在/,
  /今天/,
  /本月/,
  /最近/,
  /正在/,
  /刚才/,
  /本\s*sprint/i,
  /本阶段/,
];

function getMemoryManager(ctx = {}) {
  return ctx.memoryManager || new MemoryManager(ctx.projectRoot);
}

function normalizeTags(value = []) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function extractMemoryEvidence(args = {}) {
  const evidence = {};
  if (args.history_session_id) evidence.history_session_id = String(args.history_session_id);
  if (args.history_offset) evidence.history_offset = String(args.history_offset);
  if (Array.isArray(args.recall_ids)) {
    evidence.recall_ids = args.recall_ids.map((id) => String(id || "").trim()).filter(Boolean);
  }
  return evidence;
}

function assertAgentWriteQuality(args = {}, fields = ["title", "body"]) {
  const title = String(args.title || "").trim();
  const body = String(args.body || "").trim();
  if (fields.includes("body")) {
    if (body.length < 20 || body.length > 2000) {
      throw buildToolError(
        "invalid_memory_body",
        "memory body must be between 20 and 2000 characters"
      );
    }
  }
  const combined = `${title}\n${body}`;
  if (BANNED_TIME_PATTERNS.some((pattern) => pattern.test(combined))) {
    throw buildToolError(
      "memory_not_durable",
      "memory text contains time-relative wording; record durable facts only"
    );
  }
}

function rememberHandler(ctx = {}, args = {}) {
  const subscriber = requireSubscriber(ctx);
  assertAgentWriteQuality(args);
  const manager = getMemoryManager(ctx);
  const entry = manager.add({
    title: args.title,
    body: args.body,
    tags: normalizeTags(args.tags),
    source: `agent:${subscriber}`,
  }, {
    source: "tool",
    actor: subscriber,
    ...extractAuditFields(ctx),
    ...extractMemoryEvidence(args),
  });
  return { ok: true, entry };
}

function recallHandler(ctx = {}, args = {}) {
  const manager = getMemoryManager(ctx);
  if (args.id) {
    const entries = [manager.get(args.id, { includeArchived: args.include_archived === true })];
    return { ok: true, count: 1, entries, dynamic_memory_tokens: estimateTokens(JSON.stringify(entries)) };
  }
  const tags = normalizeTags(args.tags);
  const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
    ? Math.floor(Number(args.limit))
    : 10;
  let entries = manager.list({ limit, includeArchived: args.include_archived === true });
  if (tags.length) {
    entries = entries.filter((entry) => tags.every((tag) => entry.tags.includes(String(tag).toLowerCase())));
  }
  return { ok: true, count: entries.length, entries, dynamic_memory_tokens: estimateTokens(JSON.stringify(entries)) };
}

function searchMemoryHandler(ctx = {}, args = {}) {
  const query = String(args.query || "").trim();
  if (!query) throw buildToolError("invalid_memory_query", "search_memory requires query");
  const manager = getMemoryManager(ctx);
  const entries = manager.search(query, {
    limit: args.limit,
    includeArchived: args.include_archived === true,
  });
  return { ok: true, count: entries.length, entries, dynamic_memory_tokens: estimateTokens(JSON.stringify(entries)) };
}

function searchHistoryHandler(ctx = {}, args = {}) {
  const query = String(args.query || "").trim();
  if (!query) throw buildToolError("invalid_history_query", "search_history requires query");
  const manager = getMemoryManager(ctx);
  const result = searchHistory(ctx.projectRoot, args, {
    homeDir: ctx.historyHomeDir,
    claudeProjectDir: ctx.claudeProjectDir,
    claudeHistoryFile: ctx.claudeHistoryFile,
    codexSessionsDir: ctx.codexSessionsDir,
    codexHistoryFile: ctx.codexHistoryFile,
  });
  manager.recordHistorySearch(query, result.snippets, {
    source: "tool",
    actor: ctx.subscriber || "",
    ...extractAuditFields(ctx),
  });
  return {
    ...result,
    dynamic_memory_tokens: estimateTokens(JSON.stringify(result.snippets || [])),
  };
}

function editMemoryHandler(ctx = {}, args = {}) {
  const subscriber = requireSubscriber(ctx);
  const hasBody = Object.prototype.hasOwnProperty.call(args, "body");
  if (hasBody) assertAgentWriteQuality(args, ["body"]);
  const manager = getMemoryManager(ctx);
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(args, "title")) patch.title = args.title;
  if (Object.prototype.hasOwnProperty.call(args, "body")) patch.body = args.body;
  if (Object.prototype.hasOwnProperty.call(args, "tags")) patch.tags = normalizeTags(args.tags);
  if (Object.prototype.hasOwnProperty.call(args, "expected_updated_at")) {
    patch.expected_updated_at = args.expected_updated_at;
  }
  const entry = manager.update(args.id, patch, {
    source: "tool",
    actor: subscriber,
    ...extractAuditFields(ctx),
    ...extractMemoryEvidence(args),
  });
  return { ok: true, entry };
}

function forgetMemoryHandler(ctx = {}, args = {}) {
  const subscriber = requireSubscriber(ctx);
  const manager = getMemoryManager(ctx);
  const entry = manager.archive(args.id, {
    source: "tool",
    actor: subscriber,
    ...extractAuditFields(ctx),
  });
  return { ok: true, entry };
}

module.exports = {
  rememberHandler,
  recallHandler,
  searchMemoryHandler,
  searchHistoryHandler,
  editMemoryHandler,
  forgetMemoryHandler,
};

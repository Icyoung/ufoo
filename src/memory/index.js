const fs = require("fs");
const path = require("path");
const matter = require("gray-matter");

const {
  ensureDir,
  appendJSONL,
  getTimestamp,
  writeFileAtomic,
} = require("../bus/utils");
const { redactSecrets } = require("../providerapi/redactor");
const { canonicalProjectRoot } = require("../projects/projectId");
const { getUfooPaths } = require("../ufoo/paths");

const SCHEMA_VERSION = "1.0";
const ID_PREFIX = "mem-";
const ID_RE = /^mem-(\d{4,})$/;
const ENTRY_RE = /^mem-\d{4,}\.md$/;
const HISTORY_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PREFIX_MAX_TOKENS = 1500;
const prefixCache = new Map();

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const array = new Int32Array(buffer);
  Atomics.wait(array, 0, 0, ms);
}

function normalizeId(value = "") {
  return String(value || "").trim();
}

function normalizeTitle(value = "") {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  if (!title) throw buildMemoryError("invalid_memory_title", "memory title is required");
  if (title.length > 150) {
    throw buildMemoryError("invalid_memory_title", "memory title must be 150 characters or less");
  }
  return title;
}

function normalizeBody(value = "") {
  const body = String(value || "").trim();
  if (!body) throw buildMemoryError("invalid_memory_body", "memory body is required");
  return body;
}

function normalizeTags(value = []) {
  const source = Array.isArray(value)
    ? value
    : String(value || "").split(",");
  const seen = new Set();
  const tags = [];
  for (const item of source) {
    const tag = String(item || "").trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function buildMemoryError(code, message, extra = {}) {
  const err = new Error(String(message || "memory operation failed"));
  err.code = String(code || "memory_error");
  Object.assign(err, extra);
  return err;
}

function frontmatterValue(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function splitEntryContent(markdown = "") {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  let title = "";
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start += 1;
  if (start < lines.length && /^#\s+/.test(lines[start])) {
    title = lines[start].replace(/^#\s+/, "").trim();
    start += 1;
    if (start < lines.length && !lines[start].trim()) start += 1;
  }
  return {
    title,
    body: lines.slice(start).join("\n").trim(),
  };
}

function composeEntry(entry) {
  const data = {
    id: entry.id,
    tags: normalizeTags(entry.tags),
    source: frontmatterValue(entry.source) || "user",
    created_at: frontmatterValue(entry.created_at),
    updated_at: frontmatterValue(entry.updated_at),
    status: frontmatterValue(entry.status) || "active",
    schema_version: frontmatterValue(entry.schema_version) || SCHEMA_VERSION,
  };
  return matter.stringify(`# ${entry.title}\n\n${entry.body.trim()}\n`, data);
}

function parseIndexLine(line = "") {
  const match = String(line || "").match(/^-\s+(mem-\d{4,})\s+\[([^\]]*)\]\s+(.+)$/);
  if (!match) return null;
  return {
    id: match[1],
    tags: normalizeTags(match[2]),
    title: match[3].trim(),
    status: "active",
  };
}

function isProbablyRedacted(value) {
  const redacted = redactSecrets(value);
  return JSON.stringify(redacted) !== JSON.stringify(value);
}

function normalizeEchoText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function echoOverlapRatio(body = "", snippet = "") {
  const normalizedBody = normalizeEchoText(body);
  const normalizedSnippet = normalizeEchoText(snippet);
  if (!normalizedBody || !normalizedSnippet) return 0;
  if (normalizedBody.length >= 80 && normalizedSnippet.includes(normalizedBody)) return 1;
  if (normalizedSnippet.length >= 80 && normalizedBody.includes(normalizedSnippet)) return 1;
  const bodyTokens = new Set(normalizedBody.split(/\s+/).filter((token) => token.length > 2));
  const snippetTokens = new Set(normalizedSnippet.split(/\s+/).filter((token) => token.length > 2));
  if (bodyTokens.size === 0 || snippetTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of bodyTokens) {
    if (snippetTokens.has(token)) overlap += 1;
  }
  return overlap / Math.min(bodyTokens.size, snippetTokens.size);
}

function estimateTokens(value = "") {
  const text = String(value || "");
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

class MemoryManager {
  constructor(projectRoot, options = {}) {
    this.projectRoot = canonicalProjectRoot(projectRoot);
    const paths = getUfooPaths(this.projectRoot);
    this.memoryDir = paths.memoryDir;
    this.memoryFile = paths.memoryFile; // Legacy append-only path kept for compatibility.
    this.indexFile = path.join(this.memoryDir, "INDEX.md");
    this.auditFile = path.join(this.memoryDir, "audit.jsonl");
    this.historySearchCacheFile = path.join(this.memoryDir, ".history-search-cache.jsonl");
    this.lockDir = path.join(this.memoryDir, ".lock");
    this.idCounterFile = path.join(this.memoryDir, ".id-counter");
    this.archiveDir = path.join(this.memoryDir, "archive");
    if (options.ensure !== false) {
      ensureDir(this.memoryDir);
      ensureDir(this.archiveDir);
    }
  }

  withLock(fn) {
    ensureDir(this.memoryDir);
    const started = Date.now();
    while (true) {
      try {
        fs.mkdirSync(this.lockDir);
        break;
      } catch (err) {
        if (err && err.code !== "EEXIST") throw err;
        if (Date.now() - started > 5000) {
          throw buildMemoryError("memory_lock_timeout", "timed out waiting for memory lock");
        }
        sleepSync(10);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    }
  }

  entryPath(id) {
    return path.join(this.memoryDir, `${normalizeId(id)}.md`);
  }

  archivePath(id) {
    return path.join(this.archiveDir, `${normalizeId(id)}.md`);
  }

  readCounter() {
    try {
      const raw = fs.readFileSync(this.idCounterFile, "utf8").trim();
      const parsed = parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  maxExistingNumber() {
    let max = 0;
    for (const dir of [this.memoryDir, this.archiveDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        if (!ENTRY_RE.test(file)) continue;
        const match = file.replace(/\.md$/, "").match(ID_RE);
        if (!match) continue;
        max = Math.max(max, parseInt(match[1], 10) || 0);
      }
    }
    return max;
  }

  allocateId() {
    const next = Math.max(this.readCounter(), this.maxExistingNumber()) + 1;
    writeFileAtomic(this.idCounterFile, `${next}\n`);
    return `${ID_PREFIX}${String(next).padStart(4, "0")}`;
  }

  readEntryFile(filePath, statusHint = "") {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = matter(raw);
    const id = normalizeId(parsed.data.id || path.basename(filePath, ".md"));
    const split = splitEntryContent(parsed.content);
    const stat = fs.statSync(filePath);
    const tags = normalizeTags(parsed.data.tags || []);
    return {
      id,
      title: split.title || id,
      body: split.body,
      tags,
      source: frontmatterValue(parsed.data.source) || "user",
      created_at: frontmatterValue(parsed.data.created_at) || stat.birthtime.toISOString(),
      updated_at: frontmatterValue(parsed.data.updated_at) || stat.mtime.toISOString(),
      status: frontmatterValue(parsed.data.status) || statusHint || "active",
      schema_version: frontmatterValue(parsed.data.schema_version) || SCHEMA_VERSION,
      file_path: filePath,
    };
  }

  get(id, options = {}) {
    const memoryId = normalizeId(id);
    if (!memoryId) throw buildMemoryError("invalid_memory_id", "memory id is required");
    const activePath = this.entryPath(memoryId);
    if (fs.existsSync(activePath)) return this.readEntryFile(activePath, "active");
    if (options.includeArchived) {
      const archivedPath = this.archivePath(memoryId);
      if (fs.existsSync(archivedPath)) return this.readEntryFile(archivedPath, "archived");
    }
    throw buildMemoryError("memory_not_found", `memory ${memoryId} not found`, { id: memoryId });
  }

  list(options = {}) {
    const includeArchived = options.all === true || options.includeArchived === true;
    const tag = String(options.tag || "").trim().toLowerCase();
    const entries = [];
    const readDir = (dir, statusHint) => {
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        if (!ENTRY_RE.test(file)) continue;
        const entry = this.readEntryFile(path.join(dir, file), statusHint);
        if (tag && !entry.tags.includes(tag)) continue;
        entries.push(entry);
      }
    };
    readDir(this.memoryDir, "active");
    if (includeArchived) readDir(this.archiveDir, "archived");
    entries.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : 0;
    return limit ? entries.slice(0, limit) : entries;
  }

  indexEntries() {
    return this.list({ includeArchived: false });
  }

  buildIndexContent(entries = this.indexEntries()) {
    if (!entries.length) return "# Project Memory\n\n";
    const lines = ["# Project Memory", ""];
    for (const entry of entries) {
      const tagText = entry.tags.length ? `[${entry.tags.join(",")}]` : "[]";
      lines.push(`- ${entry.id} ${tagText} ${entry.title}`);
    }
    return `${lines.join("\n")}\n`;
  }

  rebuildIndex() {
    const entries = this.indexEntries();
    writeFileAtomic(this.indexFile, this.buildIndexContent(entries));
    return entries;
  }

  readIndexSummaries(options = {}) {
    if (!fs.existsSync(this.indexFile)) return [];
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : 0;
    const entries = fs.readFileSync(this.indexFile, "utf8")
      .split(/\r?\n/)
      .map(parseIndexLine)
      .filter(Boolean);
    return limit ? entries.slice(0, limit) : entries;
  }

  audit(action, entry, detail = {}) {
    appendJSONL(this.auditFile, {
      schema_version: SCHEMA_VERSION,
      ts: getTimestamp(),
      action,
      id: entry && entry.id ? entry.id : detail.id || "",
      title: entry && entry.title ? entry.title : detail.title || "",
      source: detail.source || "",
      actor: detail.actor || "",
      turn_id: detail.turn_id || "",
      tool_call_id: detail.tool_call_id || "",
      caller_tier: detail.caller_tier || "",
      history_session_id: detail.history_session_id || "",
      history_offset: detail.history_offset || "",
      recall_ids: Array.isArray(detail.recall_ids) ? detail.recall_ids : [],
      query: detail.query || "",
      result_count: Number.isFinite(Number(detail.result_count)) ? Number(detail.result_count) : undefined,
      snippet_summaries: Array.isArray(detail.snippet_summaries) ? detail.snippet_summaries : undefined,
      before: detail.before || null,
      after: detail.after || null,
    });
  }

  recordHistorySearch(query = "", snippets = [], detail = {}) {
    const rows = Array.isArray(snippets) ? snippets : [];
    for (const snippet of rows) {
      appendJSONL(this.historySearchCacheFile, {
        ts: getTimestamp(),
        query: String(query || ""),
        source: snippet.source || "",
        session_id: snippet.session_id || "",
        role: snippet.role || "",
        text: String(snippet.text || "").slice(0, 2000),
      });
    }
    this.audit("search_history", null, {
      ...(detail.audit || detail),
      query: String(query || ""),
      result_count: rows.length,
      snippet_summaries: rows.map((snippet) => ({
        source: snippet.source || "",
        session_id: snippet.session_id || "",
        ts: snippet.ts || "",
        role: snippet.role || "",
        chars: String(snippet.text || "").length,
        tool_name: snippet.tool_name || "",
      })),
    });
  }

  recentHistorySnippets(options = {}) {
    if (!fs.existsSync(this.historySearchCacheFile)) return [];
    const cutoff = Date.now() - (
      Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
        ? Number(options.ttlMs)
        : HISTORY_CACHE_TTL_MS
    );
    return fs.readFileSync(this.historySearchCacheFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => {
        if (!row || !row.text) return false;
        const ts = Date.parse(row.ts || "");
        return Number.isFinite(ts) ? ts >= cutoff : true;
      });
  }

  assertNoHistoryEcho(body = "") {
    const text = String(body || "");
    if (text.length < 80) return;
    for (const snippet of this.recentHistorySnippets()) {
      if (echoOverlapRatio(text, snippet.text || "") >= 0.8) {
        throw buildMemoryError(
          "memory_history_echo",
          "memory body overlaps recent search_history output; restate the durable fact in your own words",
          { history_session_id: snippet.session_id || "" }
        );
      }
    }
  }

  readAudit(id = "") {
    if (!fs.existsSync(this.auditFile)) return [];
    const target = normalizeId(id);
    const rows = fs.readFileSync(this.auditFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return target ? rows.filter((row) => row.id === target) : rows;
  }

  assertNoSecret(entry) {
    if (isProbablyRedacted({
      title: entry.title || "",
      body: entry.body || "",
      tags: entry.tags || [],
    })) {
      throw buildMemoryError("memory_secret_detected", "memory contains a value that looks like a secret");
    }
  }

  add(input = {}, options = {}) {
    return this.withLock(() => {
      const now = getTimestamp();
      const entry = {
        id: this.allocateId(),
        title: normalizeTitle(input.title || input.description || input.content || ""),
        body: normalizeBody(input.body || input.content || input.description || input.title || ""),
        tags: normalizeTags(input.tags || []),
        source: input.source || options.source || "user",
        created_at: now,
        updated_at: now,
        status: "active",
        schema_version: SCHEMA_VERSION,
      };
      this.assertNoSecret(entry);
      this.assertNoHistoryEcho(entry.body);
      writeFileAtomic(this.entryPath(entry.id), composeEntry(entry));
      this.rebuildIndex();
      this.audit("add", entry, options.audit || options);
      return this.get(entry.id);
    });
  }

  addEntry(entry) {
    return this.add({
      title: entry.title || entry.content || entry.type || "Memory entry",
      body: entry.body || entry.content || JSON.stringify(entry),
      tags: entry.tags || [],
      source: entry.source || "agent:legacy",
    });
  }

  update(id, patch = {}, options = {}) {
    return this.withLock(() => {
      const prior = this.get(id);
      const expected = String(patch.expected_updated_at || options.expected_updated_at || "").trim();
      if (expected && expected !== prior.updated_at) {
        throw buildMemoryError("memory_conflict", `memory ${prior.id} was updated by another writer`, {
          id: prior.id,
          expected_updated_at: expected,
          actual_updated_at: prior.updated_at,
        });
      }
      if (!Object.prototype.hasOwnProperty.call(patch, "title")
        && !Object.prototype.hasOwnProperty.call(patch, "body")
        && !Object.prototype.hasOwnProperty.call(patch, "tags")) {
        throw buildMemoryError("invalid_memory_update", "memory update requires title, body, or tags");
      }
      const next = {
        ...prior,
        title: Object.prototype.hasOwnProperty.call(patch, "title")
          ? normalizeTitle(patch.title)
          : prior.title,
        body: Object.prototype.hasOwnProperty.call(patch, "body")
          ? normalizeBody(patch.body)
          : prior.body,
        tags: Object.prototype.hasOwnProperty.call(patch, "tags")
          ? normalizeTags(patch.tags)
          : prior.tags,
        updated_at: getTimestamp(),
        status: "active",
      };
      this.assertNoSecret(next);
      if (Object.prototype.hasOwnProperty.call(patch, "body")) {
        this.assertNoHistoryEcho(next.body);
      }
      writeFileAtomic(this.entryPath(next.id), composeEntry(next));
      this.rebuildIndex();
      this.audit("update", next, {
        ...(options.audit || options),
        before: { title: prior.title, tags: prior.tags, updated_at: prior.updated_at },
        after: { title: next.title, tags: next.tags, updated_at: next.updated_at },
      });
      return this.get(next.id);
    });
  }

  archive(id, options = {}) {
    return this.withLock(() => {
      const prior = this.get(id);
      const archived = {
        ...prior,
        status: "archived",
        updated_at: getTimestamp(),
      };
      writeFileAtomic(this.archivePath(archived.id), composeEntry(archived));
      fs.rmSync(this.entryPath(archived.id), { force: true });
      this.rebuildIndex();
      this.audit("archive", archived, {
        ...(options.audit || options),
        before: { title: prior.title, tags: prior.tags, updated_at: prior.updated_at },
        after: { title: archived.title, tags: archived.tags, updated_at: archived.updated_at },
      });
      return this.get(archived.id, { includeArchived: true });
    });
  }

  search(query = "", options = {}) {
    const tokens = String(query || "")
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fff]+/i)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) return [];
    const entries = this.list({ includeArchived: options.includeArchived === true });
    const scored = entries.map((entry) => {
      const haystack = [
        entry.id,
        entry.title,
        entry.body,
        entry.tags.join(" "),
      ].join(" ").toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (haystack.includes(token)) score += 1;
        if (entry.title.toLowerCase().includes(token)) score += 2;
        if (entry.tags.some((tag) => tag.includes(token))) score += 2;
      }
      return { entry, score };
    }).filter((item) => item.score > 0);
    scored.sort((a, b) => b.score - a.score || String(b.entry.updated_at).localeCompare(String(a.entry.updated_at)));
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : 5;
    return scored.slice(0, limit).map((item) => item.entry);
  }

  buildPrefix(options = {}) {
    return this.buildPrefixResult(options).prefix;
  }

  buildPrefixResult(options = {}) {
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : 0;
    const maxTokens = Number.isFinite(Number(options.maxTokens)) && Number(options.maxTokens) > 0
      ? Math.floor(Number(options.maxTokens))
      : DEFAULT_PREFIX_MAX_TOKENS;
    let entries = this.readIndexSummaries({ limit });
    if (entries.length === 0 && this.list({ limit: 1 }).length > 0) {
      entries = this.list({ limit }).map((entry) => ({
        id: entry.id,
        title: entry.title,
        tags: entry.tags,
        status: entry.status,
      }));
    }
    if (entries.length === 0) {
      return {
        prefix: "",
        entry_count: 0,
        emitted_count: 0,
        truncated: false,
        estimated_tokens: 0,
      };
    }
    const lines = ["## Project Memory", ""];
    let emitted = 0;
    let truncated = false;
    for (const entry of entries) {
      const tagText = entry.tags.length ? `[${entry.tags.join(",")}]` : "[]";
      const nextLine = `- ${entry.id} ${tagText} ${entry.title}`;
      const candidate = `${[...lines, nextLine].join("\n")}\n`;
      if (estimateTokens(candidate) > maxTokens) {
        truncated = true;
        break;
      }
      lines.push(nextLine);
      emitted += 1;
    }
    const prefix = emitted > 0 ? `${lines.join("\n")}\n` : "";
    return {
      prefix,
      entry_count: entries.length,
      emitted_count: emitted,
      truncated: truncated || emitted < entries.length,
      estimated_tokens: estimateTokens(prefix),
    };
  }

  readObservabilitySummary(options = {}) {
    const sinceMs = Date.now() - (
      Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
        ? Number(options.windowMs)
        : HISTORY_CACHE_TTL_MS
    );
    const rows = this.readAudit().filter((row) => {
      const ts = Date.parse(row.ts || "");
      return Number.isFinite(ts) ? ts >= sinceMs : true;
    });
    const writeActions = new Set(["add", "update", "archive"]);
    const byActor = new Map();
    for (const row of rows) {
      if (!writeActions.has(row.action)) continue;
      const actor = String(row.actor || row.source || "unknown");
      const current = byActor.get(actor) || { actor, writes: 0, remember: 0, edit_memory: 0, forget: 0, warning: false };
      current.writes += 1;
      if (row.action === "add") current.remember += 1;
      if (row.action === "update") current.edit_memory += 1;
      if (row.action === "archive") current.forget += 1;
      byActor.set(actor, current);
    }
    const rowsByActor = Array.from(byActor.values()).map((row) => ({
      ...row,
      warning: row.writes > 5,
    }));
    return {
      window_ms: Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
        ? Number(options.windowMs)
        : HISTORY_CACHE_TTL_MS,
      actor_count: rowsByActor.length,
      actors: rowsByActor.sort((a, b) => b.writes - a.writes || a.actor.localeCompare(b.actor)),
    };
  }
}

function buildCachedMemoryPrefix(projectRoot, options = {}) {
  const root = canonicalProjectRoot(projectRoot);
  const key = `${root}:${Number(options.limit) || 0}:${Number(options.maxTokens) || DEFAULT_PREFIX_MAX_TOKENS}`;
  if (prefixCache.has(key)) {
    return {
      ...prefixCache.get(key),
      cache_hit: true,
      cache_semistatic_hit: prefixCache.get(key).estimated_tokens || 0,
      cache_semistatic_miss: 0,
    };
  }
  const manager = new MemoryManager(root, { ensure: false });
  const result = manager.buildPrefixResult(options);
  prefixCache.set(key, result);
  return {
    ...result,
    cache_hit: false,
    cache_semistatic_hit: 0,
    cache_semistatic_miss: result.estimated_tokens || 0,
  };
}

module.exports = MemoryManager;
module.exports.MemoryManager = MemoryManager;
module.exports.buildMemoryError = buildMemoryError;
module.exports.buildCachedMemoryPrefix = buildCachedMemoryPrefix;
module.exports.estimateTokens = estimateTokens;

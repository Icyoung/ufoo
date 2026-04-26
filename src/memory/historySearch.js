const fs = require("fs");
const os = require("os");
const path = require("path");

const { redactSecrets, redactString } = require("../providerapi/redactor");

const MAX_RESULTS = 3;
const MAX_TOTAL_TEXT_CHARS = 2000;
const MAX_FILES_PER_SOURCE = 200;

function normalizeAgent(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "all" || text === "*") return "";
  if (text === "claude") return "claude-code";
  if (text === "uclaude") return "claude-code";
  if (text === "ucodex") return "codex";
  return text;
}

function tokenize(value = "") {
  return String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9_\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeProjectSlug(projectRoot) {
  return path.resolve(projectRoot || process.cwd()).replace(/\//g, "-");
}

function getHomeDir(options = {}) {
  return options.homeDir || options.home || os.homedir();
}

function safeReadJsonl(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
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
  } catch {
    return [];
  }
}

function walkFiles(dir, predicate, limit = MAX_FILES_PER_SOURCE) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
      } else if (entry.isFile() && predicate(filePath, entry.name)) {
        out.push(filePath);
        if (out.length >= limit) break;
      }
    }
  }
  return out.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      if (item.type === "tool_use") return JSON.stringify(item.input || {});
      return "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }
  return "";
}

function extractClaudeRecord(record = {}, fallback = {}) {
  const sessionId = fallback.sessionId || record.sessionId || record.session_id || "";
  const timestamp = record.timestamp || record.ts || record.created_at || fallback.ts || "";
  const type = String(record.type || record.role || "").toLowerCase();
  const role = type === "assistant" ? "assistant" : (type === "user" ? "user" : String(record.role || type || ""));
  const message = record.message && typeof record.message === "object" ? record.message : record;
  const text = extractContent(message.content || record.content || record.text || record.display);
  let toolName = "";
  const content = message.content || record.content;
  if (Array.isArray(content)) {
    const toolUse = content.find((item) => item && item.type === "tool_use");
    if (toolUse) toolName = String(toolUse.name || "");
  }
  if (!text) return null;
  return {
    source: "claude-code",
    session_id: String(sessionId || ""),
    ts: timestamp ? String(timestamp) : "",
    role: role || "unknown",
    text,
    ...(toolName ? { tool_name: toolName } : {}),
    file: fallback.file || "",
  };
}

function extractCodexRecord(record = {}, fallback = {}) {
  if (record.type === "session_meta") return { sessionMeta: record.payload || {} };
  const sessionId = fallback.sessionId || record.session_id || record.sessionId || "";
  const timestamp = record.timestamp || record.ts || record.created_at || fallback.ts || "";
  if (record.type === "message" || record.role) {
    const text = extractContent(record.content || record.message || record.text);
    if (!text) return null;
    return {
      source: "codex",
      session_id: String(sessionId || ""),
      ts: timestamp ? String(timestamp) : "",
      role: String(record.role || "unknown"),
      text,
      file: fallback.file || "",
    };
  }
  const item = record.item || record.payload || {};
  if (item && item.type === "tool_call") {
    return {
      source: "codex",
      session_id: String(sessionId || ""),
      ts: timestamp ? String(timestamp) : "",
      role: "tool",
      text: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
      tool_name: String(item.name || ""),
      file: fallback.file || "",
    };
  }
  const text = extractContent(record.display || record.prompt || record.input || record.message || record.text || record.content);
  if (!text) return null;
  return {
    source: "codex",
    session_id: String(sessionId || ""),
    ts: timestamp ? String(timestamp) : "",
    role: String(record.role || "unknown"),
    text,
    file: fallback.file || "",
  };
}

function scoreSnippet(snippet, tokens) {
  const haystack = [
    snippet.session_id,
    snippet.role,
    snippet.tool_name || "",
    snippet.text,
  ].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += 1;
    if (String(snippet.text || "").toLowerCase().includes(token)) score += 2;
  }
  return score;
}

function discoverHistoryFiles(projectRoot, options = {}) {
  const home = getHomeDir(options);
  const agent = normalizeAgent(options.agent);
  const files = [];
  if (!agent || agent === "claude-code") {
    const claudeProjectDir = options.claudeProjectDir
      || path.join(home, ".claude", "projects", normalizeProjectSlug(projectRoot));
    if (fs.existsSync(claudeProjectDir)) {
      files.push(...walkFiles(claudeProjectDir, (filePath, name) => name.endsWith(".jsonl"))
        .map((file) => ({ agent: "claude-code", file })));
    }
    const claudeHistoryFile = options.claudeHistoryFile || path.join(home, ".claude", "history.jsonl");
    if (fs.existsSync(claudeHistoryFile)) files.push({ agent: "claude-code", file: claudeHistoryFile });
  }
  if (!agent || agent === "codex") {
    const codexSessionsDir = options.codexSessionsDir || path.join(home, ".codex", "sessions");
    if (fs.existsSync(codexSessionsDir)) {
      files.push(...walkFiles(codexSessionsDir, (filePath, name) => name.endsWith(".jsonl"))
        .map((file) => ({ agent: "codex", file })));
    }
    const codexHistoryFile = options.codexHistoryFile || path.join(home, ".codex", "history.jsonl");
    if (fs.existsSync(codexHistoryFile)) files.push({ agent: "codex", file: codexHistoryFile });
  }
  return files;
}

function readSnippetsFromFile({ agent, file }, options = {}) {
  const records = safeReadJsonl(file);
  let sessionId = String(options.sessionId || path.basename(file, ".jsonl")).trim();
  const snippets = [];
  const statTs = (() => {
    try { return fs.statSync(file).mtime.toISOString(); } catch { return ""; }
  })();

  for (const record of records) {
    if (agent === "codex") {
      const extracted = extractCodexRecord(record, { file, sessionId, ts: statTs });
      if (extracted && extracted.sessionMeta) {
        sessionId = String(extracted.sessionMeta.id || sessionId || "");
        continue;
      }
      if (extracted) {
        extracted.session_id = extracted.session_id || sessionId;
        snippets.push(extracted);
      }
    } else {
      const extracted = extractClaudeRecord(record, { file, sessionId, ts: statTs });
      if (extracted) snippets.push(extracted);
    }
  }
  return snippets;
}

function applyRedaction(snippet) {
  const safe = redactSecrets({
    source: snippet.source,
    session_id: snippet.session_id,
    ts: snippet.ts,
    role: snippet.role,
    text: redactString(snippet.text),
    ...(snippet.tool_name ? { tool_name: snippet.tool_name } : {}),
  });
  return safe;
}

function searchHistory(projectRoot, args = {}, options = {}) {
  const query = String(args.query || "").trim();
  if (!query) {
    const err = new Error("search_history requires query");
    err.code = "invalid_history_query";
    throw err;
  }
  const tokens = tokenize(query);
  const limit = Math.min(
    MAX_RESULTS,
    Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
      ? Math.floor(Number(args.limit))
      : MAX_RESULTS
  );
  const requestedSession = String(args.session_id || args.sessionId || "").trim();
  const files = discoverHistoryFiles(projectRoot, {
    ...options,
    agent: args.agent,
  });

  const scored = [];
  for (const fileInfo of files) {
    const snippets = readSnippetsFromFile(fileInfo, { sessionId: requestedSession });
    for (const snippet of snippets) {
      if (requestedSession && snippet.session_id !== requestedSession) continue;
      const score = scoreSnippet(snippet, tokens);
      if (score <= 0) continue;
      scored.push({ snippet, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || String(b.snippet.ts || "").localeCompare(String(a.snippet.ts || "")));
  const results = [];
  let totalText = 0;
  for (const item of scored) {
    if (results.length >= limit) break;
    const safe = applyRedaction(item.snippet);
    const remaining = Math.max(0, MAX_TOTAL_TEXT_CHARS - totalText);
    if (remaining <= 0) break;
    if (safe.text.length > remaining) safe.text = `${safe.text.slice(0, remaining)}...[truncated]`;
    totalText += safe.text.length;
    results.push(safe);
  }

  return {
    ok: true,
    from_history: true,
    query,
    count: results.length,
    snippets: results,
  };
}

module.exports = {
  MAX_RESULTS,
  MAX_TOTAL_TEXT_CHARS,
  normalizeAgent,
  searchHistory,
  discoverHistoryFiles,
  readSnippetsFromFile,
};

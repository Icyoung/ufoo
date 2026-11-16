"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { withFileLock } = require("./fileLock");

const SAFE_NAMESPACE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SAFE_SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

const TURN_KINDS = new Set(["user", "system_wake", "tool_continuation", "resumed_interaction"]);
const TURN_OUTCOMES = new Set(["completed", "failed", "cancelled", "interrupted", "paused", "unknown"]);

function ensureValidNamespace(namespace) {
  const value = String(namespace || "runtime").trim();
  if (!SAFE_NAMESPACE.test(value)) throw new Error(`Invalid context namespace: ${namespace}`);
  return value;
}

function ensureValidSessionId(sessionId) {
  const value = String(sessionId || "default").trim();
  if (!SAFE_SESSION_ID.test(value)) throw new Error(`Invalid context sessionId: ${sessionId}`);
  return value;
}

function dedupeStrings(values, limit = 64) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of values) {
    const item = typeof raw === "string" ? raw.trim() : "";
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function clampString(value, maxChars = 1200) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 3))}...` : text;
}

function normalizeTopic(value) {
  const raw = String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_/-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return raw ? raw.slice(0, 64) : "general";
}

function normalizeTurnRecord(input = {}, fallbackIndex = 0) {
  const turnId = String(input.turnId || "").trim();
  if (!turnId) throw new Error("turnId is required");
  const turnIndex = Number.isInteger(input.turnIndex) && input.turnIndex >= 0 ? input.turnIndex : fallbackIndex;
  const historyOffset = Number.isInteger(input.historyOffset) && input.historyOffset >= 0 ? input.historyOffset : 0;
  const historyEnd = Number.isInteger(input.historyEnd) && input.historyEnd >= historyOffset ? input.historyEnd : historyOffset;
  const turnKind = TURN_KINDS.has(input.turnKind) ? input.turnKind : "user";
  const outcome = TURN_OUTCOMES.has(input.outcome) ? input.outcome : "completed";
  return {
    turnId,
    turnIndex,
    historyOffset,
    historyEnd,
    turnKind,
    outcome,
    startedAt: input.startedAt || input.ts || new Date().toISOString(),
    endedAt: input.endedAt || input.ts || new Date().toISOString(),
    topic: normalizeTopic(input.topic),
    rawUserText: clampString(input.rawUserText, 1200),
    userSummary: clampString(input.userSummary, 360),
    assistantSummary: clampString(input.assistantSummary, 500),
    keyActions: dedupeStrings(input.keyActions, 24),
    touchedFiles: dedupeStrings(input.touchedFiles, 48),
    modifiedFiles: dedupeStrings(input.modifiedFiles, 48),
    artifactIds: dedupeStrings(input.artifactIds, 32),
    decisions: dedupeStrings(input.decisions, 16),
    keywords: dedupeStrings(input.keywords, 48),
    enrichmentVersion: Number.isInteger(input.enrichmentVersion) && input.enrichmentVersion > 0 ? input.enrichmentVersion : 1,
    enrichedAt: input.enrichedAt || null,
    contentHash: typeof input.contentHash === "string" ? input.contentHash : "",
    revision: Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1,
  };
}

function mergeTurnRecords(existing, incoming, options = {}) {
  const phase = options.phase || (incoming.enrichmentVersion >= 2 ? "B" : "A");
  if (!existing) return normalizeTurnRecord(incoming, options.fallbackIndex || 0);

  if (phase === "B") {
    if (options.expectedHash && existing.contentHash && options.expectedHash !== existing.contentHash) {
      return existing;
    }
    const nextTopic = incoming.topic && normalizeTopic(incoming.topic) !== "general"
      ? normalizeTopic(incoming.topic)
      : existing.topic;
    return {
      ...existing,
      topic: nextTopic,
      userSummary: clampString(incoming.userSummary, 360) || existing.userSummary,
      assistantSummary: clampString(incoming.assistantSummary, 500) || existing.assistantSummary,
      keyActions: dedupeStrings([...existing.keyActions, ...(incoming.keyActions || [])], 24),
      touchedFiles: dedupeStrings([...existing.touchedFiles, ...(incoming.touchedFiles || [])], 48),
      modifiedFiles: dedupeStrings([...existing.modifiedFiles, ...(incoming.modifiedFiles || [])], 48),
      artifactIds: dedupeStrings([...existing.artifactIds, ...(incoming.artifactIds || [])], 32),
      decisions: dedupeStrings([...existing.decisions, ...(incoming.decisions || [])], 16),
      keywords: dedupeStrings([...existing.keywords, ...(incoming.keywords || [])], 48),
      enrichmentVersion: Math.max(existing.enrichmentVersion || 1, Number(incoming.enrichmentVersion) || 2),
      enrichedAt: incoming.enrichedAt || new Date().toISOString(),
      revision: (existing.revision || 1) + 1,
    };
  }

  // Phase A update (e.g., resuming a paused turn or re-indexing a completed turn).
  const normalized = normalizeTurnRecord(incoming, existing.turnIndex);
  const hashChanged = existing.contentHash && normalized.contentHash && existing.contentHash !== normalized.contentHash;
  const keepEnrichedTopic = existing.enrichmentVersion >= 2 && existing.topic && existing.topic !== "general" && normalized.topic === "general";
  return {
    ...normalized,
    turnIndex: existing.turnIndex,
    startedAt: existing.startedAt || normalized.startedAt,
    topic: keepEnrichedTopic ? existing.topic : normalized.topic,
    userSummary: existing.enrichmentVersion >= 2 && !hashChanged && existing.userSummary
      ? existing.userSummary
      : (normalized.userSummary || existing.userSummary),
    assistantSummary: normalized.assistantSummary || existing.assistantSummary,
    keyActions: dedupeStrings([...existing.keyActions, ...normalized.keyActions], 24),
    touchedFiles: dedupeStrings([...existing.touchedFiles, ...normalized.touchedFiles], 48),
    modifiedFiles: dedupeStrings([...existing.modifiedFiles, ...normalized.modifiedFiles], 48),
    artifactIds: dedupeStrings([...existing.artifactIds, ...normalized.artifactIds], 32),
    decisions: dedupeStrings([...existing.decisions, ...normalized.decisions], 16),
    keywords: dedupeStrings([...existing.keywords, ...normalized.keywords], 48),
    enrichmentVersion: hashChanged ? 1 : Math.max(existing.enrichmentVersion || 1, normalized.enrichmentVersion || 1),
    enrichedAt: hashChanged ? null : (normalized.enrichedAt || existing.enrichedAt),
    revision: (existing.revision || 1) + 1,
  };
}

function tokenizeForSearch(text) {
  const input = String(text || "");
  if (!input.trim()) return [];
  const tokens = [];

  // Full path-like segments and filenames.
  const pathMatches = input.match(/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g) || [];
  for (const fullPath of pathMatches) {
    const lower = fullPath.toLowerCase();
    tokens.push({ term: lower, weight: 1.5 });
    const base = path.posix.basename(lower);
    if (base) tokens.push({ term: base, weight: 1.3 });
    const stem = base.replace(/\.[a-z0-9]+$/, "");
    if (stem && stem !== base) tokens.push({ term: stem, weight: 1.1 });
  }

  // Identifiers and ASCII words + camelCase/snake_case sub-tokens.
  const asciiMatches = input.match(/[a-zA-Z0-9][a-zA-Z0-9_.-]*/g) || [];
  for (const rawWord of asciiMatches) {
    const lower = rawWord.toLowerCase();
    if (lower.length >= 2) tokens.push({ term: lower, weight: 1.0 });
    const subParts = rawWord
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .map((s) => s.toLowerCase())
      .filter((s) => s.length >= 2);
    for (const part of subParts) {
      if (part !== lower) tokens.push({ term: part, weight: 0.7 });
    }
  }

  // CJK contiguous runs -> overlapping bigrams + fallback unigrams.
  const cjkRuns = input.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push({ term: run, weight: 0.9 });
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      tokens.push({ term: run.slice(i, i + 2), weight: 1.1 });
    }
    for (let i = 0; i < run.length; i += 1) {
      tokens.push({ term: run[i], weight: 0.3 });
    }
  }

  return tokens;
}

function buildTurnTermMap(turn) {
  const fieldInputs = [
    { text: turn.topic, weight: 2.5 },
    { text: [...(turn.modifiedFiles || []), ...(turn.touchedFiles || [])].join(" "), weight: 3.0 },
    { text: [...(turn.artifactIds || []), ...(turn.keywords || [])].join(" "), weight: 2.2 },
    { text: `${turn.userSummary || ""} ${turn.assistantSummary || ""}`, weight: 1.6 },
    { text: turn.rawUserText || "", weight: 1.3 },
    { text: [...(turn.keyActions || []), ...(turn.decisions || [])].join(" "), weight: 1.2 },
  ];
  const termFreq = new Map();
  for (const { text, weight } of fieldInputs) {
    for (const { term, weight: tokenWeight } of tokenizeForSearch(text)) {
      const prev = termFreq.get(term) || 0;
      termFreq.set(term, prev + weight * tokenWeight);
    }
  }
  return termFreq;
}

function appendJsonLineLocked(filePath, lineText) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeFileSync(fd, lineText, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAtomicLocked(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "w", 0o600);
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } finally {
    if (fd !== null && fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (fs.existsSync(tempPath)) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
    }
  }
}

function readTurnsFromDisk(turnsFile, { repairTornTail = false } = {}) {
  if (!fs.existsSync(turnsFile)) return { records: [], order: [], validBytes: 0 };
  const raw = fs.readFileSync(turnsFile);
  if (!raw.length) return { records: [], order: [], validBytes: 0 };
  const text = raw.toString("utf8");
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");
  const limit = hasTrailingNewline ? lines.length - 1 : lines.length;
  const byId = new Map();
  const order = [];
  let byteCursor = 0;
  let validBytes = 0;

  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(`${line}\n`, "utf8");
    const isLastFragment = i === limit - 1 && !hasTrailingNewline;
    if (!line.trim()) {
      byteCursor += isLastFragment ? Buffer.byteLength(line, "utf8") : lineBytes;
      if (!isLastFragment) validBytes = byteCursor;
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && parsed.turnId) {
        if (!byId.has(parsed.turnId)) order.push(parsed.turnId);
        byId.set(parsed.turnId, parsed);
      }
      byteCursor += isLastFragment ? Buffer.byteLength(line, "utf8") : lineBytes;
      if (!isLastFragment) validBytes = byteCursor;
    } catch {
      // Truncated tail after a crash. Stop before the corrupt fragment.
      if (repairTornTail && validBytes < raw.length) {
        try { fs.truncateSync(turnsFile, validBytes); } catch {}
      }
      break;
    }
  }

  const records = order.map((id) => byId.get(id)).filter(Boolean);
  records.sort((a, b) => (a.turnIndex || 0) - (b.turnIndex || 0));
  return { records, order, validBytes };
}

function createTurnIndexStore({
  workspaceRoot = process.cwd(),
  namespace = "runtime",
  sessionId = "default",
  redact = null,
} = {}) {
  const ns = ensureValidNamespace(namespace);
  const sid = ensureValidSessionId(sessionId);
  const dir = path.join(path.resolve(workspaceRoot || process.cwd()), ".ufoo", "agent", ns, "context");
  const turnsFile = path.join(dir, `${sid}.turns.jsonl`);
  const windowFile = path.join(dir, `${sid}.window.json`);
  const sanitize = typeof redact === "function" ? redact : (value) => value;

  function listTurnsLocked(filter = {}) {
    const { records } = readTurnsFromDisk(turnsFile, { repairTornTail: false });
    let result = records;
    if (filter.topic) {
      const targetTopic = normalizeTopic(filter.topic);
      result = result.filter((record) => normalizeTopic(record.topic) === targetTopic);
    }
    if (Array.isArray(filter.outcomes) && filter.outcomes.length) {
      const allowed = new Set(filter.outcomes);
      result = result.filter((record) => allowed.has(record.outcome));
    }
    if (Array.isArray(filter.excludeTurnIds) && filter.excludeTurnIds.length) {
      const excluded = new Set(filter.excludeTurnIds);
      result = result.filter((record) => !excluded.has(record.turnId));
    }
    return result;
  }

  function listTurns(filter = {}) {
    if (!fs.existsSync(turnsFile)) return [];
    return withFileLock(turnsFile, () => listTurnsLocked(filter));
  }

  function getTurn(turnId) {
    const id = String(turnId || "").trim();
    if (!id || !fs.existsSync(turnsFile)) return null;
    return withFileLock(turnsFile, () => {
      const { records } = readTurnsFromDisk(turnsFile, { repairTornTail: false });
      return records.find((record) => record.turnId === id) || null;
    });
  }

  function upsertTurn(record, options = {}) {
    return withFileLock(turnsFile, () => {
      const { records } = readTurnsFromDisk(turnsFile, { repairTornTail: true });
      const existingIndex = records.findIndex((item) => item.turnId === record.turnId);
      const existing = existingIndex >= 0 ? records[existingIndex] : null;
      const nextFallbackIndex = records.reduce((max, item) => Math.max(max, (item.turnIndex || 0) + 1), 0);
      const merged = mergeTurnRecords(existing, record, {
        ...options,
        fallbackIndex: nextFallbackIndex,
      });
      const safeRecord = sanitize(merged);
      if (existing) {
        if (options.phase === "B" && safeRecord === existing) return existing;
        records[existingIndex] = safeRecord;
        const body = records.map((item) => JSON.stringify(item)).join("\n") + "\n";
        writeAtomicLocked(turnsFile, body);
      } else {
        appendJsonLineLocked(turnsFile, `${JSON.stringify(safeRecord)}\n`);
      }
      return safeRecord;
    });
  }

  function listTopics() {
    const turns = listTurns();
    const groups = new Map();
    for (const turn of turns) {
      const topic = normalizeTopic(turn.topic);
      const existing = groups.get(topic);
      if (!existing) {
        groups.set(topic, {
          topic,
          turnCount: 1,
          firstTurnIndex: turn.turnIndex,
          lastTurnIndex: turn.turnIndex,
          lastTurnId: turn.turnId,
          modifiedFilesCount: (turn.modifiedFiles || []).length,
          summary: turn.userSummary || turn.assistantSummary || turn.rawUserText || "",
        });
      } else {
        existing.turnCount += 1;
        existing.lastTurnIndex = Math.max(existing.lastTurnIndex, turn.turnIndex);
        existing.lastTurnId = turn.turnId;
        existing.modifiedFilesCount += (turn.modifiedFiles || []).length;
        if (turn.userSummary || turn.assistantSummary) {
          existing.summary = turn.userSummary || turn.assistantSummary;
        }
      }
    }
    return [...groups.values()].sort((a, b) => b.lastTurnIndex - a.lastTurnIndex);
  }

  function search(query = "", options = {}) {
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 8;
    const turns = listTurns({
      topic: options.topic,
      outcomes: options.outcomes,
      excludeTurnIds: options.excludeTurnIds,
    });
    if (!turns.length) return [];

    const trimmedQuery = String(query || "").trim();
    if (!trimmedQuery) {
      return turns.slice(-limit).reverse().map((turn) => ({ turn, score: 1, matchedTerms: [] }));
    }

    const queryTokens = tokenizeForSearch(trimmedQuery);
    const uniqueQueryTerms = new Map();
    for (const { term, weight } of queryTokens) {
      uniqueQueryTerms.set(term, Math.max(uniqueQueryTerms.get(term) || 0, weight));
    }
    if (!uniqueQueryTerms.size) return [];

    const termMaps = turns.map((turn) => buildTurnTermMap(turn));
    const docFreq = new Map();
    for (const term of uniqueQueryTerms.keys()) {
      let df = 0;
      for (const map of termMaps) {
        if (map.has(term)) df += 1;
      }
      docFreq.set(term, df);
    }

    const totalDocs = turns.length;
    const lowerQuery = trimmedQuery.toLowerCase();
    const scored = [];
    for (let i = 0; i < turns.length; i += 1) {
      const turn = turns[i];
      const map = termMaps[i];
      let score = 0;
      const matchedTerms = [];

      if (turn.turnId.toLowerCase() === lowerQuery) {
        score += 12;
        matchedTerms.push(turn.turnId);
      }

      for (const [term, qWeight] of uniqueQueryTerms.entries()) {
        const tf = map.get(term) || 0;
        if (tf <= 0) continue;
        const df = docFreq.get(term) || 1;
        const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
        const bm25 = (tf / (tf + 1.2)) * idf * qWeight;
        score += bm25;
        matchedTerms.push(term);
      }

      // Bonus for exact path or symbol substring match in files/keywords.
      const pathAndKeywordHaystack = [
        ...(turn.touchedFiles || []),
        ...(turn.modifiedFiles || []),
        ...(turn.keywords || []),
      ].join("\n").toLowerCase();
      for (const [term] of uniqueQueryTerms.entries()) {
        if (term.length >= 4 && pathAndKeywordHaystack.includes(term)) {
          score += 0.6;
        }
      }

      if (score > 0) {
        scored.push({
          turn,
          score: Number(score.toFixed(4)),
          matchedTerms: dedupeStrings(matchedTerms, 16),
        });
      }
    }

    scored.sort((a, b) => (b.score - a.score) || ((b.turn.turnIndex || 0) - (a.turn.turnIndex || 0)));
    return scored.slice(0, limit);
  }

  function loadWindowState() {
    if (!fs.existsSync(windowFile)) return null;
    return withFileLock(windowFile, () => {
      if (!fs.existsSync(windowFile)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(windowFile, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    });
  }

  function saveWindowState(state) {
    return withFileLock(windowFile, () => {
      const payload = sanitize({
        version: 1,
        ...state,
        updatedAt: new Date().toISOString(),
      });
      writeAtomicLocked(windowFile, `${JSON.stringify(payload, null, 2)}\n`);
      return payload;
    });
  }

  function remove() {
    for (const filePath of [turnsFile, windowFile]) {
      try {
        if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
      } catch {}
    }
  }

  return Object.freeze({
    dir,
    turnsFile,
    windowFile,
    namespace: ns,
    sessionId: sid,
    upsertTurn,
    listTurns,
    getTurn,
    listTopics,
    search,
    loadWindowState,
    saveWindowState,
    remove,
  });
}

module.exports = {
  createTurnIndexStore,
  normalizeTopic,
  tokenizeForSearch,
};

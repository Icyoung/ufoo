"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const { stripVisionBase64, degradeVisionContent } = require("../providers/visionBlocks");

const JOURNAL_VERSION = 3;

function getJournalDir(workspaceRoot = process.cwd()) {
  return path.join(path.resolve(workspaceRoot || process.cwd()), ".ufoo", "agent", "ucode", "journal");
}

function getJournalPath(workspaceRoot = process.cwd(), sessionId = "") {
  const id = String(sessionId || "").trim();
  return id ? path.join(getJournalDir(workspaceRoot), `${id}.jsonl`) : "";
}

function getLegacyTranscriptPath(workspaceRoot = process.cwd(), sessionId = "") {
  const id = String(sessionId || "").trim();
  return id
    ? path.join(path.resolve(workspaceRoot || process.cwd()), ".ufoo", "agent", "ucode", "transcripts", `${id}.jsonl`)
    : "";
}

function deleteSessionJournal(workspaceRoot = process.cwd(), sessionId = "") {
  const filePath = getJournalPath(workspaceRoot, sessionId);
  if (!filePath || !fs.existsSync(filePath)) return { ok: true, error: "" };
  try {
    fs.unlinkSync(filePath);
    return { ok: true, error: "" };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to delete session journal",
    };
  }
}

function readJsonl(filePath = "") {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
  } catch {
    return [];
  }
}

function stablePayloadFingerprint(value) {
  try {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  } catch {
    return "";
  }
}

function contentForStorage(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const hasVision = content.some((block) => {
      if (!block || typeof block !== "object") return false;
      const type = String(block.type || "").trim().toLowerCase();
      return type === "image" || type === "image_url"
        || (type === "tool_result" && Array.isArray(block.content));
    });
    return hasVision
      ? degradeVisionContent(stripVisionBase64(content))
      : stripVisionBase64(content);
  }
  if (content && typeof content === "object") return stripVisionBase64(content);
  return content;
}

function parseArtifactMessage(message = {}) {
  if (typeof message.content !== "string" || !message.content.trim()) return null;
  try {
    const parsed = JSON.parse(message.content);
    const artifactId = String(parsed && parsed.artifactId || "").trim();
    if (!artifactId) return null;
    return { artifactId, preview: String(parsed.preview || "").trim() };
  } catch {
    return null;
  }
}

function messageEventType(message = {}) {
  const role = String(message.role || "").trim().toLowerCase();
  if (
    role === "user"
    && Array.isArray(message.content)
    && message.content.some((block) => String(block && block.type || "").toLowerCase() === "tool_result")
  ) {
    return "tool.result";
  }
  if (role === "user") return "user.message";
  if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return "assistant.tool_calls";
  }
  if (role === "assistant") return "assistant.message";
  if (role === "tool") return "tool.result";
  return "conversation.item";
}

function messageToJournalEvent(message = {}, options = {}) {
  const role = String(message && message.role || "").trim().toLowerCase();
  if (!role || role === "system") return null;
  const turnId = String(options.turnId || "").trim();
  const index = Number.isFinite(options.index) ? Math.max(0, Math.floor(options.index)) : 0;
  const toolCallId = String(message.tool_call_id || "").trim();
  const parsedArtifact = role === "tool" ? parseArtifactMessage(message) : null;
  const artifactId = String(message.artifactId || (parsedArtifact && parsedArtifact.artifactId) || "").trim();
  const artifactPreview = String(message.preview || (parsedArtifact && parsedArtifact.preview) || "").trim();
  const payload = {
    role,
    content: artifactId ? undefined : contentForStorage(message.content),
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : undefined,
    toolCallId: toolCallId || undefined,
    artifactId: artifactId || undefined,
    preview: artifactId ? artifactPreview : undefined,
  };
  const itemId = String(options.itemId || toolCallId || `${turnId || "turn"}:${index}`).trim();
  return {
    version: JOURNAL_VERSION,
    eventId: String(options.eventId || `evt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`),
    idempotencyKey: String(options.idempotencyKey || `${turnId || "legacy"}:${index}:${messageEventType(message)}`),
    sessionId: String(options.sessionId || "").trim(),
    turnId,
    itemId,
    type: messageEventType(message),
    createdAt: String(options.createdAt || new Date().toISOString()),
    payload,
  };
}

function normalizeJournalEvent(event = {}, sessionId = "", seq = 0) {
  const source = event && typeof event === "object" ? event : {};
  return {
    version: JOURNAL_VERSION,
    seq: Number.isFinite(source.seq) ? Math.max(1, Math.floor(source.seq)) : Math.max(1, seq),
    eventId: String(source.eventId || `evt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`),
    idempotencyKey: String(source.idempotencyKey || ""),
    sessionId: String(source.sessionId || sessionId || "").trim(),
    turnId: String(source.turnId || "").trim(),
    itemId: String(source.itemId || "").trim(),
    type: String(source.type || "conversation.item").trim(),
    createdAt: String(source.createdAt || new Date().toISOString()),
    payload: source.payload && typeof source.payload === "object" ? source.payload : {},
  };
}

function loadJournal(workspaceRoot = process.cwd(), sessionId = "") {
  const filePath = getJournalPath(workspaceRoot, sessionId);
  const events = readJsonl(filePath)
    .filter((event) => Number(event && event.version) === JOURNAL_VERSION)
    .map((event, index) => normalizeJournalEvent(event, sessionId, index + 1))
    .sort((left, right) => left.seq - right.seq);
  return { filePath, events };
}

function appendJournalEvents(workspaceRoot = process.cwd(), sessionId = "", events = []) {
  const filePath = getJournalPath(workspaceRoot, sessionId);
  if (!filePath) return { ok: false, error: "invalid session id", events: [] };
  const existing = loadJournal(workspaceRoot, sessionId).events;
  const eventIds = new Set(existing.map((event) => event.eventId).filter(Boolean));
  const keys = new Set(existing.map((event) => event.idempotencyKey).filter(Boolean));
  let seq = existing.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0);
  const appended = [];
  for (const candidate of Array.isArray(events) ? events : []) {
    const normalized = normalizeJournalEvent(candidate, sessionId, seq + 1);
    if (eventIds.has(normalized.eventId)) continue;
    if (normalized.idempotencyKey && keys.has(normalized.idempotencyKey)) continue;
    seq += 1;
    normalized.seq = seq;
    eventIds.add(normalized.eventId);
    if (normalized.idempotencyKey) keys.add(normalized.idempotencyKey);
    appended.push(normalized);
  }
  if (appended.length === 0) return { ok: true, error: "", events: [], filePath };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${appended.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    return { ok: true, error: "", events: appended, filePath };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to append session journal",
      events: [],
      filePath,
    };
  }
}

function sameLegacyAssistant(left = {}, right = {}) {
  if (String(left.role || "") !== "assistant" || String(right.role || "") !== "assistant") return false;
  return stablePayloadFingerprint({ content: left.content, toolCalls: left.toolCalls })
    === stablePayloadFingerprint({ content: right.content, toolCalls: right.toolCalls });
}

function legacyDuplicateIndexes(events = []) {
  const duplicates = new Set();
  for (let index = 1; index < events.length - 1; index += 1) {
    const prior = events[index - 1] || {};
    const candidate = events[index] || {};
    const next = events[index + 1] || {};
    if (!sameLegacyAssistant(prior, candidate) || String(next.role || "") !== "user") continue;
    const candidateAt = Date.parse(String(candidate.createdAt || ""));
    const priorAt = Date.parse(String(prior.createdAt || ""));
    const nextAt = Date.parse(String(next.createdAt || ""));
    if (
      !Number.isFinite(priorAt)
      || !Number.isFinite(candidateAt)
      || !Number.isFinite(nextAt)
      || candidateAt - priorAt <= 2000
      || Math.abs(nextAt - candidateAt) > 2000
    ) {
      continue;
    }
    duplicates.add(index);
  }
  return duplicates;
}

function readLegacyProjection(workspaceRoot = process.cwd(), sessionId = "") {
  const filePath = getLegacyTranscriptPath(workspaceRoot, sessionId);
  const events = readJsonl(filePath);
  const duplicates = legacyDuplicateIndexes(events);
  return {
    filePath,
    events: events.filter((_event, index) => !duplicates.has(index)),
    suppressed: [...duplicates].map((index) => ({ duplicate: events[index], original: events[index - 1] })),
  };
}

function journalEventToTranscriptEvent(event = {}) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  if (!payload.role || event.type === "history.corrected") return null;
  return {
    id: event.eventId,
    role: payload.role,
    content: payload.content,
    toolCalls: payload.toolCalls,
    toolCallId: payload.toolCallId,
    artifactId: payload.artifactId,
    preview: payload.preview,
    segmentId: payload.segmentId,
    turnId: event.turnId,
    itemId: event.itemId,
    createdAt: event.createdAt,
  };
}

function loadTranscriptProjection(workspaceRoot = process.cwd(), sessionId = "") {
  const journal = loadJournal(workspaceRoot, sessionId);
  if (journal.events.length > 0) {
    return {
      filePath: journal.filePath,
      events: journal.events.map(journalEventToTranscriptEvent).filter(Boolean),
      source: "journal-v3",
      suppressed: [],
    };
  }
  const legacy = readLegacyProjection(workspaceRoot, sessionId);
  return { ...legacy, source: "transcript-v2" };
}

function migrateLegacyJournal(workspaceRoot = process.cwd(), sessionId = "") {
  const current = loadJournal(workspaceRoot, sessionId);
  if (current.events.length > 0) return { ok: true, migrated: false, ...current };
  const legacy = readLegacyProjection(workspaceRoot, sessionId);
  if (legacy.events.length === 0 && legacy.suppressed.length === 0) {
    return { ok: true, migrated: false, filePath: current.filePath, events: [] };
  }
  const imported = legacy.events.flatMap((message, index) => {
    const event = messageToJournalEvent({
      role: message.role,
      content: message.content,
      tool_calls: message.toolCalls,
      tool_call_id: message.toolCallId,
      artifactId: message.artifactId,
      preview: message.preview,
    }, {
      sessionId,
      turnId: String(message.turnId || message.segmentId || "legacy"),
      index,
      eventId: `migrated_${String(message.id || index)}`,
      idempotencyKey: `legacy:${String(message.id || index)}`,
      createdAt: message.createdAt,
    });
    return event ? [event] : [];
  });
  const corrections = legacy.suppressed.map(({ duplicate, original }, index) => ({
    version: JOURNAL_VERSION,
    eventId: `correction_${String(duplicate && duplicate.id || index)}`,
    idempotencyKey: `correction:${String(duplicate && duplicate.id || index)}`,
    sessionId,
    turnId: "migration",
    itemId: "",
    type: "history.corrected",
    createdAt: new Date().toISOString(),
    payload: {
      suppressedEventId: String(duplicate && duplicate.id || ""),
      duplicateOf: String(original && original.id || ""),
      reason: "legacy_system_baseline_shift",
    },
  }));
  const result = appendJournalEvents(workspaceRoot, sessionId, imported.concat(corrections));
  return { ...result, migrated: result.ok, suppressed: legacy.suppressed.length };
}

function appendTurnMessages(
  workspaceRoot = process.cwd(),
  sessionId = "",
  turnId = "",
  messages = [],
  options = {},
) {
  const migration = migrateLegacyJournal(workspaceRoot, sessionId);
  if (!migration.ok) return migration;
  const scope = String(options.scope || "items").trim() || "items";
  const events = (Array.isArray(messages) ? messages : []).flatMap((message, index) => {
    const event = messageToJournalEvent(message, {
      sessionId,
      turnId,
      index,
      idempotencyKey: `${turnId || "turn"}:${scope}:${index}:${messageEventType(message)}`,
    });
    return event ? [event] : [];
  });
  return appendJournalEvents(workspaceRoot, sessionId, events);
}

module.exports = {
  JOURNAL_VERSION,
  getJournalDir,
  getJournalPath,
  deleteSessionJournal,
  loadJournal,
  appendJournalEvents,
  appendTurnMessages,
  loadTranscriptProjection,
  migrateLegacyJournal,
  legacyDuplicateIndexes,
  messageToJournalEvent,
  journalEventToTranscriptEvent,
};

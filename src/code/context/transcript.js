"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

function getTranscriptsDir(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot || process.cwd());
  return path.join(root, ".ufoo", "agent", "ucode", "transcripts");
}

function getTranscriptFilePath(workspaceRoot = process.cwd(), sessionId = "") {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  return path.join(getTranscriptsDir(workspaceRoot), `${id}.jsonl`);
}

function createTranscriptEventId() {
  return `msg_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function normalizeTranscriptEvent(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    id: String(source.id || createTranscriptEventId()).trim(),
    role: String(source.role || "").trim(),
    content: source.content,
    toolCalls: Array.isArray(source.toolCalls) ? source.toolCalls : undefined,
    toolCallId: source.toolCallId ? String(source.toolCallId) : undefined,
    artifactId: source.artifactId ? String(source.artifactId) : undefined,
    preview: source.preview ? String(source.preview) : undefined,
    segmentId: source.segmentId ? String(source.segmentId) : undefined,
    createdAt: String(source.createdAt || new Date().toISOString()),
    rawMessage: source.rawMessage && typeof source.rawMessage === "object"
      ? source.rawMessage
      : undefined,
  };
}

function messageToTranscriptEvent(message = {}, extra = {}) {
  if (!message || typeof message !== "object") return null;
  const role = String(message.role || "").trim();
  if (!role) return null;
  const event = {
    id: createTranscriptEventId(),
    role,
    content: message.content,
    createdAt: new Date().toISOString(),
    rawMessage: message,
    ...extra,
  };
  if (message.tool_calls) event.toolCalls = message.tool_calls;
  if (message.tool_call_id) event.toolCallId = message.tool_call_id;
  return normalizeTranscriptEvent(event);
}

function readTranscriptFile(filePath = "") {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return [];
    const events = [];
    for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      try {
        events.push(normalizeTranscriptEvent(JSON.parse(line)));
      } catch {
        // ignore malformed line
      }
    }
    return events;
  } catch {
    return [];
  }
}

function loadTranscript(workspaceRoot = process.cwd(), sessionId = "") {
  const filePath = getTranscriptFilePath(workspaceRoot, sessionId);
  return {
    filePath,
    events: readTranscriptFile(filePath),
  };
}

function appendTranscriptEvent(workspaceRoot = process.cwd(), sessionId = "", event = {}) {
  const filePath = getTranscriptFilePath(workspaceRoot, sessionId);
  if (!filePath) {
    return { ok: false, error: "invalid session id", event: null };
  }
  const normalized = normalizeTranscriptEvent(event);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(normalized)}\n`, "utf8");
    return { ok: true, error: "", event: normalized, filePath };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to append transcript",
      event: normalized,
      filePath,
    };
  }
}

function appendTranscriptMessages(workspaceRoot = process.cwd(), sessionId = "", messages = [], extra = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const appended = [];
  for (const message of list) {
    const event = messageToTranscriptEvent(message, extra);
    if (!event) continue;
    const result = appendTranscriptEvent(workspaceRoot, sessionId, event);
    if (result.ok) appended.push(result.event);
  }
  return appended;
}

function transcriptEventsToMessages(events = [], options = {}) {
  const preferArtifact = options.preferArtifact !== false;
  const list = Array.isArray(events) ? events : [];
  const messages = [];
  for (const event of list) {
    if (preferArtifact && event.artifactId) {
      messages.push({
        role: event.role || "tool",
        content: JSON.stringify({
          artifactId: event.artifactId,
          preview: event.preview || "",
        }),
        tool_call_id: event.toolCallId,
      });
      continue;
    }
    if (!preferArtifact && event.rawMessage && typeof event.rawMessage === "object") {
      messages.push(event.rawMessage);
      continue;
    }
    const message = { role: event.role };
    if (event.content !== undefined) message.content = event.content;
    if (event.toolCalls) message.tool_calls = event.toolCalls;
    if (event.toolCallId) message.tool_call_id = event.toolCallId;
    messages.push(message);
  }
  return messages;
}

function migrateNlMessagesToTranscript(workspaceRoot = process.cwd(), sessionId = "", nlMessages = []) {
  const filePath = getTranscriptFilePath(workspaceRoot, sessionId);
  if (filePath && fs.existsSync(filePath)) {
    return loadTranscript(workspaceRoot, sessionId).events;
  }
  const messages = Array.isArray(nlMessages) ? nlMessages : [];
  if (messages.length === 0) return [];
  appendTranscriptMessages(workspaceRoot, sessionId, messages, { migrated: true });
  return loadTranscript(workspaceRoot, sessionId).events;
}

function deleteTranscript(workspaceRoot = process.cwd(), sessionId = "") {
  const filePath = getTranscriptFilePath(workspaceRoot, sessionId);
  if (!filePath || !fs.existsSync(filePath)) return { ok: true, error: "" };
  try {
    fs.unlinkSync(filePath);
    return { ok: true, error: "" };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to delete transcript",
    };
  }
}

module.exports = {
  getTranscriptsDir,
  getTranscriptFilePath,
  createTranscriptEventId,
  normalizeTranscriptEvent,
  messageToTranscriptEvent,
  loadTranscript,
  appendTranscriptEvent,
  appendTranscriptMessages,
  transcriptEventsToMessages,
  migrateNlMessagesToTranscript,
  deleteTranscript,
};

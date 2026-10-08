const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  getTranscriptsDir,
  getTranscriptFilePath,
  loadTranscript,
  migrateNlMessagesToTranscript,
  deleteTranscript,
} = require("./context/transcript");
const { getJournalPath, deleteSessionJournal } = require("./conversation/sessionJournal");
const { deleteSessionArtifacts } = require("./context/artifacts");
const { deleteSessionCommitLog, maybeGcSessionArtifacts } = require("./context/artifactGc");
const { defaultContextPolicy } = require("./context/assembler");
const { emptyTaskContract } = require("./context/stateCommit");
const { emptyWorkingSet } = require("./context/workingSet");
const { emptyExecutionState } = require("./context/executionSegment");

const { createSessionStore } = require("../agents/runtime/context/sessionStore");
const sessionStore = createSessionStore({
  namespace: "ucode",
  encode: (input, { workspaceRoot }) => buildSessionSnapshot({ ...input, workspaceRoot }),
  toDisk: (payload) => {
    const stored = { ...payload };
    // Explicit turn commits own conversation truth; snapshots only save metadata.
    if (stored.version >= 2) delete stored.nlMessages;
    return stored;
  },
  decode: (parsed, { workspaceRoot, sessionId }) => hydrateSessionFromDisk({
    ...parsed, sessionId, workspaceRoot,
    createdAt: parsed && parsed.createdAt || "",
    nlMessages: parsed && parsed.nlMessages || [],
  }, workspaceRoot),
  prepareSave: (workspaceRoot) => fs.mkdirSync(getTranscriptsDir(workspaceRoot), { recursive: true }),
});
const getSessionsDir = sessionStore.getDirectory;

function normalizeSessionId(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(raw)) return "";
  return raw;
}

function createSessionId(prefix = "ucode") {
  const safePrefix = String(prefix || "ucode").trim().replace(/[^a-zA-Z0-9_-]+/g, "") || "ucode";
  return `${safePrefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function resolveSessionId(value = "") {
  const normalized = normalizeSessionId(value);
  if (normalized) return normalized;
  return createSessionId("ucode");
}

function toIsoNow() {
  return new Date().toISOString();
}

function cloneMessages(value = []) {
  if (!Array.isArray(value)) return [];
  try {
    const parsed = JSON.parse(JSON.stringify(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
  } catch {
    return [];
  }
}

function normalizeContextPolicy(value = {}) {
  const defaults = defaultContextPolicy();
  const source = value && typeof value === "object" ? value : {};
  return {
    ...defaults,
    ...source,
    transcriptWindow: Number.isFinite(source.transcriptWindow)
      ? Math.max(1, Math.floor(source.transcriptWindow))
      : defaults.transcriptWindow,
  };
}

function buildSessionSnapshot(input = {}) {
  // Durable session fields vs projections: src/code/protocol/ownership.js
  const source = input && typeof input === "object" ? input : {};
  const sessionId = resolveSessionId(source.sessionId);
  const createdAt = String(source.createdAt || "").trim() || toIsoNow();

  const base = {
    sessionId,
    workspaceRoot: String(source.workspaceRoot || process.cwd()).trim() || process.cwd(),
    provider: String(source.provider || "").trim(),
    model: String(source.model || "").trim(),
    context: String(source.context || ""),
    createdAt,
    updatedAt: toIsoNow(),
  };

  return {
    version: 3,
    ...base,
    journal: {
      path: getJournalPath(base.workspaceRoot, sessionId),
    },
    transcript: {
      path: getTranscriptFilePath(base.workspaceRoot, sessionId),
    },
    artifacts: {
      indexPath: path.join(base.workspaceRoot, ".ufoo", "agent", "ucode", "artifacts", sessionId),
    },
    contextPolicy: normalizeContextPolicy(source.contextPolicy),
    summary: String(source.summary || "").trim(),
    projectSnapshot: source.projectSnapshot && typeof source.projectSnapshot === "object"
      ? source.projectSnapshot
      : null,
    taskContract: source.taskContract && typeof source.taskContract === "object"
      ? source.taskContract
      : emptyTaskContract(),
    stateEpoch: source.stateEpoch && typeof source.stateEpoch === "object"
      ? source.stateEpoch
      : null,
    workingSet: Array.isArray(source.workingSet) ? source.workingSet : emptyWorkingSet(),
    executionState: source.executionState && typeof source.executionState === "object"
      ? source.executionState
      : emptyExecutionState(),
    activeSkills: Array.isArray(source.activeSkills) ? source.activeSkills : [],
    toolCallsSinceCommit: Number.isFinite(source.toolCallsSinceCommit)
      ? Math.max(0, Math.floor(source.toolCallsSinceCommit))
      : 0,
    // In-memory compatibility for callers still reading nlMessages
    nlMessages: cloneMessages(source.nlMessages),
    contextMeter: source.contextMeter && typeof source.contextMeter === "object"
      ? {
        usedTokens: Number(source.contextMeter.usedTokens) || 0,
        limitTokens: Number(source.contextMeter.limitTokens) || 0,
        model: String(source.contextMeter.model || source.model || "").trim(),
        label: String(source.contextMeter.label || "").trim(),
        updatedAt: String(source.contextMeter.updatedAt || "").trim(),
      }
      : null,
  };
}

function hydrateSessionFromDisk(snapshot = {}, workspaceRoot = process.cwd()) {
  const payload = buildSessionSnapshot({
    ...snapshot,
    workspaceRoot: workspaceRoot || snapshot.workspaceRoot,
  });
  if (payload.version < 2) return payload;

  const sessionId = payload.sessionId;
  const transcript = loadTranscript(workspaceRoot, sessionId);
  if (transcript.events.length > 0) {
    const { transcriptEventsToMessages } = require("./context/transcript");
    payload.nlMessages = transcriptEventsToMessages(transcript.events);
    return payload;
  }

  if (Array.isArray(snapshot.nlMessages) && snapshot.nlMessages.length > 0) {
    migrateNlMessagesToTranscript(workspaceRoot, sessionId, snapshot.nlMessages);
    const reloaded = loadTranscript(workspaceRoot, sessionId);
    const { transcriptEventsToMessages } = require("./context/transcript");
    payload.nlMessages = transcriptEventsToMessages(reloaded.events);
  }

  return payload;
}

function listSessionSummaries(workspaceRoot = process.cwd(), { limit = 40 } = {}) {
  const dir = getSessionsDir(workspaceRoot);
  const cap = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 40;
  if (!fs.existsSync(dir)) return [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const rows = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      parsed = null;
    }
    const sessionId = normalizeSessionId(
      (parsed && parsed.sessionId) || name.replace(/\.json$/i, ""),
    );
    if (!sessionId) continue;
    const updatedAt = String(
      (parsed && (parsed.updatedAt || parsed.createdAt))
      || (stat && stat.mtime && stat.mtime.toISOString())
      || "",
    ).trim();
    const summary = String((parsed && parsed.summary) || "").trim().replace(/\s+/g, " ");
    const model = String((parsed && parsed.model) || "").trim();
    const bits = [
      updatedAt ? updatedAt.slice(0, 19).replace("T", " ") : "",
      model,
      summary ? summary.slice(0, 48) : "",
    ].filter(Boolean);
    rows.push({
      id: sessionId,
      cmd: sessionId,
      alias: sessionId,
      desc: bits.join(" · "),
      updatedAt,
      mtimeMs: stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
    });
  }

  rows.sort((left, right) => {
    const byTime = (right.mtimeMs || 0) - (left.mtimeMs || 0);
    if (byTime !== 0) return byTime;
    return String(left.id).localeCompare(String(right.id));
  });
  return rows.slice(0, cap);
}

const getSessionFilePath = sessionStore.getFilePath;

function saveSessionSnapshot(workspaceRoot = process.cwd(), snapshot = {}) {
  const normalizedRoot = path.resolve(workspaceRoot || process.cwd());
  const saved = sessionStore.save(normalizedRoot, snapshot);
  if (!saved.ok) return saved;
  const payload = saved.snapshot;
  const filePath = saved.filePath;

  // Artifact GC is throttled (default 2m) so long sessions do not accumulate
  // unbounded tool result files between explicit maintenance runs.
  let artifactGc = null;
  try {
    artifactGc = maybeGcSessionArtifacts(normalizedRoot, payload.sessionId, {
      ...(snapshot.artifactGc && typeof snapshot.artifactGc === "object" ? snapshot.artifactGc : {}),
    });
  } catch {
    artifactGc = { ok: false, error: "artifact gc failed", skipped: true };
  }

  return {
    ok: true,
    error: "",
    sessionId: payload.sessionId,
    filePath,
    snapshot: payload,
    artifactGc,
  };
}

const loadSessionSnapshot = sessionStore.load;

function deleteSessionData(workspaceRoot = process.cwd(), sessionId = "") {
  const normalizedId = normalizeSessionId(sessionId);
  if (!normalizedId) return { ok: false, error: "invalid session id" };
  const filePath = getSessionFilePath(workspaceRoot, normalizedId);
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    deleteSessionJournal(workspaceRoot, normalizedId);
    deleteTranscript(workspaceRoot, normalizedId);
    deleteSessionArtifacts(workspaceRoot, normalizedId);
    deleteSessionCommitLog(workspaceRoot, normalizedId);
    return { ok: true, error: "" };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to delete session data",
    };
  }
}

module.exports = {
  getSessionsDir,
  getTranscriptsDir,
  getTranscriptFilePath,
  normalizeSessionId,
  createSessionId,
  resolveSessionId,
  buildSessionSnapshot,
  hydrateSessionFromDisk,
  getSessionFilePath,
  saveSessionSnapshot,
  loadSessionSnapshot,
  listSessionSummaries,
  deleteSessionData,
};

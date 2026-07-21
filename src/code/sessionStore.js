const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const {
  getTranscriptsDir,
  getTranscriptFilePath,
  loadTranscript,
  migrateNlMessagesToTranscript,
  appendTranscriptMessages,
  transcriptEventsToMessages,
  deleteTranscript,
} = require("./context/transcript");
const { deleteSessionArtifacts } = require("./context/artifacts");
const { deleteSessionCommitLog, maybeGcSessionArtifacts } = require("./context/artifactGc");
const { defaultContextPolicy } = require("./context/assembler");
const { emptyTaskContract } = require("./context/stateCommit");
const { emptyWorkingSet } = require("./context/workingSet");
const { emptyExecutionState } = require("./context/executionSegment");

function getSessionsDir(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot || process.cwd());
  return path.join(root, ".ufoo", "agent", "ucode", "sessions");
}

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
    version: 2,
    ...base,
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

function syncTranscriptFromNlMessages(workspaceRoot = process.cwd(), sessionId = "", nlMessages = []) {
  const messages = Array.isArray(nlMessages) ? nlMessages : [];
  if (!sessionId || messages.length === 0) return;
  const existing = loadTranscript(workspaceRoot, sessionId);
  if (existing.events.length === 0) {
    migrateNlMessagesToTranscript(workspaceRoot, sessionId, messages);
    return;
  }
  const { matchTranscriptBaseline } = require("./context/assembler");
  const priorMessages = transcriptEventsToMessages(existing.events);
  const baseline = matchTranscriptBaseline(priorMessages, messages);
  if (messages.length > baseline) {
    appendTranscriptMessages(workspaceRoot, sessionId, messages.slice(baseline));
  }
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

function getSessionFilePath(workspaceRoot = process.cwd(), sessionId = "") {
  const normalizedId = normalizeSessionId(sessionId);
  if (!normalizedId) return "";
  return path.join(getSessionsDir(workspaceRoot), `${normalizedId}.json`);
}

function saveSessionSnapshot(workspaceRoot = process.cwd(), snapshot = {}) {
  const normalizedRoot = path.resolve(workspaceRoot || process.cwd());
  const payload = buildSessionSnapshot({
    ...snapshot,
    workspaceRoot: normalizedRoot,
  });
  const filePath = getSessionFilePath(normalizedRoot, payload.sessionId);
  if (!filePath) {
    return {
      ok: false,
      error: "invalid session id",
      sessionId: "",
      filePath: "",
    };
  }

  const toWrite = { ...payload };
  if (toWrite.version >= 2) {
    syncTranscriptFromNlMessages(normalizedRoot, payload.sessionId, payload.nlMessages);
    // nlMessages live in transcript.jsonl; keep session.json light
    delete toWrite.nlMessages;
  }

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.mkdirSync(getTranscriptsDir(normalizedRoot), { recursive: true });
    const tmpFile = `${filePath}.${process.pid}-${randomUUID()}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(toWrite, null, 2)}\n`, "utf8");
    fs.renameSync(tmpFile, filePath);
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to save session",
      sessionId: payload.sessionId,
      filePath,
    };
  }

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

function loadSessionSnapshot(workspaceRoot = process.cwd(), sessionId = "") {
  const normalizedRoot = path.resolve(workspaceRoot || process.cwd());
  const normalizedId = normalizeSessionId(sessionId);
  if (!normalizedId) {
    return {
      ok: false,
      error: "invalid session id",
      sessionId: "",
      snapshot: null,
      filePath: "",
    };
  }

  const filePath = getSessionFilePath(normalizedRoot, normalizedId);
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      error: `session not found: ${normalizedId}`,
      sessionId: normalizedId,
      snapshot: null,
      filePath: filePath || "",
    };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const snapshot = hydrateSessionFromDisk({
      ...parsed,
      sessionId: normalizedId,
      workspaceRoot: normalizedRoot,
      createdAt: parsed && parsed.createdAt ? parsed.createdAt : "",
      nlMessages: parsed && parsed.nlMessages ? parsed.nlMessages : [],
    }, normalizedRoot);
    return {
      ok: true,
      error: "",
      sessionId: normalizedId,
      snapshot,
      filePath,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to load session",
      sessionId: normalizedId,
      snapshot: null,
      filePath,
    };
  }
}

function deleteSessionData(workspaceRoot = process.cwd(), sessionId = "") {
  const normalizedId = normalizeSessionId(sessionId);
  if (!normalizedId) return { ok: false, error: "invalid session id" };
  const filePath = getSessionFilePath(workspaceRoot, normalizedId);
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
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

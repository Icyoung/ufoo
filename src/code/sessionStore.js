const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

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

function buildSessionSnapshot(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const sessionId = resolveSessionId(source.sessionId);
  const createdAt = String(source.createdAt || "").trim() || toIsoNow();
  return {
    version: 1,
    sessionId,
    workspaceRoot: String(source.workspaceRoot || process.cwd()).trim() || process.cwd(),
    provider: String(source.provider || "").trim(),
    model: String(source.model || "").trim(),
    context: String(source.context || ""),
    nlMessages: cloneMessages(source.nlMessages),
    createdAt,
    updatedAt: toIsoNow(),
  };
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

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return {
      ok: true,
      error: "",
      sessionId: payload.sessionId,
      filePath,
      snapshot: payload,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to save session",
      sessionId: payload.sessionId,
      filePath,
    };
  }
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
    const snapshot = buildSessionSnapshot({
      ...parsed,
      sessionId: normalizedId,
      workspaceRoot: normalizedRoot,
      createdAt: parsed && parsed.createdAt ? parsed.createdAt : "",
    });
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

module.exports = {
  getSessionsDir,
  normalizeSessionId,
  createSessionId,
  resolveSessionId,
  buildSessionSnapshot,
  getSessionFilePath,
  saveSessionSnapshot,
  loadSessionSnapshot,
};

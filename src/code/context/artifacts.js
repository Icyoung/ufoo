"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { randomUUID } = require("crypto");

function getArtifactsDir(workspaceRoot = process.cwd(), sessionId = "") {
  const root = path.resolve(workspaceRoot || process.cwd());
  const id = String(sessionId || "").trim();
  if (!id) return path.join(root, ".ufoo", "agent", "ucode", "artifacts");
  return path.join(root, ".ufoo", "agent", "ucode", "artifacts", id);
}

function createArtifactId(prefix = "artifact") {
  const safe = String(prefix || "artifact").trim().replace(/[^a-zA-Z0-9_-]+/g, "") || "artifact";
  return `${safe}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function hashContent(value = "") {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex").slice(0, 16);
}

function getArtifactFilePath(workspaceRoot = process.cwd(), sessionId = "", artifactId = "") {
  const id = String(artifactId || "").trim();
  if (!id) return "";
  return path.join(getArtifactsDir(workspaceRoot, sessionId), `${id}.json`);
}

function buildArtifactRecord({
  artifactId = "",
  type = "tool_result",
  source = "",
  tool = "",
  args = {},
  raw = null,
  summary = "",
  index = {},
  createdBy = "",
  cold = false,
  coldAt = "",
  createdAt = "",
  hash = "",
  sizeBytes = null,
} = {}) {
  const rawText = typeof raw === "string" ? raw : JSON.stringify(raw);
  const { buildArtifactIndex } = require("./artifactIndex");
  const computedIndex = index && typeof index === "object" && Object.keys(index).length > 0
    ? index
    : buildArtifactIndex({ tool, raw, args });
  return {
    artifactId: artifactId || createArtifactId(),
    type: String(type || "tool_result"),
    source: String(source || ""),
    tool: String(tool || ""),
    args: args && typeof args === "object" ? args : {},
    hash: hash || hashContent(rawText),
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : Buffer.byteLength(rawText, "utf8"),
    createdAt: String(createdAt || "") || new Date().toISOString(),
    createdBy: String(createdBy || tool || ""),
    summary: String(summary || ""),
    index: computedIndex && typeof computedIndex === "object" ? computedIndex : {},
    cold: Boolean(cold),
    coldAt: cold ? String(coldAt || new Date().toISOString()) : "",
    raw,
  };
}

function saveArtifact(workspaceRoot = process.cwd(), sessionId = "", record = {}) {
  const payload = buildArtifactRecord(record);
  const filePath = getArtifactFilePath(workspaceRoot, sessionId, payload.artifactId);
  if (!filePath) {
    return { ok: false, error: "invalid artifact id", artifact: null };
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { ok: true, error: "", artifact: payload, filePath };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to save artifact",
      artifact: payload,
      filePath,
    };
  }
}

function loadArtifact(workspaceRoot = process.cwd(), sessionId = "", artifactId = "") {
  const filePath = getArtifactFilePath(workspaceRoot, sessionId, artifactId);
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: `artifact not found: ${artifactId}`, artifact: null, filePath };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return { ok: true, error: "", artifact: parsed, filePath };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to load artifact",
      artifact: null,
      filePath,
    };
  }
}

function readArtifactSlice(artifact = null, selector = {}) {
  const record = artifact && typeof artifact === "object" ? artifact : null;
  if (!record) return { ok: false, error: "missing artifact", content: "" };
  const raw = record.raw;
  const sel = selector && typeof selector === "object" ? selector : {};

  if (record.type === "source_file" || record.tool === "read") {
    const content = raw && typeof raw === "object" ? String(raw.content || "") : String(raw || "");
    const startLine = Number(sel.startLine || sel.start || 0);
    const endLine = Number(sel.endLine || sel.end || 0);
    if (startLine > 0 && endLine >= startLine) {
      const lines = content.split(/\r?\n/);
      const slice = lines.slice(startLine - 1, endLine).join("\n");
      return { ok: true, error: "", content: slice, range: `${startLine}-${endLine}` };
    }
    const maxChars = Number(sel.maxChars || 8000);
    if (content.length > maxChars) {
      return {
        ok: true,
        error: "",
        content: `${content.slice(0, maxChars)}\n...[truncated]`,
        truncated: true,
      };
    }
    return { ok: true, error: "", content };
  }

  if (record.tool === "bash") {
    const stdout = raw && typeof raw === "object" ? String(raw.stdout || "") : "";
    const stderr = raw && typeof raw === "object" ? String(raw.stderr || "") : "";
    const tail = Number(sel.tailLines || 40);
    const tailStdout = stdout.split(/\r?\n/).slice(-tail).join("\n");
    const tailStderr = stderr.split(/\r?\n/).slice(-tail).join("\n");
    return {
      ok: true,
      error: "",
      content: JSON.stringify({
        exitCode: raw && typeof raw === "object" ? raw.code : null,
        stdout: tailStdout,
        stderr: tailStderr,
      }, null, 2),
    };
  }

  const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  const maxChars = Number(sel.maxChars || 12000);
  if (text.length > maxChars) {
    return { ok: true, error: "", content: `${text.slice(0, maxChars)}\n...[truncated]`, truncated: true };
  }
  return { ok: true, error: "", content: text };
}

function deleteSessionArtifacts(workspaceRoot = process.cwd(), sessionId = "") {
  const dir = getArtifactsDir(workspaceRoot, sessionId);
  if (!fs.existsSync(dir)) return { ok: true, error: "" };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, error: "" };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to delete artifacts",
    };
  }
}

module.exports = {
  getArtifactsDir,
  createArtifactId,
  hashContent,
  getArtifactFilePath,
  buildArtifactRecord,
  saveArtifact,
  loadArtifact,
  readArtifactSlice,
  deleteSessionArtifacts,
};

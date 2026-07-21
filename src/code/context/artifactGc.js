"use strict";

const fs = require("fs");
const path = require("path");
const { getArtifactsDir, loadArtifact, saveArtifact } = require("./artifacts");

const DEFAULT_MAX_ARTIFACTS = 200;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024;
/** Minimum gap between automatic GC passes during session saves. */
const DEFAULT_GC_MIN_INTERVAL_MS = 2 * 60 * 1000;
const GC_STAMP_NAME = ".gc-stamp";

function listArtifactFiles(workspaceRoot = process.cwd(), sessionId = "") {
  const dir = getArtifactsDir(workspaceRoot, sessionId);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const filePath = path.join(dir, name);
        let stat = null;
        try {
          stat = fs.statSync(filePath);
        } catch {
          stat = null;
        }
        return {
          artifactId: name.replace(/\.json$/, ""),
          filePath,
          sizeBytes: stat ? stat.size : 0,
          mtimeMs: stat ? stat.mtimeMs : 0,
        };
      });
  } catch {
    return [];
  }
}

function markArtifactCold(workspaceRoot = process.cwd(), sessionId = "", artifactId = "") {
  const loaded = loadArtifact(workspaceRoot, sessionId, artifactId);
  if (!loaded.ok || !loaded.artifact) {
    return { ok: false, error: loaded.error || "artifact not found", artifact: null };
  }
  const artifact = { ...loaded.artifact };
  if (artifact.cold === true) {
    return { ok: true, error: "", artifact, alreadyCold: true };
  }
  const preview = String(artifact.summary || "").slice(0, 600);
  artifact.cold = true;
  artifact.coldAt = new Date().toISOString();
  artifact.raw = {
    ok: true,
    cold: true,
    preview,
    note: "raw content evicted; use transcript preview or re-run tool",
  };
  // Preserve existing index; avoid rebuild from cold stub
  const saved = saveArtifact(workspaceRoot, sessionId, {
    ...artifact,
    index: artifact.index || {},
  });
  return {
    ok: saved.ok,
    error: saved.error || "",
    artifact: saved.artifact,
    alreadyCold: false,
  };
}

function resolveGcOptions(options = {}, env = process.env) {
  const maxArtifacts = Number.isFinite(options.maxArtifacts)
    ? Math.max(1, Math.floor(options.maxArtifacts))
    : (Number.parseInt(String(env.UFOO_UCODE_ARTIFACT_MAX_COUNT || ""), 10) || DEFAULT_MAX_ARTIFACTS);
  const maxAgeMs = Number.isFinite(options.maxAgeMs)
    ? Math.max(1000, Math.floor(options.maxAgeMs))
    : (Number.parseInt(String(env.UFOO_UCODE_ARTIFACT_MAX_AGE_MS || ""), 10) || DEFAULT_MAX_AGE_MS);
  const maxSessionBytes = Number.isFinite(options.maxSessionBytes)
    ? Math.max(1024, Math.floor(options.maxSessionBytes))
    : (Number.parseInt(String(env.UFOO_UCODE_ARTIFACT_MAX_BYTES || ""), 10) || DEFAULT_MAX_SESSION_BYTES);
  const minIntervalMs = Number.isFinite(options.minIntervalMs)
    ? Math.max(0, Math.floor(options.minIntervalMs))
    : (Number.parseInt(String(env.UFOO_UCODE_ARTIFACT_GC_INTERVAL_MS || ""), 10) || DEFAULT_GC_MIN_INTERVAL_MS);
  return {
    maxArtifacts,
    maxAgeMs,
    maxSessionBytes,
    minIntervalMs,
    nowMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now(),
    dryRun: options.dryRun === true,
    force: options.force === true,
  };
}

function getGcStampPath(workspaceRoot = process.cwd(), sessionId = "") {
  return path.join(getArtifactsDir(workspaceRoot, sessionId), GC_STAMP_NAME);
}

function countArtifactJsonFiles(workspaceRoot = process.cwd(), sessionId = "") {
  const dir = getArtifactsDir(workspaceRoot, sessionId);
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function touchGcStamp(workspaceRoot = process.cwd(), sessionId = "", nowMs = Date.now()) {
  const stampPath = getGcStampPath(workspaceRoot, sessionId);
  try {
    fs.mkdirSync(path.dirname(stampPath), { recursive: true });
    fs.writeFileSync(stampPath, `${nowMs}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Throttled GC for session save / lifecycle hooks.
 * Skips when a recent `.gc-stamp` exists, unless force=true or artifact
 * count already exceeds maxArtifacts (cheap readdir pressure bypass).
 */
function maybeGcSessionArtifacts(workspaceRoot = process.cwd(), sessionId = "", options = {}) {
  const id = String(sessionId || "").trim();
  if (!id) {
    return {
      ok: false,
      error: "invalid session id",
      skipped: true,
      reason: "invalid_session",
      scanned: 0,
      actions: [],
    };
  }

  const opts = resolveGcOptions(options);
  const artifactsDir = getArtifactsDir(workspaceRoot, id);
  if (!fs.existsSync(artifactsDir)) {
    return {
      ok: true,
      error: "",
      skipped: true,
      reason: "no_artifacts_dir",
      scanned: 0,
      actions: [],
      dryRun: opts.dryRun,
    };
  }

  const stampPath = getGcStampPath(workspaceRoot, id);

  if (!opts.force && opts.minIntervalMs > 0) {
    let stampAgeOk = false;
    try {
      if (fs.existsSync(stampPath)) {
        const st = fs.statSync(stampPath);
        stampAgeOk = opts.nowMs - st.mtimeMs < opts.minIntervalMs;
      }
    } catch {
      stampAgeOk = false;
    }
    if (stampAgeOk) {
      const count = countArtifactJsonFiles(workspaceRoot, id);
      if (count <= opts.maxArtifacts) {
        return {
          ok: true,
          error: "",
          skipped: true,
          reason: "throttled",
          scanned: count,
          actions: [],
          dryRun: opts.dryRun,
        };
      }
    }
  }

  const result = gcSessionArtifacts(workspaceRoot, id, options);
  if (!opts.dryRun) touchGcStamp(workspaceRoot, id, opts.nowMs);
  return {
    ...result,
    skipped: false,
    reason: opts.force ? "forced" : "interval",
  };
}

function gcSessionArtifacts(workspaceRoot = process.cwd(), sessionId = "", options = {}) {
  const opts = resolveGcOptions(options);
  const files = listArtifactFiles(workspaceRoot, sessionId)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  const planned = [];
  const deletedIds = new Set();

  for (const item of files) {
    if (opts.nowMs - item.mtimeMs > opts.maxAgeMs) {
      planned.push({ action: "cold", artifactId: item.artifactId, reason: "age" });
    }
  }

  let live = files.slice();
  let totalBytes = live.reduce((sum, item) => sum + item.sizeBytes, 0);
  while (live.length > opts.maxArtifacts || totalBytes > opts.maxSessionBytes) {
    const oldest = live.shift();
    if (!oldest) break;
    if (deletedIds.has(oldest.artifactId)) continue;
    planned.push({
      action: "delete",
      artifactId: oldest.artifactId,
      reason: totalBytes > opts.maxSessionBytes ? "size" : "count",
    });
    deletedIds.add(oldest.artifactId);
    totalBytes -= oldest.sizeBytes;
  }

  // Prefer delete over cold for the same id
  const byId = new Map();
  for (const entry of planned) {
    const prev = byId.get(entry.artifactId);
    if (!prev || entry.action === "delete") byId.set(entry.artifactId, entry);
  }
  const actions = Array.from(byId.values());

  const applied = [];
  if (!opts.dryRun) {
    for (const entry of actions) {
      if (entry.action === "cold") {
        const result = markArtifactCold(workspaceRoot, sessionId, entry.artifactId);
        applied.push({ ...entry, ok: result.ok, error: result.error || "" });
      } else if (entry.action === "delete") {
        const filePath = path.join(getArtifactsDir(workspaceRoot, sessionId), `${entry.artifactId}.json`);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          applied.push({ ...entry, ok: true, error: "" });
        } catch (err) {
          applied.push({
            ...entry,
            ok: false,
            error: err && err.message ? err.message : "delete failed",
          });
        }
      }
    }
  }

  return {
    ok: true,
    error: "",
    scanned: files.length,
    actions: opts.dryRun ? actions : applied,
    dryRun: opts.dryRun,
  };
}

function deleteSessionCommitLog(workspaceRoot = process.cwd(), sessionId = "") {
  const id = String(sessionId || "").trim();
  if (!id) return { ok: false, error: "invalid session id" };
  const filePath = path.join(
    path.resolve(workspaceRoot || process.cwd()),
    ".ufoo",
    "agent",
    "ucode",
    "commits",
    `${id}.jsonl`,
  );
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true, error: "", filePath };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to delete commit log",
      filePath,
    };
  }
}

module.exports = {
  DEFAULT_MAX_ARTIFACTS,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_SESSION_BYTES,
  DEFAULT_GC_MIN_INTERVAL_MS,
  listArtifactFiles,
  markArtifactCold,
  gcSessionArtifacts,
  maybeGcSessionArtifacts,
  deleteSessionCommitLog,
  resolveGcOptions,
  getGcStampPath,
  countArtifactJsonFiles,
};

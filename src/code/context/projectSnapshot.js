"use strict";

const fs = require("fs");
const path = require("path");
const { runToolCall } = require("../dispatch");
const { saveArtifact, createArtifactId, hashContent } = require("./artifacts");

const PREFLIGHT_FILES = [
  "AGENTS.md",
  "README.md",
  "README.zh-CN.md",
  "package.json",
];

function readFileIfExists(workspaceRoot = process.cwd(), relPath = "") {
  const full = path.resolve(workspaceRoot, relPath);
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    const content = fs.readFileSync(full, "utf8");
    return { path: relPath, content, hash: hashContent(content) };
  } catch {
    return null;
  }
}

function summarizePackageJson(content = "") {
  try {
    const parsed = JSON.parse(content);
    return {
      name: parsed.name || "",
      packageManager: parsed.packageManager || "",
      scripts: Object.keys(parsed.scripts || {}).slice(0, 8),
    };
  } catch {
    return {};
  }
}

function summarizeAgentsRules(content = "") {
  const lines = String(content || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 12);
}

function summarizeReadme(content = "") {
  const lines = String(content || "").split(/\r?\n/);
  const headings = lines
    .filter((l) => /^#{1,3}\s+/.test(l))
    .slice(0, 10);
  const intro = lines.filter((l) => l.trim() && !l.startsWith("#")).slice(0, 3).join(" ");
  return { headings, intro: intro.slice(0, 240) };
}

function collectCurrentFileHashes(workspaceRoot = process.cwd()) {
  const root = path.resolve(workspaceRoot || process.cwd());
  return PREFLIGHT_FILES.map((relPath) => {
    const file = readFileIfExists(root, relPath);
    return file ? { path: relPath, hash: file.hash } : null;
  }).filter(Boolean);
}

function isProjectSnapshotStale(snapshot = null, workspaceRoot = process.cwd()) {
  if (!snapshot || !snapshot.projectSnapshotId || !Array.isArray(snapshot.files)) return true;
  const current = collectCurrentFileHashes(workspaceRoot);
  if (current.length !== snapshot.files.length) return true;
  const byPath = new Map(snapshot.files.map((entry) => [entry.path, entry.hash]));
  for (const entry of current) {
    if (byPath.get(entry.path) !== entry.hash) return true;
  }
  return false;
}

function invalidateProjectSnapshotIfPathTouched(session = {}, filePath = "") {
  if (!session || typeof session !== "object") return false;
  const rel = String(filePath || "").trim().replace(/\\/g, "/");
  if (!rel) return false;
  const touched = PREFLIGHT_FILES.some((name) => (
    rel === name || rel.endsWith(`/${name}`)
  ));
  if (!touched) return false;
  session.projectSnapshot = null;
  return true;
}

function buildProjectSnapshot({
  workspaceRoot = process.cwd(),
  sessionId = "",
  existing = null,
} = {}) {
  const root = path.resolve(workspaceRoot || process.cwd());
  if (existing && !isProjectSnapshotStale(existing, root)) {
    return existing;
  }
  const files = [];
  const summary = {
    language: "",
    packageManager: "",
    entryPoints: [],
    rules: [],
    readmeHeadings: [],
    readmeIntro: "",
  };

  for (const relPath of PREFLIGHT_FILES) {
    const file = readFileIfExists(root, relPath);
    if (!file) continue;
    const artifactId = createArtifactId(`artifact_${relPath.replace(/[^a-zA-Z0-9]+/g, "_")}`);
    saveArtifact(root, sessionId, {
      artifactId,
      type: "source_file",
      source: relPath,
      tool: "read",
      raw: { ok: true, path: relPath, content: file.content },
      summary: relPath,
      createdBy: "project_snapshot",
    });
    files.push({
      path: relPath,
      artifactId,
      hash: file.hash,
    });
    if (relPath === "package.json") {
      const pkg = summarizePackageJson(file.content);
      summary.packageManager = pkg.packageManager || "";
      summary.language = "Node.js";
      summary.entryPoints = pkg.scripts || [];
    }
    if (relPath === "AGENTS.md") {
      summary.rules = summarizeAgentsRules(file.content);
    }
    if (relPath.startsWith("README")) {
      const readme = summarizeReadme(file.content);
      summary.readmeHeadings = readme.headings;
      summary.readmeIntro = readme.intro;
    }
  }

  const snapshotId = `project_snapshot_${hashContent(JSON.stringify(files))}`;

  return {
    projectSnapshotId: snapshotId,
    files,
    summary,
    createdAt: new Date().toISOString(),
  };
}

function renderProjectSnapshotContext(snapshot = null) {
  if (!snapshot || !snapshot.projectSnapshotId) return "";
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : {};
  const fileRefs = (Array.isArray(snapshot.files) ? snapshot.files : [])
    .map((f) => `- ${f.path}: artifact://${f.artifactId} (hash ${f.hash})`)
    .join("\n");
  const lines = [
    "Project Snapshot:",
    summary.language ? `- Language: ${summary.language}` : "",
    summary.packageManager ? `- Package manager: ${summary.packageManager}` : "",
    summary.rules && summary.rules.length > 0
      ? `- Repository rules: ${summary.rules.slice(0, 5).join("; ")}`
      : "",
    summary.readmeIntro ? `- README intro: ${summary.readmeIntro}` : "",
    fileRefs ? `Files:\n${fileRefs}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function createProjectPreflightContextV2({
  workspaceRoot = process.cwd(),
  sessionId = "",
  pushToolLog = () => null,
  existingSnapshot = null,
} = {}) {
  const root = String(workspaceRoot || process.cwd());
  for (const relPath of PREFLIGHT_FILES) {
    pushToolLog({ tool: "read", phase: "start", args: { path: relPath }, error: "" });
    const readRes = runToolCall(
      { tool: "read", args: { path: relPath, maxBytes: 12000 } },
      { workspaceRoot: root, cwd: root },
    );
    pushToolLog({
      tool: "read",
      phase: readRes && readRes.ok === false ? "error" : "",
      args: { path: relPath },
      error: readRes && readRes.ok === false ? String(readRes.error || "") : "",
    });
  }
  return buildProjectSnapshot({
    workspaceRoot: root,
    sessionId,
    existing: existingSnapshot,
  });
}

module.exports = {
  PREFLIGHT_FILES,
  buildProjectSnapshot,
  renderProjectSnapshotContext,
  createProjectPreflightContextV2,
  isProjectSnapshotStale,
  invalidateProjectSnapshotIfPathTouched,
  collectCurrentFileHashes,
};

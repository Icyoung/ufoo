"use strict";

/**
 * Workspace inspection & context management helpers for the Desktop Right Inspector:
 * - Changes: Git status, worktrees, unified/split-ready diffs, and worker reports
 * - Docs: Safe workspace document/file listing and line-ranged reading
 * - Context: Decisions (.ufoo/context/decisions/) & Shared Memory (.ufoo/memory/)
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const matter = require("gray-matter");
const { resolveWorkspacePath, isPathInside } = require("../code/tools/common");
const { redactSecrets } = require("../runtime/privacy/redactor");
const { canonicalProjectRoot } = require("../runtime/projects/projectId");
const { listReports, readReportSummary } = require("../coordination/report/store");
const DecisionsManager = require("../coordination/context/decisions");
const { MemoryManager } = require("../coordination/memory");

const IGNORED_DIRS = new Set([
  ".git",
  ".ufoo",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  "coverage",
  "__pycache__",
  ".venv",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns",
  ".pdf", ".zip", ".tar", ".gz", ".dmg", ".pkg",
  ".woff", ".woff2", ".ttf", ".otf",
  ".node", ".dylib", ".so", ".dll", ".exe", ".o", ".a",
]);

const PINNED_DOC_NAMES = [
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  "CLAUDE.md",
  "docs/PROJECT.md",
  "docs/README.md",
  "docs/OBSERVABILITY.md",
];

function safeCanonicalRoot(projectRoot) {
  const raw = String(projectRoot || "").trim();
  if (!raw) throw new Error("projectRoot is required");
  try {
    return canonicalProjectRoot(raw);
  } catch {
    return path.resolve(raw);
  }
}

function runGit(cwd, args, maxBuffer = 2 * 1024 * 1024) {
  try {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer,
    });
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: String(res.stdout || ""),
      stderr: String(res.stderr || ""),
    };
  } catch (err) {
    return {
      ok: false,
      status: -1,
      stdout: "",
      stderr: err && err.message ? err.message : String(err),
    };
  }
}

function listGitWorktrees(projectRoot) {
  const root = safeCanonicalRoot(projectRoot);
  const res = runGit(root, ["worktree", "list", "--porcelain"]);
  if (!res.ok || !res.stdout.trim()) {
    return [{
      path: root,
      branch: detectGitBranch(root),
      head: "",
      isMain: true,
    }];
  }

  const worktrees = [];
  let current = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current && current.path) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current && current.path) worktrees.push(current);
      const wtPath = safeCanonicalRoot(line.slice(9).trim());
      current = {
        path: wtPath,
        head: "",
        branch: "",
        detached: false,
        isMain: wtPath === root,
      };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice(5).trim().slice(0, 8);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    }
  }
  if (current && current.path) worktrees.push(current);
  return worktrees.length > 0
    ? worktrees
    : [{ path: root, branch: detectGitBranch(root), head: "", isMain: true }];
}

function detectGitBranch(cwd) {
  const res = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!res.ok) return "";
  return res.stdout.trim();
}

function parsePorcelainStatus(stdout = "", numstatMap = new Map()) {
  const files = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const indexStatus = rawLine[0];
    const workTreeStatus = rawLine[1];
    let filePath = rawLine.slice(3).trim();
    let origPath = "";
    if (filePath.includes(" -> ")) {
      const parts = filePath.split(" -> ");
      origPath = parts[0].replace(/^"|"$/g, "");
      filePath = parts[1].replace(/^"|"$/g, "");
    } else {
      filePath = filePath.replace(/^"|"$/g, "");
    }
    if (!filePath) continue;

    let kind = "modified";
    if (indexStatus === "?" && workTreeStatus === "?") kind = "untracked";
    else if (indexStatus === "A" || workTreeStatus === "A") kind = "added";
    else if (indexStatus === "D" || workTreeStatus === "D") kind = "deleted";
    else if (indexStatus === "R" || workTreeStatus === "R") kind = "renamed";
    else if (indexStatus === "U" || workTreeStatus === "U") kind = "conflicted";

    const stats = numstatMap.get(filePath) || { additions: 0, deletions: 0 };
    files.push({
      path: filePath,
      origPath,
      kind,
      code: `${indexStatus}${workTreeStatus}`.trim() || "M",
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: workTreeStatus !== " ",
      additions: stats.additions,
      deletions: stats.deletions,
    });
  }
  return files;
}

function loadNumstatMap(cwd) {
  const map = new Map();
  for (const extra of [[], ["--cached"]]) {
    const res = runGit(cwd, ["diff", "--numstat", ...extra]);
    if (!res.ok) continue;
    for (const line of res.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [addRaw, delRaw, rawPath] = line.split("\t");
      if (!rawPath) continue;
      const cleanPath = rawPath.includes(" => ")
        ? rawPath.replace(/\{([^}]*?)\s*=>\s*([^}]*?)\}/g, "$2").split(" => ").pop().trim()
        : rawPath.trim();
      const prev = map.get(cleanPath) || { additions: 0, deletions: 0 };
      const add = Number.parseInt(addRaw, 10);
      const del = Number.parseInt(delRaw, 10);
      map.set(cleanPath, {
        additions: prev.additions + (Number.isFinite(add) ? add : 0),
        deletions: prev.deletions + (Number.isFinite(del) ? del : 0),
      });
    }
  }
  return map;
}

function buildUntrackedPseudoDiff(targetRoot, relPath, maxBytes = 128 * 1024) {
  try {
    const { resolved } = resolveWorkspacePath(targetRoot, relPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return "";
    const ext = path.extname(resolved).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return `Binary file ${relPath} (untracked)`;
    const stat = fs.statSync(resolved);
    const fd = fs.openSync(resolved, "r");
    try {
      const len = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      if (buf.includes(0)) return `Binary file ${relPath} (untracked)`;
      const lines = redactSecrets(buf.toString("utf8")).replace(/\r\n/g, "\n").split("\n");
      const header = [
        `diff --git a/${relPath} b/${relPath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${relPath}`,
        `@@ -0,0 +1,${lines.length} @@`,
      ];
      const body = lines.map((line) => `+${line}`);
      if (stat.size > maxBytes) body.push("\\ Truncated large untracked file");
      return [...header, ...body].join("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function readFileDiff(targetRoot, relPath, fileEntry = null) {
  const clean = String(relPath || "").trim();
  if (!clean) return "";
  resolveWorkspacePath(targetRoot, clean);
  if (fileEntry && fileEntry.kind === "untracked") {
    return buildUntrackedPseudoDiff(targetRoot, clean);
  }
  const headCheck = runGit(targetRoot, ["rev-parse", "--verify", "HEAD"]);
  const args = headCheck.ok
    ? ["diff", "HEAD", "--", clean]
    : ["diff", "--cached", "--", clean];
  let diffRes = runGit(targetRoot, args);
  let patch = diffRes.stdout || "";
  if (!patch.trim()) {
    diffRes = runGit(targetRoot, ["diff", "--", clean]);
    patch = diffRes.stdout || "";
  }
  if (!patch.trim()) {
    patch = buildUntrackedPseudoDiff(targetRoot, clean);
  }
  return redactSecrets(patch.slice(0, 256 * 1024));
}

function loadWorkspaceChanges(projectRoot, options = {}) {
  const root = safeCanonicalRoot(projectRoot);
  const worktrees = listGitWorktrees(root);
  const requestedWt = options.worktreeRoot ? safeCanonicalRoot(options.worktreeRoot) : root;
  const validWt = worktrees.some((wt) => wt.path === requestedWt) ? requestedWt : root;
  const branch = detectGitBranch(validWt);
  const statusRes = runGit(validWt, ["status", "--porcelain=v1", "-uall"]);
  const isGitRepo = statusRes.ok;
  const numstatMap = isGitRepo ? loadNumstatMap(validWt) : new Map();
  const files = isGitRepo ? parsePorcelainStatus(statusRes.stdout, numstatMap) : [];

  for (const item of files) {
    if (item.kind === "untracked" && item.additions === 0) {
      try {
        const { resolved } = resolveWorkspacePath(validWt, item.path);
        const stat = fs.statSync(resolved);
        if (stat.isFile() && stat.size <= 128 * 1024 && !BINARY_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
          item.additions = fs.readFileSync(resolved, "utf8").split(/\r?\n/).length;
        }
      } catch {
        // ignore stat failures
      }
    }
  }

  const selectedFile = String(options.filePath || (files[0] && files[0].path) || "").trim();
  const selectedEntry = files.find((f) => f.path === selectedFile) || null;
  const diff = isGitRepo && selectedFile ? readFileDiff(validWt, selectedFile, selectedEntry) : "";

  const reports = listReports(root, {
    num: Number(options.reportLimit) || 25,
    agent: options.agentId || "",
  });
  const reportSummary = readReportSummary(root);

  const totals = files.reduce(
    (acc, item) => ({
      additions: acc.additions + (item.additions || 0),
      deletions: acc.deletions + (item.deletions || 0),
    }),
    { additions: 0, deletions: 0 }
  );

  return {
    projectRoot: root,
    worktreeRoot: validWt,
    isGitRepo,
    branch,
    worktrees,
    files,
    totals,
    selectedFile,
    diff,
    reports,
    reportSummary,
  };
}

function inferLanguage(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".js": "javascript",
    ".cjs": "javascript",
    ".mjs": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".rs": "rust",
    ".md": "markdown",
    ".json": "json",
    ".toml": "toml",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".css": "css",
    ".html": "html",
    ".sh": "bash",
    ".swift": "swift",
    ".py": "python",
  };
  return map[ext] || "plaintext";
}

function collectWorkspaceFiles(root, { maxFiles = 350, maxDepth = 4, query = "" } = {}) {
  const results = [];
  const needle = String(query || "").trim().toLowerCase();

  function walk(currentDir, depth) {
    if (results.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") {
        if (entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(path.join(currentDir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) continue;
        const rel = path.relative(root, path.join(currentDir, entry.name)).split(path.sep).join("/");
        if (needle && !rel.toLowerCase().includes(needle)) continue;
        results.push({
          path: rel,
          name: entry.name,
          isMarkdown: ext === ".md",
          pinned: PINNED_DOC_NAMES.includes(rel),
        });
      }
    }
  }

  walk(root, 0);
  results.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.isMarkdown !== b.isMarkdown) return a.isMarkdown ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return results;
}

function normalizeRequestedDocPath(root, requested = "", altRoot = "") {
  let clean = String(requested || "").trim();
  if (!clean) return "";
  clean = clean.replace(/^file:\/\//i, "");
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // keep original if not valid URI encoding
  }
  let lineAnchor = 0;
  const hashMatch = clean.match(/#L(\d+)(?:-L?\d+)?$/i);
  if (hashMatch) {
    lineAnchor = Number.parseInt(hashMatch[1], 10) || 0;
    clean = clean.slice(0, hashMatch.index);
  }
  const colonMatch = clean.match(/:(\d+)(?::\d+)?$/);
  if (colonMatch && !fs.existsSync(path.resolve(root, clean))) {
    lineAnchor = lineAnchor || Number.parseInt(colonMatch[1], 10) || 0;
    clean = clean.slice(0, colonMatch.index);
  }
  let resolvedRoot = root;
  if (path.isAbsolute(clean)) {
    const candidate = safeCanonicalRoot(path.dirname(clean));
    const full = path.join(candidate, path.basename(clean));
    if (isPathInside(root, full)) {
      clean = path.relative(root, full).split(path.sep).join("/");
      resolvedRoot = root;
    } else if (altRoot && isPathInside(altRoot, full)) {
      clean = path.relative(altRoot, full).split(path.sep).join("/");
      resolvedRoot = altRoot;
    }
  } else if (altRoot && altRoot !== root) {
    const inPrimary = path.resolve(root, clean);
    const inAlt = path.resolve(altRoot, clean);
    if (!fs.existsSync(inPrimary) && fs.existsSync(inAlt)) {
      resolvedRoot = altRoot;
    }
  }
  return { path: clean, anchorLine: lineAnchor, root: resolvedRoot };
}

function loadWorkspaceDocs(projectRoot, options = {}) {
  const root = safeCanonicalRoot(projectRoot);
  const targetRoot = options.worktreeRoot && isPathInside(root, path.resolve(options.worktreeRoot))
    ? safeCanonicalRoot(options.worktreeRoot)
    : root;
  const files = collectWorkspaceFiles(targetRoot, {
    query: options.query || "",
    maxFiles: Number(options.maxFiles) || 350,
  });

  const parsedTarget = options.filePath
    ? normalizeRequestedDocPath(targetRoot, options.filePath, root)
    : null;
  const defaultFile = (files.find((f) => f.pinned) || files[0] || {}).path || "";
  const selectedPath = (parsedTarget && parsedTarget.path) || defaultFile;
  const anchorLine = (parsedTarget && parsedTarget.anchorLine) || Number(options.anchorLine) || 0;
  const docRoot = (parsedTarget && parsedTarget.root) || targetRoot;

  let document = null;
  if (selectedPath) {
    try {
      const { resolved } = resolveWorkspacePath(docRoot, selectedPath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const stat = fs.statSync(resolved);
        const maxBytes = 256 * 1024;
        const fd = fs.openSync(resolved, "r");
        try {
          const len = Math.min(stat.size, maxBytes);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, 0);
          const rawText = redactSecrets(buf.toString("utf8")).replace(/\r\n/g, "\n");
          const allLines = rawText.split("\n");
          const startLine = Math.max(1, Number(options.startLine) || 1);
          const endLine = Math.min(allLines.length, Number(options.endLine) || allLines.length);
          document = {
            path: path.relative(docRoot, resolved).split(path.sep).join("/"),
            absolutePath: resolved,
            language: inferLanguage(resolved),
            content: allLines.slice(startLine - 1, endLine).join("\n"),
            totalLines: allLines.length,
            startLine,
            endLine,
            anchorLine,
            truncated: stat.size > maxBytes,
            sizeBytes: stat.size,
          };
        } finally {
          fs.closeSync(fd);
        }
      } else {
        document = {
          path: selectedPath,
          error: `File not found: ${selectedPath}`,
        };
      }
    } catch (err) {
      document = {
        path: selectedPath,
        error: err && err.message ? err.message : String(err),
      };
    }
  }

  return {
    projectRoot: root,
    files,
    selectedPath: document ? document.path : selectedPath,
    document,
  };
}

function writeDecisionsIndexQuiet(manager) {
  const decisions = manager.readDecisions();
  const entries = manager.buildIndexEntries(decisions);
  fs.mkdirSync(manager.contextDir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e));
  const output = lines.length ? `${lines.join("\n")}\n` : "";
  fs.writeFileSync(manager.indexFile, output, "utf8");
}

function createStructuredDecision(projectRoot, input = {}) {
  const root = safeCanonicalRoot(projectRoot);
  const manager = new DecisionsManager(root);
  const title = String(input.title || "").trim();
  if (!title) throw new Error("Decision title is required");

  const author = String(input.author || process.env.UFOO_NICKNAME || process.env.USER || "user").trim();
  const nickname = String(input.nickname || author).trim();
  const status = String(input.status || "open").trim() || "open";
  const num = manager.nextNumber();
  const slug = manager.slugify(title);
  const nick = manager.slugify(nickname);
  const date = new Date().toISOString().slice(0, 10);

  fs.mkdirSync(manager.contextDir, { recursive: true });
  fs.mkdirSync(manager.decisionsDir, { recursive: true });

  const file = `${num}-${nick}-${slug}.md`;
  const filePath = path.join(manager.decisionsDir, file);
  const contextText = String(input.context || "Recorded from Ufoo Desktop.").trim();
  const decisionText = String(input.decision || title).trim();
  const implicationsText = String(input.implications || "Keep related runtime and documentation aligned.").trim();

  const markdown = matter.stringify(
    `# DECISION ${num}: ${title}\n\n`
      + `Date: ${date}\n`
      + `Author: ${author}\n`
      + `Nickname: ${nickname}\n\n`
      + `Context:\n${contextText}\n\n`
      + `Decision:\n${decisionText}\n\n`
      + `Implications:\n${implicationsText}\n`,
    {
      status,
      nickname,
      created_at: new Date().toISOString(),
    }
  );
  fs.writeFileSync(filePath, redactSecrets(markdown), "utf8");
  writeDecisionsIndexQuiet(manager);
  return { file, filePath };
}

function updateDecisionStatus(projectRoot, input = {}) {
  const root = safeCanonicalRoot(projectRoot);
  const manager = new DecisionsManager(root);
  return manager.setStatus(input.file, input.status, {
    actor: input.actor || process.env.USER || "user",
    reason: input.reason || "",
  });
}

function buildDecisionTidyPrompt(projectRoot) {
  const root = safeCanonicalRoot(projectRoot);
  const manager = new DecisionsManager(root);
  const openDecisions = manager.readDecisions().filter(
    (item) => String(item.status || "open").trim().toLowerCase() === "open"
  );
  if (openDecisions.length === 0) {
    return { openCount: 0, files: [], prompt: "" };
  }

  const listLines = openDecisions
    .map((item, idx) => `${idx + 1}. \`${item.file}\` — ${item.title}`)
    .join("\n");

  const prompt = [
    `请帮我一键整理当前项目的未关闭 Decisions（共 ${openDecisions.length} 条）：`,
    listLines,
    "",
    "请严格按以下两阶段执行：",
    "1. **逐条分析与归档决策**：阅读每条未关闭 decision 文件内容，并结合当前仓库现状判断：",
    "   - 如果仍属于未解决或持续需要关注的活跃决策，保持 `open`；",
    "   - 如果是临时决策、已经实现/解决、已过时或不再有持续跟踪价值，直接调用 `update_decision` 工具将其状态更新为 `archived`（并填写简短 `reason`）。",
    "2. **长期价值提取与 Memory 确认**：完成所有未关闭 decision 的状态处理后，先用 `search_memory` / `recall` 检查已有项目 Memory 避免重复，再提炼值得长期沉淀的架构原则、约定或项目约束：",
    "   - 如果有值得存入 Memory 的候选内容，请先不要直接写入，先给出本次整理结果摘要（保留 open / 已归档清单）和建议存入 Memory 的候选条目（标题、摘要、tags），然后调用 `ask_user` 在对话框中向我确认是否存入 Memory（如提供「全部存入 Memory」「暂不存入」等选项）；待我确认后再调用 `remember` 工具写入。",
    "   - 如果没有值得存入 Memory 的内容，直接输出本次整理摘要即可。",
  ].join("\n");

  return {
    openCount: openDecisions.length,
    files: openDecisions.map((item) => item.file),
    prompt,
  };
}

function handleWorkspaceContext(projectRoot, payload = {}) {
  const root = safeCanonicalRoot(projectRoot);
  const operation = String(payload.operation || "snapshot").trim();
  const decisionsManager = new DecisionsManager(root);
  const memoryManager = new MemoryManager(root, { ensure: operation.startsWith("memory.") });
  let metaResult = null;

  if (operation === "decision.create") {
    metaResult = createStructuredDecision(root, payload);
  } else if (operation === "decision.set_status") {
    metaResult = updateDecisionStatus(root, payload);
  } else if (operation === "decision.delete") {
    metaResult = decisionsManager.deleteDecision(payload.file);
  } else if (operation === "decision.clear") {
    metaResult = decisionsManager.clearDecisions({ status: payload.scope || payload.status || "all" });
  } else if (operation === "memory.add") {
    memoryManager.add({
      title: payload.title,
      body: payload.body,
      tags: payload.tags || [],
      source: "user:desktop",
    }, { actor: "user:desktop", source: "desktop" });
  } else if (operation === "memory.update") {
    memoryManager.update(payload.id, {
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.body !== undefined ? { body: payload.body } : {}),
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
    }, { actor: "user:desktop", source: "desktop" });
  } else if (operation === "memory.archive") {
    memoryManager.archive(payload.id, { actor: "user:desktop", source: "desktop" });
  } else if (operation !== "snapshot") {
    throw new Error(`Unsupported workspace.context operation: ${operation}`);
  }

  const decisions = decisionsManager.readDecisions().map((item) => ({
    file: item.file,
    status: item.status || "open",
    title: item.title,
    author: item.data?.author || decisionsManager.extractField(item.body, "Author") || item.data?.nickname || "",
    date: item.data?.created_at || decisionsManager.extractField(item.body, "Date") || "",
    resolution_note: item.data?.resolution_note || "",
    body: redactSecrets(item.body || ""),
  }));

  const query = String(payload.query || "").trim();
  const memories = query
    ? memoryManager.search(query, { limit: 50, includeArchived: Boolean(payload.includeArchived) })
    : memoryManager.list({ limit: 100, includeArchived: Boolean(payload.includeArchived) });

  return {
    projectRoot: root,
    decisions,
    openDecisionCount: decisions.filter((d) => d.status === "open").length,
    archivedDecisionCount: decisions.filter((d) => d.status === "archived").length,
    resolvedDecisionCount: decisions.filter((d) => d.status === "resolved" || d.status === "superseded").length,
    ...(metaResult ? { actionResult: metaResult } : {}),
    memories: memories.map((m) => ({
      id: m.id,
      title: m.title,
      body: redactSecrets(m.body || ""),
      tags: m.tags || [],
      status: m.status || "active",
      updated_at: m.updated_at || "",
      created_at: m.created_at || "",
    })),
  };
}

function resolveWorktreeTarget(projectRoot, worktreeRoot = "") {
  const root = safeCanonicalRoot(projectRoot);
  const requested = String(worktreeRoot || "").trim();
  if (!requested) return root;
  const candidate = safeCanonicalRoot(requested);
  if (candidate === root) return root;
  const known = listGitWorktrees(root);
  if (known.some((wt) => safeCanonicalRoot(wt.path) === candidate) && fs.existsSync(candidate)) {
    return candidate;
  }
  throw new Error(`Worktree no longer exists or is not registered: ${requested}`);
}

function resolveWorktreeTargetSafe(projectRoot, worktreeRoot = "") {
  try {
    return { ok: true, cwd: resolveWorktreeTarget(projectRoot, worktreeRoot) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function assertSafeRepoRelativeFile(targetRoot, filePath = "") {
  const rel = String(filePath || "").trim();
  if (!rel) throw new Error("filePath is required");
  const resolved = resolveWorkspacePath(targetRoot, rel);
  const abs = typeof resolved === "string" ? resolved : String(resolved.resolved || resolved.abs || "");
  const normalizedRel = typeof resolved === "object" && resolved.relative
    ? String(resolved.relative).replace(/\\/g, "/")
    : path.relative(targetRoot, abs).replace(/\\/g, "/");
  return { rel: normalizedRel, abs };
}

function gitStage(projectRoot, { worktreeRoot = "", filePath = "", all = false } = {}) {
  const target = resolveWorktreeTargetSafe(projectRoot, worktreeRoot);
  if (!target.ok) return target;
  const cwd = target.cwd;
  if (all || !filePath) {
    const res = runGit(cwd, ["add", "-A"]);
    return res.ok ? { ok: true } : { ok: false, error: res.stderr || "git add -A failed" };
  }
  const { rel } = assertSafeRepoRelativeFile(cwd, filePath);
  const res = runGit(cwd, ["add", "--", rel]);
  return res.ok ? { ok: true, filePath: rel } : { ok: false, error: res.stderr || "git add failed" };
}

function gitUnstage(projectRoot, { worktreeRoot = "", filePath = "", all = false } = {}) {
  const target = resolveWorktreeTargetSafe(projectRoot, worktreeRoot);
  if (!target.ok) return target;
  const cwd = target.cwd;
  if (all || !filePath) {
    const res = runGit(cwd, ["reset", "HEAD"]);
    return res.ok ? { ok: true } : { ok: false, error: res.stderr || "git reset HEAD failed" };
  }
  const { rel } = assertSafeRepoRelativeFile(cwd, filePath);
  const res = runGit(cwd, ["reset", "HEAD", "--", rel]);
  return res.ok ? { ok: true, filePath: rel } : { ok: false, error: res.stderr || "git reset failed" };
}

function gitDiscard(projectRoot, { worktreeRoot = "", filePath = "", kind = "" } = {}) {
  const target = resolveWorktreeTargetSafe(projectRoot, worktreeRoot);
  if (!target.ok) return target;
  const cwd = target.cwd;
  const { rel, abs } = assertSafeRepoRelativeFile(cwd, filePath);
  if (kind === "untracked") {
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      return { ok: true, filePath: rel, removed: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }
  runGit(cwd, ["reset", "HEAD", "--", rel]);
  const res = runGit(cwd, ["checkout", "--", rel]);
  if (!res.ok) {
    // Untracked fallback when caller omitted kind
    const ls = runGit(cwd, ["ls-files", "--error-unmatch", "--", rel]);
    if (!ls.ok && fs.existsSync(abs)) {
      fs.rmSync(abs, { recursive: true, force: true });
      return { ok: true, filePath: rel, removed: true };
    }
    return { ok: false, error: res.stderr || "git checkout failed" };
  }
  return { ok: true, filePath: rel };
}

function gitSuggestCommitMessage(projectRoot, { worktreeRoot = "" } = {}) {
  const target = resolveWorktreeTargetSafe(projectRoot, worktreeRoot);
  if (!target.ok) return target;
  const cwd = target.cwd;
  const status = runGit(cwd, ["status", "--porcelain"]);
  if (!status.ok || !status.stdout.trim()) {
    return { ok: true, message: "" };
  }
  const files = status.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim().split(" -> ").pop());
  if (files.length === 0) return { ok: true, message: "" };
  const topDir = files[0].includes("/") ? files[0].split("/")[0] : "";
  const allDocs = files.every((f) => f.endsWith(".md") || f.startsWith("docs/"));
  const allTests = files.every((f) => f.includes("test"));
  const prefix = allDocs ? "docs" : (allTests ? "test" : "chore");
  const scope = topDir && !["src", "apps", "crates"].includes(topDir) ? `(${topDir})` : "";
  const summary = files.length === 1
    ? `update ${path.basename(files[0])}`
    : `update ${files.length} files (${files.slice(0, 2).map((f) => path.basename(f)).join(", ")}${files.length > 2 ? ", …" : ""})`;
  return { ok: true, message: `${prefix}${scope}: ${summary}` };
}

function gitCommit(projectRoot, { worktreeRoot = "", message = "", stageAll = false } = {}) {
  const target = resolveWorktreeTargetSafe(projectRoot, worktreeRoot);
  if (!target.ok) return target;
  const cwd = target.cwd;
  const msg = String(message || "").trim();
  if (!msg) return { ok: false, error: "Commit message is required" };
  if (stageAll) {
    const addRes = runGit(cwd, ["add", "-A"]);
    if (!addRes.ok) return { ok: false, error: addRes.stderr || "git add -A failed" };
  } else {
    const cached = runGit(cwd, ["diff", "--cached", "--name-only"]);
    if (!cached.stdout.trim()) {
      const addRes = runGit(cwd, ["add", "-A"]);
      if (!addRes.ok) return { ok: false, error: addRes.stderr || "git add -A failed" };
    }
  }
  const res = runGit(cwd, ["commit", "-m", msg]);
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "git commit failed" };
  const sha = runGit(cwd, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  return { ok: true, sha, output: res.stdout.trim() };
}

function gitPush(projectRoot, { worktreeRoot = "" } = {}) {
  const target = resolveWorktreeTargetSafe(projectRoot, worktreeRoot);
  if (!target.ok) return target;
  const cwd = target.cwd;
  const branch = detectGitBranch(cwd);
  if (!branch || branch === "HEAD") {
    return { ok: false, error: "Cannot push from detached HEAD" };
  }
  const res = runGit(cwd, ["push", "-u", "origin", branch], 30000);
  if (!res.ok) return { ok: false, error: res.stderr || res.stdout || "git push failed" };
  return { ok: true, branch, output: (res.stdout || res.stderr).trim() };
}

function gitCreatePr(projectRoot, { worktreeRoot = "", title = "", body = "", base = "" } = {}) {
  const target = resolveWorktreeTargetSafe(projectRoot, worktreeRoot);
  if (!target.ok) return target;
  const cwd = target.cwd;
  const branch = detectGitBranch(cwd);
  if (!branch || branch === "HEAD") {
    return { ok: false, error: "Cannot create PR from detached HEAD" };
  }
  const args = ["pr", "create"];
  if (title) args.push("--title", String(title));
  else args.push("--fill");
  if (body) args.push("--body", String(body));
  if (base) args.push("--base", String(base));
  try {
    const gh = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 30000 });
    if (gh.status === 0) {
      const out = String(gh.stdout || "").trim();
      const urlMatch = out.match(/https?:\/\/\S+/);
      return { ok: true, url: urlMatch ? urlMatch[0] : "", output: out };
    }
    if (gh.error && gh.error.code === "ENOENT") {
      // Fallback: build compare URL from origin remote
      const remote = runGit(cwd, ["remote", "get-url", "origin"]).stdout.trim();
      const ghMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
      const compareUrl = ghMatch ? `https://github.com/${ghMatch[1]}/compare/${encodeURIComponent(branch)}?expand=1` : "";
      return {
        ok: false,
        needsGhCli: true,
        compareUrl,
        error: compareUrl
          ? `GitHub CLI (gh) not installed. Open compare URL: ${compareUrl}`
          : "GitHub CLI (gh) is not installed",
      };
    }
    return { ok: false, error: String(gh.stderr || gh.stdout || "gh pr create failed").trim() };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  loadWorkspaceChanges,
  loadWorkspaceDocs,
  handleWorkspaceContext,
  buildDecisionTidyPrompt,
  listGitWorktrees,
  detectGitBranch,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitSuggestCommitMessage,
  gitCommit,
  gitPush,
  gitCreatePr,
};

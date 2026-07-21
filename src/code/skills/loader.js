const fs = require("fs");
const os = require("os");
const path = require("path");
const matter = require("gray-matter");

const SKILL_FILE = "SKILL.md";
const DEFAULT_MAX_DEPTH = 6;

function repoRootFromHere() {
  return path.resolve(__dirname, "..", "..", "..");
}

function canonicalPath(filePath = "") {
  const resolved = path.resolve(String(filePath || ""));
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isDirectory(filePath = "") {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath = "") {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function homeDir(env = process.env) {
  return String((env && env.HOME) || os.homedir() || "").trim();
}

function defaultSkillRoots({
  workspaceRoot = process.cwd(),
  env = process.env,
  repoRoot = repoRootFromHere(),
} = {}) {
  const workspace = path.resolve(String(workspaceRoot || process.cwd()));
  const home = homeDir(env);
  const codexHome = String((env && env.CODEX_HOME) || "").trim()
    || (home ? path.join(home, ".codex") : "");
  const roots = [
    { path: path.join(workspace, ".agents", "skills"), scope: "repo", source: "workspace-agents" },
    { path: path.join(workspace, ".codex", "skills"), scope: "repo", source: "workspace-codex" },
  ];

  if (home) {
    roots.push({ path: path.join(home, ".agents", "skills"), scope: "user", source: "user-agents" });
  }
  if (codexHome) {
    roots.push({ path: path.join(codexHome, "skills"), scope: "user", source: "user-codex" });
    roots.push({ path: path.join(codexHome, "skills", ".system"), scope: "system", source: "codex-system" });
  }

  const root = path.resolve(String(repoRoot || repoRootFromHere()));
  roots.push({ path: path.join(root, "SKILLS"), scope: "builtin", source: "ufoo" });

  const seen = new Set();
  return roots
    .map((rootInfo) => ({ ...rootInfo, path: path.resolve(rootInfo.path) }))
    .filter((rootInfo) => {
      if (seen.has(rootInfo.path)) return false;
      seen.add(rootInfo.path);
      return true;
    });
}

function parseSkillFile(filePath, rootInfo = {}) {
  const skillPath = canonicalPath(filePath);
  const dir = path.dirname(skillPath);
  let parsed;
  try {
    parsed = matter(fs.readFileSync(skillPath, "utf8"));
  } catch (err) {
    throw new Error(err && err.message ? err.message : "failed to read skill");
  }

  const data = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  const name = String(data.name || "").trim();
  const description = String(data.description || "").trim();
  if (!name) throw new Error("missing required frontmatter field: name");
  if (!description) throw new Error("missing required frontmatter field: description");

  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const shortDescription = String(
    metadata["short-description"]
      || metadata.shortDescription
      || data["short-description"]
      || data.shortDescription
      || ""
  ).trim();
  const workflowSummary = String(
    data.workflowSummary
      || data["workflow-summary"]
      || metadata.workflowSummary
      || metadata["workflow-summary"]
      || shortDescription
      || ""
  ).trim();
  const triggersRaw = data.triggers != null
    ? data.triggers
    : (data.trigger != null
      ? data.trigger
      : (metadata.triggers != null ? metadata.triggers : metadata.trigger));
  let triggers = [];
  if (Array.isArray(triggersRaw)) {
    triggers = triggersRaw.map((item) => String(item || "").trim()).filter(Boolean);
  } else if (typeof triggersRaw === "string" && triggersRaw.trim()) {
    triggers = triggersRaw.split(/[,|]/).map((item) => item.trim()).filter(Boolean);
  }

  return {
    name,
    description,
    shortDescription,
    workflowSummary,
    triggers,
    path: skillPath,
    dir,
    scope: rootInfo.scope || "repo",
    source: rootInfo.source || "",
    enabled: true,
  };
}

function discoverSkillsUnderRoot(rootInfo = {}, options = {}) {
  const root = path.resolve(String(rootInfo.path || ""));
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const skills = [];
  const errors = [];
  if (!root || !isDirectory(root)) return { skills, errors };

  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    const skillFile = path.join(dir, SKILL_FILE);
    if (isFile(skillFile)) {
      try {
        skills.push(parseSkillFile(skillFile, rootInfo));
      } catch (err) {
        errors.push({
          path: canonicalPath(skillFile),
          message: err && err.message ? err.message : "invalid skill",
        });
      }
      return;
    }

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({
        path: canonicalPath(dir),
        message: err && err.message ? err.message : "failed to read directory",
      });
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(root, 0);
  return { skills, errors };
}

function listUcodeSkills(options = {}) {
  const roots = Array.isArray(options.roots)
    ? options.roots
    : defaultSkillRoots(options);
  const seenPaths = new Set();
  const skills = [];
  const errors = [];

  for (const rootInfo of roots) {
    const discovered = discoverSkillsUnderRoot(rootInfo, options);
    for (const err of discovered.errors) errors.push(err);
    for (const skill of discovered.skills) {
      const key = canonicalPath(skill.path);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      skills.push(skill);
    }
  }

  const scopeRank = { repo: 0, user: 1, builtin: 2, system: 3, admin: 4 };
  skills.sort((a, b) => {
    const rankA = scopeRank[a.scope] == null ? 9 : scopeRank[a.scope];
    const rankB = scopeRank[b.scope] == null ? 9 : scopeRank[b.scope];
    if (rankA !== rankB) return rankA - rankB;
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.path.localeCompare(b.path);
  });

  return { skills, errors };
}

function findSkillsByName(skills = [], name = "") {
  const target = String(name || "").trim().toLowerCase();
  if (!target) return [];
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill && skill.enabled !== false && String(skill.name || "").trim().toLowerCase() === target);
}

module.exports = {
  SKILL_FILE,
  DEFAULT_MAX_DEPTH,
  canonicalPath,
  defaultSkillRoots,
  parseSkillFile,
  discoverSkillsUnderRoot,
  listUcodeSkills,
  findSkillsByName,
};

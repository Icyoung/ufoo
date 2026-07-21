const fs = require("fs");
const path = require("path");
const {
  canonicalPath,
  findSkillsByName,
  listUcodeSkills,
} = require("./loader");
const {
  buildSkillManifest,
  renderActiveSkillBlock,
} = require("./manifest");

function markdownSkillLinks(prompt = "") {
  const text = String(prompt || "");
  const links = [];
  const re = /\[([^\]]+)]\(([^)]+)\)/g;
  let match;
  while ((match = re.exec(text))) {
    const label = String(match[1] || "").trim();
    const target = String(match[2] || "").trim();
    if (!target) continue;
    if (target.startsWith("skill://") || /(?:^|[/\\])SKILL\.md(?:[#?].*)?$/i.test(target)) {
      links.push({ label, target });
    }
  }
  return links;
}

function mentionedSkillNames(prompt = "") {
  const text = String(prompt || "");
  const names = new Set();
  const re = /(^|[^\w-])\$([A-Za-z0-9][A-Za-z0-9_-]{0,63})\b/g;
  let match;
  while ((match = re.exec(text))) {
    names.add(String(match[2] || "").trim());
  }
  return Array.from(names).filter(Boolean);
}

function resolveSkillLinkTarget(target = "", workspaceRoot = process.cwd()) {
  const raw = String(target || "").trim().replace(/[#?].*$/, "");
  if (!raw) return "";
  let value = raw;
  if (value.startsWith("skill://")) {
    value = value.slice("skill://".length);
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw value
    }
  }
  if (!value) return "";
  if (path.isAbsolute(value)) return canonicalPath(value);
  return canonicalPath(path.resolve(workspaceRoot || process.cwd(), value));
}

function findSkillByPath(skills = [], targetPath = "") {
  const target = canonicalPath(targetPath);
  return (Array.isArray(skills) ? skills : []).find((skill) => canonicalPath(skill.path) === target) || null;
}

// Skill bodies are inlined into the prompt verbatim. A hostile or bloated
// SKILL.md could otherwise blow up the context window or close the <skill>
// block early to smuggle instructions, so cap the body size and neutralize
// any embedded closing tag. 32KB chars is a rough token budget proxy.
const MAX_SKILL_CONTENT_CHARS = 32 * 1024;

function sanitizeSkillContent(content = "") {
  let text = String(content || "");
  // Escape literal closing tags so the body cannot break out of the block.
  text = text.replace(/<\/skill\s*>/gi, "&lt;/skill&gt;");
  if (text.length > MAX_SKILL_CONTENT_CHARS) {
    text = `${text.slice(0, MAX_SKILL_CONTENT_CHARS)}\n...[skill content truncated: exceeded ${MAX_SKILL_CONTENT_CHARS} chars]`;
  }
  return text;
}

function readSkillBlock(skill, options = {}) {
  const content = sanitizeSkillContent(fs.readFileSync(skill.path, "utf8"));
  const useActive = options.useActiveSkillTag === true;
  const tag = useActive ? "active_skill" : "skill";
  const bodyArtifactId = String(options.bodyArtifactId || "").trim();
  const header = [
    `<${tag}>`,
    `<name>${skill.name}</name>`,
    `<path>${String(skill.path).replace(/\\/g, "/")}</path>`,
    bodyArtifactId ? `<bodyArtifactId>${bodyArtifactId}</bodyArtifactId>` : "",
  ].filter(Boolean).join("\n");
  return `${header}\n${content}\n</${tag}>`;
}

function persistSkillBodyArtifact(skill = {}, content = "", options = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const sessionId = String(options.sessionId || "").trim();
  if (!sessionId) return "";
  try {
    const { saveArtifact } = require("../context/artifacts");
    const saved = saveArtifact(workspaceRoot, sessionId, {
      type: "skill_body",
      tool: "skill",
      source: skill.path || "",
      args: { skill: skill.name || "" },
      raw: { ok: true, path: skill.path || "", content: String(content || "") },
      summary: `skill body ${skill.name || ""}`,
      createdBy: "skill_injection",
    });
    return saved && saved.artifact && saved.artifact.artifactId
      ? saved.artifact.artifactId
      : "";
  } catch {
    return "";
  }
}

function buildSkillInjections({
  prompt = "",
  workspaceRoot = process.cwd(),
  skillsOutcome = null,
  loadSkills = listUcodeSkills,
  sessionId = "",
  persistBodies = false,
  useActiveSkillTag = false,
} = {}) {
  const outcome = skillsOutcome || loadSkills({ workspaceRoot });
  const skills = Array.isArray(outcome.skills) ? outcome.skills : [];
  const warnings = Array.isArray(outcome.errors)
    ? outcome.errors.map((err) => `failed to load skill ${err.path}: ${err.message}`)
    : [];
  const selected = new Map();

  for (const name of mentionedSkillNames(prompt)) {
    const matches = findSkillsByName(skills, name);
    if (matches.length === 1) {
      selected.set(canonicalPath(matches[0].path), matches[0]);
    } else if (matches.length > 1) {
      warnings.push(`skill $${name} is ambiguous; link to a specific SKILL.md path`);
    } else {
      warnings.push(`skill $${name} was not found`);
    }
  }

  for (const link of markdownSkillLinks(prompt)) {
    const targetPath = resolveSkillLinkTarget(link.target, workspaceRoot);
    const skill = findSkillByPath(skills, targetPath);
    if (skill) {
      selected.set(canonicalPath(skill.path), skill);
    } else {
      warnings.push(`skill link ${link.target} did not resolve to an enabled skill`);
    }
  }

  const blocks = [];
  const manifests = [];
  const activeSkills = [];
  for (const skill of selected.values()) {
    try {
      const rawContent = fs.readFileSync(skill.path, "utf8");
      const content = sanitizeSkillContent(rawContent);
      let bodyArtifactId = "";
      if (persistBodies && sessionId) {
        bodyArtifactId = persistSkillBodyArtifact(skill, content, { workspaceRoot, sessionId });
      }
      const manifest = buildSkillManifest(skill, { bodyArtifactId });
      manifests.push(manifest);
      activeSkills.push({
        name: skill.name,
        path: skill.path,
        bodyArtifactId,
      });
      if (useActiveSkillTag) {
        blocks.push(renderActiveSkillBlock(manifest, content));
      } else {
        blocks.push(readSkillBlock(skill, { bodyArtifactId, useActiveSkillTag: false }));
      }
    } catch (err) {
      warnings.push(`failed to read skill ${skill.path}: ${err && err.message ? err.message : "read failed"}`);
    }
  }

  return {
    blocks,
    manifests,
    activeSkills,
    warnings,
    skills,
    errors: Array.isArray(outcome.errors) ? outcome.errors : [],
  };
}

module.exports = {
  mentionedSkillNames,
  markdownSkillLinks,
  resolveSkillLinkTarget,
  findSkillByPath,
  readSkillBlock,
  persistSkillBodyArtifact,
  buildSkillInjections,
};

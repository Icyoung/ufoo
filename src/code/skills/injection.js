const fs = require("fs");
const path = require("path");
const {
  canonicalPath,
  findSkillsByName,
  listUcodeSkills,
} = require("./loader");

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

function readSkillBlock(skill) {
  const content = fs.readFileSync(skill.path, "utf8");
  return `<skill>\n<name>${skill.name}</name>\n<path>${String(skill.path).replace(/\\/g, "/")}</path>\n${content}\n</skill>`;
}

function buildSkillInjections({
  prompt = "",
  workspaceRoot = process.cwd(),
  skillsOutcome = null,
  loadSkills = listUcodeSkills,
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
  for (const skill of selected.values()) {
    try {
      blocks.push(readSkillBlock(skill));
    } catch (err) {
      warnings.push(`failed to read skill ${skill.path}: ${err && err.message ? err.message : "read failed"}`);
    }
  }

  return {
    blocks,
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
  buildSkillInjections,
};

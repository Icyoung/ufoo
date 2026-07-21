const {
  listUcodeSkills,
  findSkillsByName,
} = require("./loader");
const {
  renderSkillsSection,
  formatSkillsList,
} = require("./render");
const {
  buildSkillInjections,
} = require("./injection");
const {
  buildSkillManifest,
  buildSkillManifests,
  renderSkillManifestSection,
  renderActiveSkillBlock,
} = require("./manifest");

function showSkill({ name = "", workspaceRoot = process.cwd(), asJson = false } = {}) {
  const outcome = listUcodeSkills({ workspaceRoot });
  const matches = findSkillsByName(outcome.skills, name);
  if (matches.length === 0) {
    return {
      ok: false,
      error: `skill not found: ${name}`,
      outcome,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `skill is ambiguous: ${name}`,
      outcome,
      matches,
    };
  }
  const skill = matches[0];
  let content = "";
  try {
    content = require("fs").readFileSync(skill.path, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : "failed to read skill",
      outcome,
      skill,
    };
  }
  if (asJson) {
    return {
      ok: true,
      skill,
      content,
      errors: outcome.errors,
    };
  }
  return {
    ok: true,
    output: [
      `# ${skill.name}`,
      "",
      `Description: ${skill.description}`,
      `Path: ${skill.path}`,
      "",
      content.trim(),
    ].join("\n"),
    skill,
    content,
    errors: outcome.errors,
  };
}

module.exports = {
  listUcodeSkills,
  findSkillsByName,
  renderSkillsSection,
  formatSkillsList,
  buildSkillInjections,
  buildSkillManifest,
  buildSkillManifests,
  renderSkillManifestSection,
  renderActiveSkillBlock,
  showSkill,
};

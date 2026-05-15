function renderSkillsSection(skills = []) {
  const list = (Array.isArray(skills) ? skills : []).filter((skill) => skill && skill.enabled !== false);
  if (list.length === 0) return "";

  const lines = [];
  lines.push("## Skills");
  lines.push("ufoo/ucode skills are built-in or local preset workflow capabilities discovered from SKILL.md files. The list below is for discovery and selection; it is not a private capability list for one agent, and the full skill body is loaded only when a user explicitly requests a skill.");
  lines.push("### Available skills");

  for (const skill of list) {
    const pathText = String(skill.path || "").replace(/\\/g, "/");
    const desc = String(skill.description || skill.shortDescription || "").trim();
    lines.push(`- ${skill.name}: ${desc} (file: ${pathText})`);
  }

  lines.push("### How to use skills");
  lines.push("- If the user names a skill with `$SkillName` or links directly to a `SKILL.md`, use that skill for this turn.");
  lines.push("- Do not assume a skill applies just because it exists; match the user request to the listed skill descriptions.");
  lines.push("- When a skill is selected, read only the specific skill body and nearby referenced files needed for the task.");
  lines.push("- If a skill is ambiguous, missing, or unreadable, say so briefly and continue with the best fallback.");

  return lines.join("\n");
}

function formatSkillsList({ skills = [], errors = [] } = {}) {
  const lines = [];
  const list = (Array.isArray(skills) ? skills : []).filter((skill) => skill && skill.enabled !== false);
  lines.push(`Available ufoo/ucode skills and preset workflows: ${list.length}`);
  for (const skill of list) {
    lines.push(`- ${skill.name}: ${skill.description} (${skill.scope}, ${skill.path})`);
  }
  const errs = Array.isArray(errors) ? errors : [];
  if (errs.length > 0) {
    lines.push("");
    lines.push(`Skill load warnings: ${errs.length}`);
    for (const err of errs) {
      lines.push(`- ${err.path}: ${err.message}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  renderSkillsSection,
  formatSkillsList,
};

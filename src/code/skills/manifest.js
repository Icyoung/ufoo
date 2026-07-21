"use strict";

function asStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,|]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function buildSkillManifest(skill = {}, options = {}) {
  const source = skill && typeof skill === "object" ? skill : {};
  const bodyArtifactId = String(options.bodyArtifactId || source.bodyArtifactId || "").trim();
  const triggers = Array.isArray(source.triggers) && source.triggers.length > 0
    ? source.triggers.map(String).filter(Boolean)
    : asStringList(source.trigger);
  const workflowSummary = String(
    source.workflowSummary
      || source.shortDescription
      || source.description
      || "",
  ).trim().slice(0, 400);

  return {
    name: String(source.name || "").trim(),
    description: String(source.description || "").trim(),
    shortDescription: String(source.shortDescription || "").trim(),
    triggers,
    workflowSummary,
    path: String(source.path || "").replace(/\\/g, "/"),
    scope: String(source.scope || "").trim(),
    bodyArtifactId,
  };
}

function buildSkillManifests(skills = [], options = {}) {
  return (Array.isArray(skills) ? skills : [])
    .filter((skill) => skill && skill.enabled !== false)
    .map((skill) => buildSkillManifest(skill, options));
}

function renderSkillManifestSection(manifests = []) {
  const list = Array.isArray(manifests) ? manifests.filter((m) => m && m.name) : [];
  if (list.length === 0) return "";

  const lines = [
    "## Skill Manifests",
    "Lightweight skill cards for selection. Full skill body loads only when a skill is explicitly activated.",
  ];
  for (const manifest of list) {
    lines.push(`### ${manifest.name}`);
    if (manifest.workflowSummary) lines.push(`- Workflow: ${manifest.workflowSummary}`);
    if (manifest.triggers && manifest.triggers.length > 0) {
      lines.push(`- Triggers: ${manifest.triggers.join(", ")}`);
    }
    if (manifest.bodyArtifactId) {
      lines.push(`- Body artifact: artifact://${manifest.bodyArtifactId}`);
    } else if (manifest.path) {
      lines.push(`- Path: ${manifest.path}`);
    }
  }
  return lines.join("\n");
}

function renderActiveSkillBlock(manifest = {}, body = "") {
  const name = String(manifest.name || "").trim() || "skill";
  const pathText = String(manifest.path || "").replace(/\\/g, "/");
  const bodyArtifactId = String(manifest.bodyArtifactId || "").trim();
  const header = [
    `<active_skill>`,
    `<name>${name}</name>`,
    pathText ? `<path>${pathText}</path>` : "",
    bodyArtifactId ? `<bodyArtifactId>${bodyArtifactId}</bodyArtifactId>` : "",
    manifest.workflowSummary ? `<workflowSummary>${manifest.workflowSummary}</workflowSummary>` : "",
  ].filter(Boolean).join("\n");
  return `${header}\n${String(body || "").trim()}\n</active_skill>`;
}

module.exports = {
  asStringList,
  buildSkillManifest,
  buildSkillManifests,
  renderSkillManifestSection,
  renderActiveSkillBlock,
};

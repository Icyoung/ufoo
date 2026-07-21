"use strict";

const {
  getIdentitySection,
} = require("../../agents/prompts/native/identity");
const {
  getSystemSection,
} = require("../../agents/prompts/native/system");
const {
  getDoingTasksSection,
} = require("../../agents/prompts/native/tasks");
const {
  getActionsSection,
} = require("../../agents/prompts/native/actions");
const {
  getSafetySection,
} = require("../../agents/prompts/native/safety");
const {
  getOutputEfficiencySection,
} = require("../../agents/prompts/native/efficiency");
const {
  getUfooIntegrationSection,
} = require("../../agents/prompts/native/ufoo");
const {
  getSessionStableEnvironmentSection,
  getTurnDynamicEnvironmentSection,
} = require("../../agents/prompts/native/environment");
const {
  listUcodeSkills,
  renderSkillsSection,
} = require("../skills");
const { hashContent } = require("./artifacts");

const PROMPT_VERSION = "native-v4";

function buildImmutablePrefix() {
  return [
    `promptVersion: ${PROMPT_VERSION}`,
    getIdentitySection(),
    getSystemSection(),
    getDoingTasksSection(),
    getActionsSection(),
    getSafetySection(),
    getOutputEfficiencySection(),
    [
      "Tool calling grammar:",
      "- Use read, write, edit, bash, artifact_read tools.",
      "- Tool results may reference artifactId; use artifact_read to hydrate raw content.",
      "State commit schema (optional at segment end):",
      '{"stateCommit":{"factsAdd":[],"hypothesesUpdate":[],"decisionsAdd":[],"questionsClose":[],"nextObjective":""},"contextPlan":{"retainRaw":[],"retainRegions":[],"summarize":[],"evict":[],"rehydrateNext":[]}}',
      "Context action schema:",
      '{"type":"execution_segment","objective":"","steps":[],"checkpoint":{"after":[]}}',
    ].join("\n"),
  ].join("\n\n");
}

function buildSkillCatalogVersion(skills = []) {
  const names = (Array.isArray(skills) ? skills : [])
    .map((s) => `${s.name}:${s.path}`)
    .sort()
    .join("|");
  return hashContent(names || "empty");
}

function buildSessionStablePrefix({
  workspaceRoot = "",
  provider = "",
  model = "",
  sessionStableExtras = "",
} = {}) {
  const root = workspaceRoot || process.cwd();
  const outcome = listUcodeSkills({ workspaceRoot: root });
  const catalogVersion = buildSkillCatalogVersion(outcome.skills);
  const parts = [
    getUfooIntegrationSection(),
    getSessionStableEnvironmentSection({ workspaceRoot: root, provider, model }),
    renderSkillsSection(outcome.skills),
    `skillCatalogVersion: ${catalogVersion}`,
  ];
  if (sessionStableExtras) parts.push(String(sessionStableExtras).trim());
  return parts.filter(Boolean).join("\n\n");
}

function buildLayeredSystemPrompt({
  workspaceRoot = "",
  model = "",
  provider = "",
  appendSystemPrompt = "",
  overrideSystemPrompt = "",
  epochDynamic = "",
  turnDynamic = "",
  sessionStableExtras = "",
} = {}) {
  if (overrideSystemPrompt) {
    return {
      blocks: [{ layer: "override", text: overrideSystemPrompt, cacheable: false }],
      flatText: overrideSystemPrompt,
    };
  }

  const immutable = buildImmutablePrefix();
  const sessionStable = buildSessionStablePrefix({
    workspaceRoot,
    provider,
    model,
    sessionStableExtras,
  });
  const epochText = String(epochDynamic || "").trim();
  const turnParts = [
    getTurnDynamicEnvironmentSection({ workspaceRoot: workspaceRoot || process.cwd() }),
    String(turnDynamic || "").trim(),
    String(appendSystemPrompt || "").trim(),
  ].filter(Boolean);

  const blocks = [
    { layer: "immutable", text: immutable, cacheable: true },
    { layer: "sessionStable", text: sessionStable, cacheable: true },
  ];
  if (epochText) {
    blocks.push({
      layer: "epoch",
      text: epochText,
      cacheable: true,
    });
  }
  if (turnParts.length > 0) {
    blocks.push({
      layer: "turnDynamic",
      text: turnParts.join("\n\n"),
      cacheable: false,
    });
  }

  return {
    blocks,
    flatText: blocks.map((b) => b.text).filter(Boolean).join("\n\n"),
  };
}

function systemBlocksToAnthropicPayload(blocks = []) {
  const list = (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.text);
  const ANTHROPIC_CACHE_CONTROL = { type: "ephemeral" };
  // Place cache breakpoints on every cacheable layer so Anthropic can reuse
  // Immutable → SessionStable → Epoch prefixes independently. Turn-dynamic
  // never gets cache_control.
  return list.map((block) => {
    const entry = { type: "text", text: block.text };
    if (block.cacheable) entry.cache_control = { ...ANTHROPIC_CACHE_CONTROL };
    return entry;
  });
}

module.exports = {
  PROMPT_VERSION,
  buildImmutablePrefix,
  buildSessionStablePrefix,
  buildLayeredSystemPrompt,
  systemBlocksToAnthropicPayload,
};

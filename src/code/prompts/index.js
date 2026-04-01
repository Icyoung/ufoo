"use strict";

const { getIdentitySection } = require("./identity");
const { getSystemSection } = require("./system");
const { getDoingTasksSection } = require("./tasks");
const { getActionsSection } = require("./actions");
const { getSafetySection } = require("./safety");
const { getOutputEfficiencySection } = require("./efficiency");
const { getUfooIntegrationSection } = require("./ufoo");
const { getEnvironmentSection } = require("./environment");
const {
  systemPromptSection,
  resolveSections,
  clearSectionCache,
} = require("./sections");

/**
 * Boundary marker separating static (cacheable) content from dynamic content.
 * Everything BEFORE this marker can be cached across turns.
 * Everything AFTER contains session-specific content.
 */
const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/**
 * Assemble the full system prompt as a string array.
 *
 * Priority system (3 levels):
 *   1. overrideSystemPrompt — completely replaces everything
 *   2. Default — modular sections assembled below
 *   3. appendSystemPrompt — always appended at the end
 *
 * @param {object} options
 * @param {string} [options.workspaceRoot]
 * @param {string} [options.model]
 * @param {string} [options.provider]
 * @param {string} [options.appendSystemPrompt]
 * @param {string} [options.overrideSystemPrompt]
 * @returns {string[]}
 */
function getSystemPrompt({
  workspaceRoot = "",
  model = "",
  provider = "",
  appendSystemPrompt = "",
  overrideSystemPrompt = "",
} = {}) {
  // Priority 1: override replaces everything
  if (overrideSystemPrompt) {
    return [overrideSystemPrompt];
  }

  // --- Static sections (cacheable, computed once per session) ---
  const staticSections = [
    getIdentitySection(),
    getSystemSection(),
    getDoingTasksSection(),
    getActionsSection(),
    getSafetySection(),
    getOutputEfficiencySection(),
  ];

  // --- Dynamic boundary ---
  const boundary = SYSTEM_PROMPT_DYNAMIC_BOUNDARY;

  // --- Dynamic sections (may change per session/turn) ---
  const dynamicSectionDefs = [
    systemPromptSection("ufoo", () => getUfooIntegrationSection()),
    systemPromptSection("environment", () =>
      getEnvironmentSection({ workspaceRoot, model, provider }),
    ),
  ];
  const dynamicSections = resolveSections(dynamicSectionDefs);

  // Assemble
  const result = [
    ...staticSections,
    boundary,
    ...dynamicSections,
    appendSystemPrompt || null,
  ].filter((s) => s != null && s !== "");

  return result;
}

/**
 * Build a single prompt context string from the modular sections.
 * This is the main entry point for backward compatibility with agent.js.
 *
 * @param {object} options — same as getSystemPrompt
 * @returns {string}
 */
function buildPromptContext(options = {}) {
  return getSystemPrompt(options)
    .filter((s) => s !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
    .join("\n\n");
}

module.exports = {
  getSystemPrompt,
  buildPromptContext,
  clearSectionCache,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
};

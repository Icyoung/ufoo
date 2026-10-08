"use strict";

const { buildSkillInjections } = require("../../../code/skills");

function createSkillsCapability() {
  return {
    id: "skills", version: "1.0", tools: [],
    contextSources: [(input) => buildSkillInjections(input)],
  };
}

module.exports = { createSkillsCapability };

"use strict";

const { UPDATE_DECISION_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { updateDecisionHandler } = require("../handlers/decisions");

module.exports = createToolDefinition({
  name: UPDATE_DECISION_SCHEMA.name,
  description: UPDATE_DECISION_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: UPDATE_DECISION_SCHEMA.input_schema,
  outputSchema: UPDATE_DECISION_SCHEMA.output_schema,
  schemaVersion: UPDATE_DECISION_SCHEMA.schema_version,
  handler: updateDecisionHandler,
});

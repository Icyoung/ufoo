const { READ_OPEN_DECISIONS_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { readOpenDecisionsHandler } = require("../handlers/readOpenDecisions");

module.exports = createToolDefinition({
  name: READ_OPEN_DECISIONS_SCHEMA.name,
  description: READ_OPEN_DECISIONS_SCHEMA.description,
  tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: READ_OPEN_DECISIONS_SCHEMA.input_schema,
  outputSchema: READ_OPEN_DECISIONS_SCHEMA.output_schema,
  schemaVersion: READ_OPEN_DECISIONS_SCHEMA.schema_version,
  handler: readOpenDecisionsHandler,
});

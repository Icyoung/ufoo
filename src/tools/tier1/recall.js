const { RECALL_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { recallHandler } = require("../handlers/memory");

module.exports = createToolDefinition({
  name: RECALL_SCHEMA.name,
  description: RECALL_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: RECALL_SCHEMA.input_schema,
  outputSchema: RECALL_SCHEMA.output_schema,
  schemaVersion: RECALL_SCHEMA.schema_version,
  handler: recallHandler,
});

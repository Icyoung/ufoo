const { READ_BUS_SUMMARY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { readBusSummaryHandler } = require("../handlers/readBusSummary");

module.exports = createToolDefinition({
  name: READ_BUS_SUMMARY_SCHEMA.name,
  description: READ_BUS_SUMMARY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: READ_BUS_SUMMARY_SCHEMA.input_schema,
  outputSchema: READ_BUS_SUMMARY_SCHEMA.output_schema,
  schemaVersion: READ_BUS_SUMMARY_SCHEMA.schema_version,
  handler: readBusSummaryHandler,
});

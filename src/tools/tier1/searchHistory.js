const { SEARCH_HISTORY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { searchHistoryHandler } = require("../handlers/memory");

module.exports = createToolDefinition({
  name: SEARCH_HISTORY_SCHEMA.name,
  description: SEARCH_HISTORY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: SEARCH_HISTORY_SCHEMA.input_schema,
  outputSchema: SEARCH_HISTORY_SCHEMA.output_schema,
  schemaVersion: SEARCH_HISTORY_SCHEMA.schema_version,
  handler: searchHistoryHandler,
});

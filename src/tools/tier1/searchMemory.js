const { SEARCH_MEMORY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { searchMemoryHandler } = require("../handlers/memory");

module.exports = createToolDefinition({
  name: SEARCH_MEMORY_SCHEMA.name,
  description: SEARCH_MEMORY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: SEARCH_MEMORY_SCHEMA.input_schema,
  outputSchema: SEARCH_MEMORY_SCHEMA.output_schema,
  schemaVersion: SEARCH_MEMORY_SCHEMA.schema_version,
  handler: searchMemoryHandler,
});

const { EDIT_MEMORY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { editMemoryHandler } = require("../handlers/memory");

module.exports = createToolDefinition({
  name: EDIT_MEMORY_SCHEMA.name,
  description: EDIT_MEMORY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: EDIT_MEMORY_SCHEMA.input_schema,
  outputSchema: EDIT_MEMORY_SCHEMA.output_schema,
  schemaVersion: EDIT_MEMORY_SCHEMA.schema_version,
  handler: editMemoryHandler,
});

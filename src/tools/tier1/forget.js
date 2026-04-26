const { FORGET_MEMORY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { forgetMemoryHandler } = require("../handlers/memory");

module.exports = createToolDefinition({
  name: FORGET_MEMORY_SCHEMA.name,
  description: FORGET_MEMORY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: FORGET_MEMORY_SCHEMA.input_schema,
  outputSchema: FORGET_MEMORY_SCHEMA.output_schema,
  schemaVersion: FORGET_MEMORY_SCHEMA.schema_version,
  handler: forgetMemoryHandler,
});

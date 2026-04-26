const { REMEMBER_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { rememberHandler } = require("../handlers/memory");

module.exports = createToolDefinition({
  name: REMEMBER_SCHEMA.name,
  description: REMEMBER_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: REMEMBER_SCHEMA.input_schema,
  outputSchema: REMEMBER_SCHEMA.output_schema,
  schemaVersion: REMEMBER_SCHEMA.schema_version,
  handler: rememberHandler,
});

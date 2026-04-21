const { READ_PROJECT_REGISTRY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { readProjectRegistryHandler } = require("../handlers/readProjectRegistry");

module.exports = createToolDefinition({
  name: READ_PROJECT_REGISTRY_SCHEMA.name,
  description: READ_PROJECT_REGISTRY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: READ_PROJECT_REGISTRY_SCHEMA.input_schema,
  outputSchema: READ_PROJECT_REGISTRY_SCHEMA.output_schema,
  schemaVersion: READ_PROJECT_REGISTRY_SCHEMA.schema_version,
  handler: readProjectRegistryHandler,
});

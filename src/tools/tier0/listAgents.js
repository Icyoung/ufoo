const { LIST_AGENTS_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { listAgentsHandler } = require("../handlers/listAgents");

module.exports = createToolDefinition({
  name: LIST_AGENTS_SCHEMA.name,
  description: LIST_AGENTS_SCHEMA.description,
  tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: LIST_AGENTS_SCHEMA.input_schema,
  outputSchema: LIST_AGENTS_SCHEMA.output_schema,
  schemaVersion: LIST_AGENTS_SCHEMA.schema_version,
  handler: listAgentsHandler,
});

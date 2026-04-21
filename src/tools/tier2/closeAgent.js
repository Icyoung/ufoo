const { CLOSE_AGENT_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { closeAgentHandler } = require("../handlers/tier2");

module.exports = createToolDefinition({
  name: CLOSE_AGENT_SCHEMA.name,
  description: CLOSE_AGENT_SCHEMA.description,
  tier: TOOL_TIERS.TIER_2,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER],
  inputSchema: CLOSE_AGENT_SCHEMA.input_schema,
  outputSchema: CLOSE_AGENT_SCHEMA.output_schema,
  schemaVersion: CLOSE_AGENT_SCHEMA.schema_version,
  handler: closeAgentHandler,
});

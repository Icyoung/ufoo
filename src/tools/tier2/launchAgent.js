const { LAUNCH_AGENT_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { launchAgentHandler } = require("../handlers/tier2");

module.exports = createToolDefinition({
  name: LAUNCH_AGENT_SCHEMA.name,
  description: LAUNCH_AGENT_SCHEMA.description,
  tier: TOOL_TIERS.TIER_2,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER],
  inputSchema: LAUNCH_AGENT_SCHEMA.input_schema,
  outputSchema: LAUNCH_AGENT_SCHEMA.output_schema,
  schemaVersion: LAUNCH_AGENT_SCHEMA.schema_version,
  handler: launchAgentHandler,
});

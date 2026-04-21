const { RENAME_AGENT_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { renameAgentHandler } = require("../handlers/tier2");

module.exports = createToolDefinition({
  name: RENAME_AGENT_SCHEMA.name,
  description: RENAME_AGENT_SCHEMA.description,
  tier: TOOL_TIERS.TIER_2,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER],
  inputSchema: RENAME_AGENT_SCHEMA.input_schema,
  outputSchema: RENAME_AGENT_SCHEMA.output_schema,
  schemaVersion: RENAME_AGENT_SCHEMA.schema_version,
  handler: renameAgentHandler,
});

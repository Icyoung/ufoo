const { READ_AGENT_HISTORY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { readAgentHistoryHandler } = require("../handlers/readAgentHistory");

module.exports = createToolDefinition({
  name: READ_AGENT_HISTORY_SCHEMA.name,
  description: READ_AGENT_HISTORY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: READ_AGENT_HISTORY_SCHEMA.input_schema,
  outputSchema: READ_AGENT_HISTORY_SCHEMA.output_schema,
  schemaVersion: READ_AGENT_HISTORY_SCHEMA.schema_version,
  handler: readAgentHistoryHandler,
});

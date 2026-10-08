const { ROUTE_AGENT_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { routeAgentHandler } = require("../handlers/routeAgent");

module.exports = createToolDefinition({
  name: ROUTE_AGENT_SCHEMA.name,
  description: ROUTE_AGENT_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: ROUTE_AGENT_SCHEMA.input_schema,
  outputSchema: ROUTE_AGENT_SCHEMA.output_schema,
  schemaVersion: ROUTE_AGENT_SCHEMA.schema_version,
  handler: routeAgentHandler,
});

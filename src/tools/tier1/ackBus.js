const { ACK_BUS_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { ackBusHandler } = require("../handlers/ackBus");

module.exports = createToolDefinition({
  name: ACK_BUS_SCHEMA.name,
  description: ACK_BUS_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: ACK_BUS_SCHEMA.input_schema,
  outputSchema: ACK_BUS_SCHEMA.output_schema,
  schemaVersion: ACK_BUS_SCHEMA.schema_version,
  handler: ackBusHandler,
});

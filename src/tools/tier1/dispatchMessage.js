const { DISPATCH_MESSAGE_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { dispatchMessageHandler } = require("../handlers/dispatchMessage");

module.exports = createToolDefinition({
  name: DISPATCH_MESSAGE_SCHEMA.name,
  description: DISPATCH_MESSAGE_SCHEMA.description,
  tier: TOOL_TIERS.TIER_1,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: DISPATCH_MESSAGE_SCHEMA.input_schema,
  outputSchema: DISPATCH_MESSAGE_SCHEMA.output_schema,
  schemaVersion: DISPATCH_MESSAGE_SCHEMA.schema_version,
  handler: dispatchMessageHandler,
});

const { MANAGE_CRON_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { manageCronHandler } = require("../handlers/tier2");

module.exports = createToolDefinition({
  name: MANAGE_CRON_SCHEMA.name,
  description: MANAGE_CRON_SCHEMA.description,
  tier: TOOL_TIERS.TIER_2,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER],
  inputSchema: MANAGE_CRON_SCHEMA.input_schema,
  outputSchema: MANAGE_CRON_SCHEMA.output_schema,
  schemaVersion: MANAGE_CRON_SCHEMA.schema_version,
  handler: manageCronHandler,
});

const { READ_PROMPT_HISTORY_SCHEMA } = require("../schemaFixtures");
const { CALLER_TIERS, TOOL_TIERS, createToolDefinition } = require("../types");
const { readPromptHistoryHandler } = require("../handlers/readPromptHistory");

module.exports = createToolDefinition({
  name: READ_PROMPT_HISTORY_SCHEMA.name,
  description: READ_PROMPT_HISTORY_SCHEMA.description,
  tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  inputSchema: READ_PROMPT_HISTORY_SCHEMA.input_schema,
  outputSchema: READ_PROMPT_HISTORY_SCHEMA.output_schema,
  schemaVersion: READ_PROMPT_HISTORY_SCHEMA.schema_version,
  handler: readPromptHistoryHandler,
});

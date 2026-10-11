"use strict";

const { createToolDefinition, CALLER_TIERS, TOOL_TIERS } = require("../types");
const { READ_AGENT_METRICS_SCHEMA } = require("../schemaFixtures");
const { readAgentPerformance } = require("../../coordination/history/agentTrace");

module.exports = createToolDefinition({ name: READ_AGENT_METRICS_SCHEMA.name, description: READ_AGENT_METRICS_SCHEMA.description,
  inputSchema: READ_AGENT_METRICS_SCHEMA.input_schema, outputSchema: READ_AGENT_METRICS_SCHEMA.output_schema,
  schemaVersion: READ_AGENT_METRICS_SCHEMA.schema_version, tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  handler: (ctx, args) => {
    try { return readAgentPerformance(ctx.projectRoot, args); }
    catch (error) { return { ok: false, code: "invalid_arguments", error: error.message }; }
  } });

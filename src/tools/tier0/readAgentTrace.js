"use strict";
const { createToolDefinition, CALLER_TIERS, TOOL_TIERS } = require("../types");
const { READ_AGENT_TRACE_SCHEMA } = require("../schemaFixtures");
const { readAgentTrace } = require("../../coordination/history/agentTrace");
module.exports = createToolDefinition({ name: READ_AGENT_TRACE_SCHEMA.name, description: READ_AGENT_TRACE_SCHEMA.description,
  inputSchema: READ_AGENT_TRACE_SCHEMA.input_schema, outputSchema: READ_AGENT_TRACE_SCHEMA.output_schema,
  schemaVersion: READ_AGENT_TRACE_SCHEMA.schema_version, tier: TOOL_TIERS.TIER_0,
  allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
  handler: (ctx, args) => {
    if (args.since && !Number.isFinite(Date.parse(args.since))) return { ok: false, code: "invalid_arguments", error: "since must be an ISO timestamp" };
    return readAgentTrace(ctx.projectRoot, args);
  } });

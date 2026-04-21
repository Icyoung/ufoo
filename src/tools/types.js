const TOOL_TIERS = Object.freeze({
  TIER_0: "tier0-read",
  TIER_1: "tier1-coordination",
  TIER_2: "tier2-orchestration",
});

const CALLER_TIERS = Object.freeze({
  CONTROLLER: "controller",
  WORKER: "worker",
});

const DEFAULT_SCHEMA_VERSION = "1.0";

function normalizeCallerTier(value) {
  return String(value || "").trim().toLowerCase();
}

function createToolDefinition({
  name,
  description,
  tier,
  allowedCallerTiers,
  inputSchema,
  outputSchema,
  handler,
  schemaVersion,
}) {
  const allowed = Object.freeze([...(allowedCallerTiers || [])]);
  return Object.freeze({
    name,
    description,
    tier,
    schema_version: String(schemaVersion || DEFAULT_SCHEMA_VERSION),
    allowedCallerTiers: allowed,
    allowed_tiers: allowed,
    input_schema: Object.freeze(inputSchema),
    output_schema: outputSchema ? Object.freeze(outputSchema) : null,
    handler,
  });
}

function buildCallerTierError(toolDef, callerTier, auditCtx = {}) {
  const tier = normalizeCallerTier(callerTier) || "unknown";
  const message = `caller_tier "${tier}" is not allowed to invoke tool "${toolDef.name}"`;
  const err = new Error(message);
  err.code = "forbidden_caller_tier";
  err.tool_name = toolDef.name;
  err.caller_tier = tier;
  err.allowed_tiers = Array.isArray(toolDef.allowed_tiers) ? toolDef.allowed_tiers.slice() : [];
  if (auditCtx && auditCtx.turn_id) err.turn_id = String(auditCtx.turn_id);
  if (auditCtx && auditCtx.tool_call_id) err.tool_call_id = String(auditCtx.tool_call_id);
  return err;
}

function assertCallerTierAllowed(toolDef, callerTier, auditCtx = {}) {
  if (!toolDef || !Array.isArray(toolDef.allowed_tiers)) {
    const err = new Error("tool definition missing allowed_tiers metadata");
    err.code = "invalid_tool_definition";
    throw err;
  }
  const tier = normalizeCallerTier(callerTier);
  if (!tier || !toolDef.allowed_tiers.includes(tier)) {
    throw buildCallerTierError(toolDef, callerTier, auditCtx);
  }
}

module.exports = {
  TOOL_TIERS,
  CALLER_TIERS,
  DEFAULT_SCHEMA_VERSION,
  createToolDefinition,
  assertCallerTierAllowed,
  buildCallerTierError,
  normalizeCallerTier,
};

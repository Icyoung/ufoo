const EventBus = require("../../bus");
const { CALLER_TIERS, normalizeCallerTier } = require("../types");

function extractAuditFields(ctx = {}) {
  const audit = {};
  const turnId = ctx.turn_id || ctx.turnId;
  const toolCallId = ctx.tool_call_id || ctx.toolCallId;
  if (turnId) audit.turn_id = String(turnId);
  if (toolCallId) audit.tool_call_id = String(toolCallId);
  const callerTier = normalizeCallerTier(ctx.caller_tier || ctx.callerTier);
  if (callerTier) audit.caller_tier = callerTier;
  return audit;
}

function buildToolError(code, message, extra = {}) {
  const err = new Error(String(message || "tool execution failed"));
  err.code = String(code || "tool_error");
  Object.assign(err, extra);
  return err;
}

function requireSubscriber(ctx = {}) {
  const subscriber = String(ctx.subscriber || "").trim();
  if (!subscriber) {
    throw buildToolError("invalid_context", "tool requires subscriber context", extractAuditFields(ctx));
  }
  return subscriber;
}

function getEventBus(ctx = {}) {
  if (ctx.eventBus) return ctx.eventBus;
  return new EventBus(ctx.projectRoot);
}

function resolveCallerTier(ctx = {}) {
  const raw = normalizeCallerTier(ctx.caller_tier || ctx.callerTier);
  return raw || CALLER_TIERS.CONTROLLER;
}

function assertControllerTier(ctx = {}, toolName = "") {
  const tier = resolveCallerTier(ctx);
  if (tier !== CALLER_TIERS.CONTROLLER) {
    const audit = extractAuditFields(ctx);
    audit.caller_tier = tier;
    throw buildToolError(
      "forbidden_caller_tier",
      `caller_tier "${tier}" is not allowed to invoke tool "${toolName}"`,
      {
        tool_name: toolName,
        allowed_tiers: [CALLER_TIERS.CONTROLLER],
        ...audit,
      }
    );
  }
}

module.exports = {
  buildToolError,
  requireSubscriber,
  getEventBus,
  resolveCallerTier,
  assertControllerTier,
  extractAuditFields,
};

const {
  buildToolError,
  assertControllerTier,
  extractAuditFields,
} = require("./common");

function normalizePositiveInt(value, fallback) {
  const num = Number.parseInt(value, 10);
  if (Number.isFinite(num) && num > 0) return num;
  return fallback;
}

function decorateAudit(result, audit) {
  if (!audit || (!audit.turn_id && !audit.tool_call_id && !audit.caller_tier)) {
    return result;
  }
  return { ...result, audit };
}

function guardInvalidArgs(ctx, toolName, message) {
  throw buildToolError("invalid_arguments", `${toolName} ${message}`, {
    tool_name: toolName,
    ...extractAuditFields(ctx),
  });
}

async function runSingleOp(ctx, op, toolName) {
  if (typeof ctx.handleOps !== "function") {
    throw buildToolError("tool_unavailable", `${toolName} hook is unavailable`, {
      tool_name: toolName,
      ...extractAuditFields(ctx),
    });
  }
  const results = await ctx.handleOps(ctx.projectRoot, [op], ctx.processManager || null);
  return Array.isArray(results) ? results : [];
}

async function launchAgentHandler(ctx = {}, args = {}) {
  assertControllerTier(ctx, "launch_agent");
  const audit = extractAuditFields(ctx);
  const agent = String(args.agent || "").trim().toLowerCase();
  if (!agent) guardInvalidArgs(ctx, "launch_agent", "requires agent");

  const op = {
    action: "launch",
    agent,
    count: normalizePositiveInt(args.count, 1),
  };
  if (args.nickname) op.nickname = String(args.nickname).trim();
  if (args.prompt_profile) op.prompt_profile = String(args.prompt_profile).trim();

  const opsResults = await runSingleOp(ctx, op, "launch_agent");
  return decorateAudit({
    ok: true,
    operation: op,
    ops_results: opsResults,
  }, audit);
}

async function renameAgentHandler(ctx = {}, args = {}) {
  assertControllerTier(ctx, "rename_agent");
  const audit = extractAuditFields(ctx);
  const agentId = String(args.agent_id || "").trim();
  const nickname = String(args.nickname || "").trim();
  if (!agentId) guardInvalidArgs(ctx, "rename_agent", "requires agent_id");
  if (!nickname) guardInvalidArgs(ctx, "rename_agent", "requires nickname");

  const op = {
    action: "rename",
    agent_id: agentId,
    nickname,
  };

  const opsResults = await runSingleOp(ctx, op, "rename_agent");
  return decorateAudit({
    ok: true,
    operation: op,
    ops_results: opsResults,
  }, audit);
}

async function closeAgentHandler(ctx = {}, args = {}) {
  assertControllerTier(ctx, "close_agent");
  const audit = extractAuditFields(ctx);
  const agentId = String(args.agent_id || args.target || "").trim();
  if (!agentId) guardInvalidArgs(ctx, "close_agent", "requires agent_id");

  const op = {
    action: "close",
    agent_id: agentId,
  };

  const opsResults = await runSingleOp(ctx, op, "close_agent");
  return decorateAudit({
    ok: true,
    operation: op,
    ops_results: opsResults,
  }, audit);
}

async function manageCronHandler(ctx = {}, args = {}) {
  assertControllerTier(ctx, "manage_cron");
  const audit = extractAuditFields(ctx);
  const operation = String(args.operation || "").trim().toLowerCase();
  if (!operation) guardInvalidArgs(ctx, "manage_cron", "requires operation");

  const op = {
    action: "cron",
    operation,
  };
  if (args.id) op.id = String(args.id).trim();
  if (args.every) op.every = String(args.every).trim();
  if (args.at) op.at = String(args.at).trim();
  if (args.target) op.target = String(args.target).trim();
  if (Array.isArray(args.targets)) op.targets = args.targets.slice();
  if (args.prompt) op.prompt = String(args.prompt).trim();
  if (args.title) op.title = String(args.title).trim();
  if (Number.isFinite(Number(args.interval_ms))) op.interval_ms = Math.floor(Number(args.interval_ms));
  if (Number.isFinite(Number(args.once_at_ms))) op.once_at_ms = Math.floor(Number(args.once_at_ms));

  const opsResults = await runSingleOp(ctx, op, "manage_cron");
  return decorateAudit({
    ok: true,
    operation: op,
    ops_results: opsResults,
  }, audit);
}

module.exports = {
  launchAgentHandler,
  renameAgentHandler,
  closeAgentHandler,
  manageCronHandler,
};

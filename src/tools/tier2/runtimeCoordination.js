"use strict";

const { CONTROLLER_TOOL_SCHEMAS } = require("../controllerSchemas");
const { createToolDefinition, CALLER_TIERS, TOOL_TIERS } = require("../types");
const { assertControllerTier, buildToolError } = require("../handlers/common");

const ports = {
  delegate_task: "agentManagement", read_task_reports: "agentManagement", accept_task: "agentManagement",
  manage_tasks: "taskScheduler", resume_agents: "agentLifecycle", manage_group: "groups",
};
async function execute(name, ctx, args) {
  assertControllerTier(ctx, name);
  const port = ctx[ports[name]];
  if (!port) throw buildToolError("tool_unavailable", `${name} requires a project host port`);
  if (name === "delegate_task") return port.delegate(args, ctx);
  if (name === "read_task_reports") {
    const tasks = Object.values(port.snapshot().tasks);
    return { ok: true, tasks: (args.task_id ? tasks.filter((task) => task.taskId === args.task_id) : tasks).slice(-100) };
  }
  if (name === "accept_task") return port.accept(args, ctx);
  if (name === "manage_tasks") return port.execute(args, ctx);
  const commandId = ctx.requestId ? `coord-${require("crypto").createHash("sha256").update(`${ctx.requestId}:${args.command_id}`).digest("hex").slice(0, 32)}` : args.command_id;
  if (name === "resume_agents") {
    if (args.operation === "inspect") return port.inspect(args.target || "");
    return ctx.agentManagement.commands.execute({ commandId, kind: name, args }, () => port.resume(args.target || ""));
  }
  if (args.operation === "validate") return port.validateTemplateTarget(args.target || "");
  if (args.operation === "status") return port.getStatus({ group_id: args.group_id || "" });
  return ctx.agentManagement.commands.execute({ commandId, kind: name, args }, () => args.operation === "start"
    ? port.runGroup({ alias: args.target, ...(ctx.internalAgentsOnly ? { internal_only: true } : {}), instance: args.group_id || `group-${require("crypto").createHash("sha256").update(commandId).digest("hex").slice(0, 16)}` }) : port.stopGroup({ group_id: args.group_id }));
}

module.exports = Object.values(CONTROLLER_TOOL_SCHEMAS).map((schema) => createToolDefinition({
  name: schema.name, description: schema.description, inputSchema: schema.input_schema, outputSchema: schema.output_schema,
  schemaVersion: schema.schema_version, tier: TOOL_TIERS.TIER_2, allowedCallerTiers: [CALLER_TIERS.CONTROLLER],
  requiredPorts: [ports[schema.name], ...(["resume_agents", "manage_group"].includes(schema.name) ? ["agentManagement"] : [])],
  handler: (ctx, args) => execute(schema.name, ctx, args),
}));

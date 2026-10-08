"use strict";

const { listToolsForCallerTier } = require("../../../tools/registry");
const { CALLER_TIERS } = require("../../../tools/types");
const { executeControllerTool } = require("../../controller/controllerToolExecutor");

const TOOL_PERMISSIONS = Object.freeze({
  launch_agent: "agents.manage", rename_agent: "agents.manage", close_agent: "agents.manage",
  manage_cron: "schedules.manage", dispatch_message: "coordination.write", ack_bus: "coordination.write",
  delegate_task: "agents.manage", resume_agents: "agents.manage", accept_task: "tasks.accept",
  manage_tasks: "tasks.execute", manage_group: "groups.manage",
  remember: "memory.write", edit_memory: "memory.write", forget: "memory.write",
});

/** Shared definitions retain the same schemas and tier checks used by MCP. */
function createCoordinationCapability({ host, id = "coordination", toolNames = null, policy = null } = {}) {
  const definitions = listToolsForCallerTier(CALLER_TIERS.CONTROLLER)
    .filter((tool) => (!toolNames || toolNames.includes(tool.name)) && (tool.requiredPorts || []).every((port) => host.coordination[port]));
  const requestedPermissions = [...new Set(definitions.map((tool) => TOOL_PERMISSIONS[tool.name] || "coordination.read"))];
  return {
    id, version: 1, requires: { ports: ["coordination"] }, requestedPermissions, policy,
    tools: definitions.map((tool) => ({
      name: tool.name, description: tool.description, inputSchema: tool.input_schema,
      permissions: [TOOL_PERMISSIONS[tool.name] || "coordination.read"],
      async handler(args, context) {
        const ports = host.coordination;
        const invoke = ports.execute || executeControllerTool;
        return invoke({ ...ports, projectRoot: context.workspaceRoot || ports.projectRoot,
          subscriber: "ufoo-agent", turnId: context.turnId, taskId: context.taskId,
          requestId: context.requestId, taskRunId: context.taskRunId, sessionId: context.sessionId },
        { name: tool.name, arguments: args, id: context.toolCallId });
      },
    })),
  };
}

module.exports = { createCoordinationCapability, TOOL_PERMISSIONS };

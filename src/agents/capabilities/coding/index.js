"use strict";

const { buildCoreToolSpecs } = require("../../../code/tools/specs");
const { runCoreToolAsync } = require("../../../code/tools/executor");

const CODING_TOOLS = new Set(["read", "read_image", "write", "edit", "bash", "artifact_read"]);

function toolFromSpec(spec) {
  const { name, description, parameters } = spec.function;
  return {
    name, description, inputSchema: parameters,
    permissions: [name === "bash" ? "workspace.execute" : ["write", "edit"].includes(name) ? "workspace.write" : "workspace.read"],
    tight: ["read", "read_image", "artifact_read"].includes(name),
    handler: (args, context) => runCoreToolAsync({ ...context, tool: name, args }),
  };
}

function createCodingCapability({ workspaceAccess = null } = {}) {
  return {
    id: "coding", version: "1.0",
    requires: { providerFeatures: ["tool_calls", "vision"] },
    tools: buildCoreToolSpecs().filter((spec) => CODING_TOOLS.has(spec.function.name)).map((spec) => {
      const tool = toolFromSpec(spec);
      return workspaceAccess ? { ...tool, async handler(args, context) {
        const result = await workspaceAccess.run({ ...context, tool: tool.name, args }, () => tool.handler(args, context));
        return { ...result, toolCallId: context.toolCallId };
      } } : tool;
    }),
  };
}

module.exports = { createCodingCapability, toolFromSpec };

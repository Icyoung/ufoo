"use strict";

const { AjvJsonSchemaValidator } = require("@modelcontextprotocol/sdk/validation/ajv-provider.js");

/** Bind an explicit tool set. Host grants are independent of model/profile input. */
function createToolRegistry({ tools = [], grantedPermissions = [], authorize = null } = {}) {
  const definitions = new Map();
  const permissions = new Set(grantedPermissions);
  const validator = new AjvJsonSchemaValidator();
  if (authorize != null && typeof authorize !== "function") throw new Error("host authorizeTool must be a function");
  for (const tool of tools) {
    if (!tool || !/^[a-z][a-z0-9_-]*$/.test(tool.name || "")) {
      throw new Error("invalid runtime tool name");
    }
    if (definitions.has(tool.name)) throw new Error(`duplicate runtime tool: ${tool.name}`);
    if (typeof tool.handler !== "function") throw new Error(`missing handler: ${tool.name}`);
    const requiredPermissions = [...(tool.permissions || [])];
    for (const permission of requiredPermissions) {
      if (!permissions.has(permission)) throw new Error(`tool ${tool.name} requires permission: ${permission}`);
    }
    const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema || { type: "object" }));
    definitions.set(tool.name, {
      ...tool,
      inputSchema,
      permissions: requiredPermissions,
      validateInput: validator.getValidator(inputSchema),
    });
  }

  return Object.freeze({
    names: () => [...definitions.keys()],
    deferableTools: () => [...definitions.values()].filter((tool) => tool.deferable).map((tool) => tool.name),
    tightTools: () => [...definitions.values()].filter((tool) => tool.tight).map((tool) => tool.name),
    toOpenAiTools: () => [...definitions.values()].map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: JSON.parse(JSON.stringify(tool.inputSchema)),
      },
    })),
    async execute(name, args, context = {}) {
      const tool = definitions.get(String(name || "").trim());
      if (!tool) return { ok: false, code: "unsupported_tool", error: `unsupported tool: ${name}` };
      const validation = tool.validateInput(args);
      if (!validation.valid) {
        return { ok: false, code: "invalid_tool_arguments", error: validation.errorMessage };
      }
      if (authorize && await authorize({ name: tool.name, permissions: tool.permissions.slice(), context }) !== true) {
        return { ok: false, code: "forbidden_tool", error: `host denied tool: ${name}` };
      }
      return tool.handler(args, context);
    },
  });
}

module.exports = { createToolRegistry };

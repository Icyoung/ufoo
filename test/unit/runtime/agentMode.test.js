const { INTERNAL_AGENT_TYPES, normalizeInternalAgentType, isInternalAgentMeta } = require("../../../src/runtime/contracts/agentMode");
const { CONTROLLER_TOOL_SCHEMAS } = require("../../../src/tools/controllerSchemas");
const { LAUNCH_AGENT_SCHEMA } = require("../../../src/tools/schemaFixtures");

describe("internal worker boundary", () => {
  test("tool catalogs expose exactly the runners that exist", () => {
    expect(INTERNAL_AGENT_TYPES).toEqual(["codex", "claude", "ucode"]);
    expect(CONTROLLER_TOOL_SCHEMAS.delegate_task.input_schema.properties.agent.enum).toEqual(INTERNAL_AGENT_TYPES);
    expect(LAUNCH_AGENT_SCHEMA.input_schema.properties.agent.enum).toEqual(INTERNAL_AGENT_TYPES);
    expect(normalizeInternalAgentType("claude-code")).toBe("claude");
  });
  test.each(["grok", "agy", "kimi", "ufoo", "ufoo-code", "unknown"])("type %s cannot enter the managed roster", (type) => {
    expect(normalizeInternalAgentType(type)).toBe("");
    expect(isInternalAgentMeta({ agent_type: type, launch_mode: "internal" })).toBe(false);
  });
  test("wrapper and external registrations stay outside the panel", () => {
    expect(isInternalAgentMeta({ agent_type: "codex", launch_mode: "terminal" })).toBe(false);
    expect(isInternalAgentMeta({ agent_type: "claude-code", launch_mode: "mcp" })).toBe(false);
    expect(isInternalAgentMeta({ agent_type: "ucode", launch_mode: "internal" })).toBe(true);
    expect(isInternalAgentMeta({ id: "codex:child", launch_mode: "internal" })).toBe(true);
  });
});

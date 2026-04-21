const {
  SHARED_TOOL_REGISTRY,
  PHASE0_TOOL_SCHEMAS,
  SCHEMA_VERSION,
  TOOL_TIERS,
  CALLER_TIERS,
  getSharedToolRegistry,
  getToolDefinition,
  listToolsForCallerTier,
  assertToolAllowedForCallerTier,
  assertCallerTierAllowed,
} = require("../../../src/tools");

describe("shared tool registry", () => {
  test("exports the required Phase 0 tool definitions", () => {
    expect(SHARED_TOOL_REGISTRY.map((tool) => tool.name)).toEqual([
      "read_bus_summary",
      "read_prompt_history",
      "read_open_decisions",
      "list_agents",
      "read_project_registry",
      "route_agent",
      "dispatch_message",
      "ack_bus",
      "launch_agent",
      "rename_agent",
      "close_agent",
      "manage_cron",
    ]);

    expect(getToolDefinition("read_bus_summary")).toMatchObject({
      tier: TOOL_TIERS.TIER_0,
      allowedCallerTiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("read_prompt_history")).toMatchObject({
      tier: TOOL_TIERS.TIER_0,
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("read_open_decisions")).toMatchObject({
      tier: TOOL_TIERS.TIER_0,
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("list_agents")).toMatchObject({
      tier: TOOL_TIERS.TIER_0,
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("read_project_registry")).toMatchObject({
      tier: TOOL_TIERS.TIER_0,
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("route_agent")).toMatchObject({
      tier: TOOL_TIERS.TIER_1,
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("dispatch_message")).toMatchObject({
      tier: TOOL_TIERS.TIER_1,
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("ack_bus")).toMatchObject({
      tier: TOOL_TIERS.TIER_1,
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("launch_agent")).toMatchObject({
      tier: TOOL_TIERS.TIER_2,
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("rename_agent")).toMatchObject({
      tier: TOOL_TIERS.TIER_2,
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("close_agent")).toMatchObject({
      tier: TOOL_TIERS.TIER_2,
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
      schema_version: "1.0",
    });
    expect(getToolDefinition("manage_cron")).toMatchObject({
      tier: TOOL_TIERS.TIER_2,
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
      schema_version: "1.0",
    });
  });

  test("every tool definition surfaces schema_version and allowed_tiers metadata", () => {
    for (const tool of SHARED_TOOL_REGISTRY) {
      expect(tool.schema_version).toBe(SCHEMA_VERSION);
      expect(Array.isArray(tool.allowed_tiers)).toBe(true);
      expect(tool.allowed_tiers.length).toBeGreaterThan(0);
    }
  });

  test("filters tools by caller tier (identity-gated registry view)", () => {
    expect(listToolsForCallerTier(CALLER_TIERS.CONTROLLER).map((tool) => tool.name)).toEqual([
      "read_bus_summary",
      "read_prompt_history",
      "read_open_decisions",
      "list_agents",
      "read_project_registry",
      "route_agent",
      "dispatch_message",
      "ack_bus",
      "launch_agent",
      "rename_agent",
      "close_agent",
      "manage_cron",
    ]);
    expect(listToolsForCallerTier(CALLER_TIERS.WORKER).map((tool) => tool.name)).toEqual([
      "read_bus_summary",
      "read_prompt_history",
      "read_open_decisions",
      "list_agents",
      "read_project_registry",
      "route_agent",
      "dispatch_message",
      "ack_bus",
    ]);
  });

  test("listToolsForCallerTier rejects unknown tiers as empty", () => {
    expect(listToolsForCallerTier("observer")).toEqual([]);
    expect(listToolsForCallerTier("")).toEqual([]);
  });

  test("returns a copy of the shared registry list", () => {
    const copy = getSharedToolRegistry();
    copy.pop();

    expect(copy).toHaveLength(11);
    expect(SHARED_TOOL_REGISTRY).toHaveLength(12);
  });

  test("exports Phase 0 schema fixtures for translator validation", () => {
    expect(PHASE0_TOOL_SCHEMAS.read_bus_summary).toMatchObject({
      name: "read_bus_summary",
      schema_version: "1.0",
      allowed_tiers: [CALLER_TIERS.CONTROLLER, CALLER_TIERS.WORKER],
    });
    expect(PHASE0_TOOL_SCHEMAS.read_prompt_history).toMatchObject({
      name: "read_prompt_history",
      schema_version: "1.0",
    });
    expect(PHASE0_TOOL_SCHEMAS.read_open_decisions).toMatchObject({
      name: "read_open_decisions",
      schema_version: "1.0",
    });
    expect(PHASE0_TOOL_SCHEMAS.list_agents).toMatchObject({
      name: "list_agents",
      schema_version: "1.0",
    });
    expect(PHASE0_TOOL_SCHEMAS.read_project_registry).toMatchObject({
      name: "read_project_registry",
      schema_version: "1.0",
    });
    expect(PHASE0_TOOL_SCHEMAS.route_agent).toMatchObject({
      name: "route_agent",
      schema_version: "1.0",
      input_schema: expect.objectContaining({
        required: ["request"],
      }),
      output_schema: expect.objectContaining({
        required: ["target"],
      }),
    });
    expect(PHASE0_TOOL_SCHEMAS.dispatch_message).toMatchObject({
      name: "dispatch_message",
      schema_version: "1.0",
      input_schema: expect.objectContaining({
        required: ["target", "message"],
      }),
      output_schema: expect.objectContaining({
        required: ["ok"],
      }),
    });
    expect(PHASE0_TOOL_SCHEMAS.ack_bus).toMatchObject({
      name: "ack_bus",
      schema_version: "1.0",
      output_schema: expect.objectContaining({
        required: ["ok", "subscriber", "acknowledged"],
      }),
    });
    expect(PHASE0_TOOL_SCHEMAS.launch_agent).toMatchObject({
      name: "launch_agent",
      schema_version: "1.0",
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
      input_schema: expect.objectContaining({
        required: ["agent"],
      }),
      output_schema: expect.objectContaining({
        required: ["ok"],
      }),
    });
    expect(PHASE0_TOOL_SCHEMAS.rename_agent).toMatchObject({
      name: "rename_agent",
      schema_version: "1.0",
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
    });
    expect(PHASE0_TOOL_SCHEMAS.close_agent).toMatchObject({
      name: "close_agent",
      schema_version: "1.0",
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
    });
    expect(PHASE0_TOOL_SCHEMAS.manage_cron).toMatchObject({
      name: "manage_cron",
      schema_version: "1.0",
      allowed_tiers: [CALLER_TIERS.CONTROLLER],
    });
  });

  test("tier2 tools remain controller-only", () => {
    expect(listToolsForCallerTier(CALLER_TIERS.WORKER)).not.toContainEqual(
      expect.objectContaining({ name: "launch_agent" })
    );
    expect(listToolsForCallerTier(CALLER_TIERS.WORKER)).not.toContainEqual(
      expect.objectContaining({ name: "rename_agent" })
    );
    expect(listToolsForCallerTier(CALLER_TIERS.WORKER)).not.toContainEqual(
      expect.objectContaining({ name: "close_agent" })
    );
    expect(listToolsForCallerTier(CALLER_TIERS.WORKER)).not.toContainEqual(
      expect.objectContaining({ name: "manage_cron" })
    );
  });

  test("assertToolAllowedForCallerTier enforces identity gating with audit fields", () => {
    expect(() =>
      assertToolAllowedForCallerTier("launch_agent", CALLER_TIERS.WORKER, {
        turn_id: "t-42",
        tool_call_id: "call-9",
      })
    ).toThrow(
      expect.objectContaining({
        code: "forbidden_caller_tier",
        caller_tier: "worker",
        tool_name: "launch_agent",
        turn_id: "t-42",
        tool_call_id: "call-9",
      })
    );

    expect(() =>
      assertToolAllowedForCallerTier("launch_agent", CALLER_TIERS.CONTROLLER)
    ).not.toThrow();

    expect(() =>
      assertToolAllowedForCallerTier("does_not_exist", CALLER_TIERS.CONTROLLER)
    ).toThrow(expect.objectContaining({ code: "unsupported_tool" }));
  });

  test("assertCallerTierAllowed rejects worker on tier2 tools", () => {
    const launch = getToolDefinition("launch_agent");
    expect(() => assertCallerTierAllowed(launch, CALLER_TIERS.WORKER)).toThrow(
      expect.objectContaining({
        code: "forbidden_caller_tier",
        caller_tier: "worker",
        allowed_tiers: [CALLER_TIERS.CONTROLLER],
      })
    );

    const summary = getToolDefinition("read_bus_summary");
    expect(() => assertCallerTierAllowed(summary, CALLER_TIERS.WORKER)).not.toThrow();
  });
});

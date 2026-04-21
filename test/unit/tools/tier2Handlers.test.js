const {
  launchAgentHandler,
  renameAgentHandler,
  closeAgentHandler,
  manageCronHandler,
} = require("../../../src/tools/handlers/tier2");

describe("tier2 tool handlers", () => {
  const controllerCtx = (extra = {}) => ({
    projectRoot: "/tmp/project",
    callerTier: "controller",
    turn_id: "turn-1",
    tool_call_id: "call-1",
    ...extra,
  });

  test("launch_agent forwards a launch op through handleOps", async () => {
    const handleOps = jest.fn().mockResolvedValue([{ action: "launch", ok: true }]);

    const result = await launchAgentHandler(
      controllerCtx({ handleOps }),
      { agent: "codex", count: 2, nickname: "worker-1", prompt_profile: "implementation-lead" }
    );

    expect(handleOps).toHaveBeenCalledWith("/tmp/project", [{
      action: "launch",
      agent: "codex",
      count: 2,
      nickname: "worker-1",
      prompt_profile: "implementation-lead",
    }], null);
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      operation: expect.objectContaining({ action: "launch", agent: "codex" }),
      audit: expect.objectContaining({
        turn_id: "turn-1",
        tool_call_id: "call-1",
        caller_tier: "controller",
      }),
    }));
  });

  test("rename_agent validates required fields and forwards op", async () => {
    const handleOps = jest.fn().mockResolvedValue([{ action: "rename", ok: true }]);

    const result = await renameAgentHandler(
      controllerCtx({ handleOps }),
      { agent_id: "codex:1", nickname: "architect" }
    );

    expect(handleOps).toHaveBeenCalledWith("/tmp/project", [{
      action: "rename",
      agent_id: "codex:1",
      nickname: "architect",
    }], null);
    expect(result.ok).toBe(true);

    await expect(
      renameAgentHandler(controllerCtx({ handleOps }), { agent_id: "codex:1" })
    ).rejects.toMatchObject({
      code: "invalid_arguments",
      tool_name: "rename_agent",
      turn_id: "turn-1",
      tool_call_id: "call-1",
    });
  });

  test("close_agent validates and forwards close op", async () => {
    const handleOps = jest.fn().mockResolvedValue([{ action: "close", ok: true }]);

    const result = await closeAgentHandler(
      controllerCtx({ handleOps }),
      { agent_id: "codex:1" }
    );

    expect(handleOps).toHaveBeenCalledWith("/tmp/project", [{
      action: "close",
      agent_id: "codex:1",
    }], null);
    expect(result.ok).toBe(true);
  });

  test("manage_cron validates operation and forwards cron op", async () => {
    const handleOps = jest.fn().mockResolvedValue([{ action: "cron", ok: true }]);

    const result = await manageCronHandler(
      controllerCtx({ handleOps }),
      { operation: "start", every: "30m", target: "codex:1", prompt: "check logs", title: "Log Watch" }
    );

    expect(handleOps).toHaveBeenCalledWith("/tmp/project", [{
      action: "cron",
      operation: "start",
      every: "30m",
      target: "codex:1",
      prompt: "check logs",
      title: "Log Watch",
    }], null);
    expect(result.ok).toBe(true);

    await expect(
      manageCronHandler(controllerCtx({ handleOps }), {})
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  test("tier2 handlers require a handleOps hook", async () => {
    await expect(
      launchAgentHandler(controllerCtx(), { agent: "codex" })
    ).rejects.toMatchObject({
      code: "tool_unavailable",
      tool_name: "launch_agent",
      turn_id: "turn-1",
      tool_call_id: "call-1",
    });
  });

  describe("caller_tier gating", () => {
    const handleOps = jest.fn();
    const workerCtx = (extra = {}) => ({
      projectRoot: "/tmp/project",
      handleOps,
      callerTier: "worker",
      turn_id: "turn-99",
      tool_call_id: "call-42",
      ...extra,
    });

    beforeEach(() => {
      handleOps.mockReset();
    });

    test("launch_agent rejects worker caller_tier before dispatching handleOps", async () => {
      await expect(
        launchAgentHandler(workerCtx(), { agent: "codex" })
      ).rejects.toMatchObject({
        code: "forbidden_caller_tier",
        tool_name: "launch_agent",
        caller_tier: "worker",
        turn_id: "turn-99",
        tool_call_id: "call-42",
        allowed_tiers: ["controller"],
      });
      expect(handleOps).not.toHaveBeenCalled();
    });

    test("rename_agent rejects worker caller_tier", async () => {
      await expect(
        renameAgentHandler(workerCtx(), { agent_id: "codex:1", nickname: "arch" })
      ).rejects.toMatchObject({
        code: "forbidden_caller_tier",
        tool_name: "rename_agent",
        caller_tier: "worker",
      });
      expect(handleOps).not.toHaveBeenCalled();
    });

    test("close_agent rejects worker caller_tier", async () => {
      await expect(
        closeAgentHandler(workerCtx(), { agent_id: "codex:1" })
      ).rejects.toMatchObject({
        code: "forbidden_caller_tier",
        tool_name: "close_agent",
        caller_tier: "worker",
      });
      expect(handleOps).not.toHaveBeenCalled();
    });

    test("manage_cron rejects worker caller_tier", async () => {
      await expect(
        manageCronHandler(workerCtx(), { operation: "start" })
      ).rejects.toMatchObject({
        code: "forbidden_caller_tier",
        tool_name: "manage_cron",
        caller_tier: "worker",
      });
      expect(handleOps).not.toHaveBeenCalled();
    });

    test("defaults to controller when caller_tier is omitted (back-compat)", async () => {
      handleOps.mockResolvedValue([{ action: "launch", ok: true }]);
      const result = await launchAgentHandler(
        { projectRoot: "/tmp/project", handleOps },
        { agent: "codex" }
      );
      expect(result.ok).toBe(true);
    });
  });
});

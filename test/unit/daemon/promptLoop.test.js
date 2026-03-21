const { runPromptWithAssistant } = require("../../../src/daemon/promptLoop");

describe("daemon prompt loop", () => {
  test("handles prompt without assistant_call", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "ok",
        dispatch: [{ target: "codex:1", message: "do" }],
        ops: [{ action: "launch", agent: "codex", count: 1 }],
      },
    });
    const runAssistantTask = jest.fn();
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([{ action: "launch", ok: true }]);
    const markPending = jest.fn();

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "run",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      runAssistantTask,
      dispatchMessages,
      handleOps,
      markPending,
    });

    expect(result.ok).toBe(true);
    expect(result.payload.reply).toBe("ok");
    expect(runAssistantTask).not.toHaveBeenCalled();
    expect(markPending).toHaveBeenCalledWith("codex:1");
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [{ target: "codex:1", message: "do" }]);
    expect(handleOps).toHaveBeenCalledWith(
      "/tmp/project",
      [{ action: "launch", agent: "codex", count: 1 }],
      null
    );
  });

  test("executes assistant_call then re-runs ufoo-agent with reports", async () => {
    const runUfooAgent = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "checking",
          dispatch: [],
          ops: [],
          assistant_call: { kind: "explore", task: "scan repo" },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "done",
          dispatch: [{ target: "broadcast", message: "summary" }],
          ops: [{ action: "rename", agent_id: "codex:1", nickname: "coder" }],
        },
      });
    const runAssistantTask = jest.fn().mockResolvedValue({
      ok: true,
      summary: "found files",
      artifacts: ["tree"],
      logs: [],
      metrics: { duration_ms: 10 },
    });
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([{ action: "rename", ok: true }]);
    const reportTaskStatus = jest.fn().mockResolvedValue(undefined);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "inspect project",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      runAssistantTask,
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
      reportTaskStatus,
    });

    expect(result.ok).toBe(true);
    expect(runUfooAgent).toHaveBeenCalledTimes(2);
    expect(runAssistantTask).toHaveBeenCalledTimes(1);
    expect(runAssistantTask).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "",
        fallbackProvider: "codex-cli",
      }),
    );
    expect(runUfooAgent.mock.calls[1][0].prompt).toContain("Assistant execution reports");
    expect(result.payload.assistant.runs).toHaveLength(1);
    expect(result.payload.ops).toEqual([{ action: "rename", agent_id: "codex:1", nickname: "coder" }]);
    expect(result.payload.assistant_call).toBeUndefined();
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [{ target: "broadcast", message: "summary" }]);
    expect(reportTaskStatus).toHaveBeenCalledTimes(2);
    expect(reportTaskStatus.mock.calls[0][0]).toEqual(expect.objectContaining({
      phase: "start",
      agent_id: "ufoo-assistant-agent",
      message: "scan repo",
    }));
    expect(reportTaskStatus.mock.calls[1][0]).toEqual(expect.objectContaining({
      phase: "done",
      agent_id: "ufoo-assistant-agent",
      summary: "found files",
    }));
  });

  test("falls back to round1 payload when assistant_call fails", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "draft",
        dispatch: [{ target: "codex:2", message: "plan" }],
        ops: [{ action: "launch", agent: "codex", count: 1 }],
        assistant_call: { task: "scan", kind: "explore" },
      },
    });
    const runAssistantTask = jest.fn().mockResolvedValue({
      ok: false,
      error: "timeout",
    });
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([{ action: "launch", ok: true }]);
    const reportTaskStatus = jest.fn().mockResolvedValue(undefined);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "inspect",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      runAssistantTask,
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
      reportTaskStatus,
    });

    expect(result.ok).toBe(true);
    expect(runUfooAgent).toHaveBeenCalledTimes(1);
    expect(runAssistantTask).toHaveBeenCalledTimes(1);
    expect(result.payload.reply).toBe("draft");
    expect(result.payload.assistant).toBeUndefined();
    expect(result.payload.assistant_call).toBeUndefined();
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [{ target: "codex:2", message: "plan" }]);
    expect(reportTaskStatus).toHaveBeenCalledTimes(2);
    expect(reportTaskStatus.mock.calls[1][0]).toEqual(expect.objectContaining({
      phase: "error",
      error: "timeout",
    }));
  });

  test("annotates fallback reply when assistant_call fails and no actions are present", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "已安排创建",
        dispatch: [],
        ops: [],
        assistant_call: { task: "create cron", kind: "mixed" },
      },
    });
    const runAssistantTask = jest.fn().mockResolvedValue({
      ok: false,
      error: "assistant timeout",
    });
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([]);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "create cron",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      runAssistantTask,
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
      reportTaskStatus: jest.fn().mockResolvedValue(undefined),
    });

    expect(result.ok).toBe(true);
    expect(result.payload.reply).toContain("已安排创建");
    expect(result.payload.reply).toContain("Assistant execution failed: assistant timeout");
    expect(result.payload.reply).toContain("No action was applied.");
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", []);
    expect(handleOps).toHaveBeenCalledWith("/tmp/project", [], null);
  });

  test("falls back to round1 payload when round2 fails", async () => {
    const runUfooAgent = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "draft",
          dispatch: [{ target: "codex:2", message: "plan" }],
          ops: [{ action: "launch", agent: "codex", count: 1 }],
          assistant_call: { task: "scan", kind: "explore" },
        },
      })
      .mockResolvedValueOnce({ ok: false, error: "round2 failed" });
    const runAssistantTask = jest.fn().mockResolvedValue({
      ok: true,
      summary: "ok",
    });
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([{ action: "launch", ok: true }]);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "inspect",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      runAssistantTask,
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
    });

    expect(result.ok).toBe(true);
    expect(runUfooAgent).toHaveBeenCalledTimes(2);
    expect(runAssistantTask).toHaveBeenCalledTimes(1);
    expect(result.payload.reply).toBe("draft");
    expect(result.payload.assistant).toBeUndefined();
    expect(result.payload.assistant_call).toBeUndefined();
  });

  test("ignores assistant_call requested in round2 payload", async () => {
    const runUfooAgent = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "draft",
          dispatch: [],
          ops: [],
          assistant_call: { task: "scan", kind: "explore" },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        payload: {
          reply: "final",
          dispatch: [],
          ops: [{ action: "assistant_call", task: "ignore" }],
          assistant_call: { task: "ignore-too" },
        },
      });
    const runAssistantTask = jest.fn().mockResolvedValue({ ok: true, summary: "ok" });
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([]);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "inspect",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      runAssistantTask,
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
    });

    expect(result.ok).toBe(true);
    expect(runUfooAgent).toHaveBeenCalledTimes(2);
    expect(runAssistantTask).toHaveBeenCalledTimes(1);
    expect(result.payload.reply).toBe("final");
    expect(result.payload.ops).toEqual([]);
    expect(result.payload.assistant_call).toBeUndefined();
  });

  test("passes ufooAgentOptions and skips local execution when finalizeLocally is false", async () => {
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "route to project",
        dispatch: [{ target: "codex:1", message: "should not send" }],
        ops: [{ action: "launch", agent: "codex", count: 1 }],
        project_route: { project_root: "/tmp/project-a", prompt: "handle billing bug" },
      },
    });
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([]);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "route it",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      runAssistantTask: jest.fn(),
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
      finalizeLocally: false,
      ufooAgentOptions: { routingMode: "global-router" },
    });

    expect(result.ok).toBe(true);
    expect(runUfooAgent).toHaveBeenCalledWith(expect.objectContaining({
      routingMode: "global-router",
    }));
    expect(dispatchMessages).not.toHaveBeenCalled();
    expect(handleOps).not.toHaveBeenCalled();
    expect(result.payload.project_route).toEqual({
      project_root: "/tmp/project-a",
      prompt: "handle billing bug",
    });
  });
});

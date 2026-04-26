const {
  runPromptWithAssistant,
  stripAssistantCall,
} = require("../../../src/daemon/promptLoop");

describe("daemon promptLoop", () => {
  test("finalizes single-pass agent payloads without helper execution", async () => {
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([{ action: "launch", ok: true }]);
    const markPending = jest.fn();
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "done",
        dispatch: [{ target: "codex:1", message: "take this" }],
        ops: [{ action: "launch", agent: "codex" }],
      },
    });

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "route this",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages,
      handleOps,
      markPending,
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        reply: "done",
        dispatch: [{ target: "codex:1", message: "take this" }],
        ops: [{ action: "launch", agent: "codex" }],
      },
      opsResults: [{ action: "launch", ok: true }],
    });
    expect(runUfooAgent).toHaveBeenCalledTimes(1);
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [
      { target: "codex:1", message: "take this" },
    ]);
    expect(handleOps).toHaveBeenCalledWith("/tmp/project", [{ action: "launch", agent: "codex" }], null);
    expect(markPending).toHaveBeenCalledWith("codex:1");
  });

  test("launches before dispatching to the newly launched subscriber", async () => {
    const calls = [];
    const dispatchMessages = jest.fn().mockImplementation(async () => {
      calls.push("dispatch");
    });
    const handleOps = jest.fn().mockImplementation(async () => {
      calls.push("ops");
      return [{ action: "launch", ok: true, subscriber_ids: ["codex:new1"] }];
    });
    const markPending = jest.fn();
    const runUfooAgent = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "launching",
        dispatch: [{ target: "worker", message: "take this" }],
        ops: [{ action: "launch", agent: "codex", nickname: "worker" }],
      },
    });

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "route this",
      provider: "codex-cli",
      model: "",
      runUfooAgent,
      dispatchMessages,
      handleOps,
      markPending,
    });

    expect(calls).toEqual(["ops", "dispatch"]);
    expect(handleOps).toHaveBeenCalledWith("/tmp/project", [
      { action: "launch", agent: "codex", nickname: "worker" },
    ], null);
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [
      { target: "codex:new1", message: "take this" },
    ]);
    expect(markPending).toHaveBeenCalledWith("codex:new1");
    expect(result.payload.dispatch).toEqual([{ target: "codex:new1", message: "take this" }]);
  });

  test("synthesizes task dispatch for launch-only router payloads", async () => {
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([
      { action: "launch", ok: true, subscriber_ids: ["codex:new2"] },
    ]);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "Fix the router launch bug\n\nRouting request metadata (JSON):\n{\"source\":\"chat-dialog\"}",
      provider: "codex-cli",
      model: "",
      runUfooAgent: jest.fn().mockResolvedValue({
        ok: true,
        payload: {
          reply: "",
          dispatch: [],
          ops: [{ action: "launch", agent: "codex", nickname: "route-fix" }],
        },
      }),
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
    });

    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [{
      target: "codex:new2",
      message: "Fix the router launch bug",
      injection_mode: "immediate",
      source: "ufoo-agent",
    }]);
    expect(result.payload.dispatch).toEqual([{
      target: "codex:new2",
      message: "Fix the router launch bug",
      injection_mode: "immediate",
      source: "ufoo-agent",
    }]);
  });

  test("drops launch-only payloads when there is no task to deliver", async () => {
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const handleOps = jest.fn().mockResolvedValue([{ action: "launch", ok: true }]);

    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "",
      provider: "codex-cli",
      model: "",
      runUfooAgent: jest.fn().mockResolvedValue({
        ok: true,
        payload: {
          reply: "",
          dispatch: [],
          ops: [{ action: "launch", agent: "codex" }],
        },
      }),
      dispatchMessages,
      handleOps,
      markPending: jest.fn(),
    });

    expect(handleOps).not.toHaveBeenCalled();
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", []);
    expect(result.payload.ops).toEqual([]);
  });

  test("strips top-level and ops assistant_call payloads", () => {
    expect(stripAssistantCall({
      reply: "done",
      assistant_call: { task: "scan repo" },
      dispatch: [],
      ops: [
        { action: "assistant_call", task: "ignore" },
        { action: "launch", agent: "codex" },
      ],
    })).toEqual({
      reply: "done",
      dispatch: [],
      ops: [{ action: "launch", agent: "codex" }],
    });
  });

  test("returns payload only when finalizeLocally is false", async () => {
    const dispatchMessages = jest.fn();
    const handleOps = jest.fn();
    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "route this",
      provider: "codex-cli",
      model: "",
      runUfooAgent: jest.fn().mockResolvedValue({
        ok: true,
        payload: { reply: "done", dispatch: [], ops: [] },
      }),
      dispatchMessages,
      handleOps,
      finalizeLocally: false,
    });

    expect(result).toEqual({
      ok: true,
      payload: { reply: "done", dispatch: [], ops: [] },
      opsResults: [],
    });
    expect(dispatchMessages).not.toHaveBeenCalled();
    expect(handleOps).not.toHaveBeenCalled();
  });

  test("upgrades from main router to loop router when requested", async () => {
    const runPromptWithControllerLoop = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "loop", dispatch: [], ops: [], loop: { terminal_reason: "completed" } },
      opsResults: [],
    });
    const result = await runPromptWithAssistant({
      projectRoot: "/tmp/project",
      prompt: "review this",
      provider: "codex-cli",
      model: "",
      runUfooAgent: jest.fn().mockResolvedValue({
        ok: true,
        payload: {
          reply: "",
          dispatch: [],
          ops: [],
          upgrade_to_loop_router: true,
        },
      }),
      runPromptWithControllerLoop,
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      loopRuntime: {
        enabled: true,
        maxRounds: 3,
        maxToolCalls: 3,
      },
    });

    expect(result).toEqual({
      ok: true,
      payload: { reply: "loop", dispatch: [], ops: [], loop: { terminal_reason: "completed" } },
      opsResults: [],
    });
    expect(runPromptWithControllerLoop).toHaveBeenCalledTimes(1);
    expect(runPromptWithControllerLoop).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: "/tmp/project",
      prompt: "review this",
      loopRuntime: expect.objectContaining({ enabled: true }),
    }));
  });
});

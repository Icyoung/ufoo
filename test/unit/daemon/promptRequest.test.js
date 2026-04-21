const fs = require("fs");
const os = require("os");
const path = require("path");
const { IPC_RESPONSE_TYPES } = require("../../../src/shared/eventContract");
const { handlePromptRequest } = require("../../../src/daemon/promptRequest");
jest.mock("../../../src/projects", () => ({
  isGlobalControllerProjectRoot: jest.fn(() => false),
}));
const {
  normalizeReportInput,
  appendControllerInboxEntry,
  listControllerInboxEntries,
} = require("../../../src/report/store");
const { isGlobalControllerProjectRoot } = require("../../../src/projects");

function parseWritePayload(writeCallArg) {
  const line = String(writeCallArg || "").trim();
  return JSON.parse(line);
}

describe("daemon promptRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.UFOO_AGENT_RUNTIME_MODE;
    delete process.env.UFOO_AGENT_ENABLE_LOOP;
    isGlobalControllerProjectRoot.mockReturnValue(false);
  });

  test("writes response payload on successful prompt handling", async () => {
    const socket = { write: jest.fn() };
    const log = jest.fn();
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "done", dispatch: [], ops: [] },
      opsResults: [{ action: "launch", ok: true }],
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: { text: "run task" },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log,
    });

    expect(ok).toBe(true);
    expect(runPromptWithAssistant).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/tmp/project",
        prompt: "run task",
        maxAssistantLoops: 2,
      }),
    );
    expect(socket.write).toHaveBeenCalledTimes(1);
    const msg = parseWritePayload(socket.write.mock.calls[0][0]);
    expect(msg).toEqual({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: { reply: "done", dispatch: [], ops: [] },
      opsResults: [{ action: "launch", ok: true }],
    });
  });

  test("writes error when prompt loop returns failure", async () => {
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: false,
      error: "agent failed",
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: { text: "run task" },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(false);
    const msg = parseWritePayload(socket.write.mock.calls[0][0]);
    expect(msg).toEqual({
      type: IPC_RESPONSE_TYPES.ERROR,
      error: "agent failed",
    });
  });

  test("writes error when prompt loop throws", async () => {
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest
      .fn()
      .mockRejectedValue(new Error("boom"));

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: { text: "run task" },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(false);
    const msg = parseWritePayload(socket.write.mock.calls[0][0]);
    expect(msg).toEqual({
      type: IPC_RESPONSE_TYPES.ERROR,
      error: "boom",
    });
  });

  test("injects private inbox reports into prompt and clears inbox after success", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-prompt-report-"));
    appendControllerInboxEntry(projectRoot, "ufoo-agent", normalizeReportInput({
      phase: "start",
      task_id: "task-1",
      agent_id: "codex:1",
      message: "scan repo",
      scope: "private",
    }));

    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "done", dispatch: [], ops: [] },
      opsResults: [],
    });

    const ok = await handlePromptRequest({
      projectRoot,
      req: { text: "analyze project" },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    const calledPrompt = runPromptWithAssistant.mock.calls[0][0].prompt;
    expect(calledPrompt).toContain("Private runtime reports for ufoo-agent");
    expect(calledPrompt).toContain("\"task_id\": \"task-1\"");
    expect(calledPrompt).toContain("control-plane observability");
    expect(calledPrompt).toContain("do not dispatch that handoff again");
    expect(listControllerInboxEntries(projectRoot, "ufoo-agent")).toHaveLength(0);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("appends request metadata for chat dialog routing", async () => {
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "done", dispatch: [], ops: [] },
      opsResults: [],
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: {
        text: "route this",
        request_meta: {
          source: "chat-dialog",
          dispatch_default_injection_mode: "immediate",
          allow_relevance_queue: true,
        },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    const calledPrompt = runPromptWithAssistant.mock.calls[0][0].prompt;
    expect(calledPrompt).toContain("Routing request metadata (JSON)");
    expect(calledPrompt).toContain("\"source\": \"chat-dialog\"");
    expect(calledPrompt).toContain("\"dispatch_default_injection_mode\": \"immediate\"");
  });

  test("keeps in-flight private reports appended during handling", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-prompt-report-inflight-"));
    appendControllerInboxEntry(projectRoot, "ufoo-agent", normalizeReportInput({
      phase: "start",
      task_id: "task-old",
      agent_id: "codex:1",
      message: "old",
      scope: "private",
    }));

    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockImplementation(async () => {
      appendControllerInboxEntry(projectRoot, "ufoo-agent", normalizeReportInput({
        phase: "progress",
        task_id: "task-new",
        agent_id: "codex:2",
        message: "new",
        scope: "private",
      }));
      return {
        ok: true,
        payload: { reply: "done", dispatch: [], ops: [] },
        opsResults: [],
      };
    });

    const ok = await handlePromptRequest({
      projectRoot,
      req: { text: "analyze project" },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    const rows = listControllerInboxEntries(projectRoot, "ufoo-agent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      task_id: "task-new",
      message: "new",
    }));
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("global controller uses router mode then proxies prompt to target project", async () => {
    isGlobalControllerProjectRoot.mockReturnValue(true);
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        reply: "routing",
        project_route: {
          project_root: "/tmp/project-a",
          project_name: "alpha",
          prompt: "Handle billing fix",
          reason: "billing ownership",
        },
        dispatch: [{ target: "codex:1", message: "ignore" }],
        ops: [{ action: "launch", agent: "codex", count: 1 }],
      },
      opsResults: [],
    });
    const forwardProjectPrompt = jest.fn().mockResolvedValue({
      ok: true,
      project_root: "/tmp/project-a",
      project_name: "alpha",
      payload: { reply: "done", dispatch: [{ target: "codex:1", message: "do" }], ops: [] },
      opsResults: [{ action: "launch", ok: true }],
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/controller",
      req: { text: "fix billing issue" },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      reportTaskStatus: jest.fn(),
      forwardProjectPrompt,
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runPromptWithAssistant).toHaveBeenCalledWith(expect.objectContaining({
      ufooAgentOptions: { routingMode: "global-router" },
      finalizeLocally: false,
    }));
    expect(forwardProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({
      targetProjectRoot: "/tmp/project-a",
      targetProjectName: "alpha",
      prompt: "Handle billing fix",
      routeReason: "billing ownership",
    }));
    const msg = parseWritePayload(socket.write.mock.calls[0][0]);
    expect(msg).toEqual({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "done",
        dispatch: [{ target: "codex:1", message: "do" }],
        ops: [],
        routed_project: {
          project_root: "/tmp/project-a",
          project_name: "alpha",
          reason: "billing ownership",
        },
      },
      opsResults: [{ action: "launch", ok: true }],
    });
  });

  test("global controller can directly forward to forced project root", async () => {
    isGlobalControllerProjectRoot.mockReturnValue(true);
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn();
    const forwardProjectPrompt = jest.fn().mockResolvedValue({
      ok: true,
      project_root: "/tmp/project-b",
      project_name: "beta",
      payload: { reply: "project reply", dispatch: [], ops: [] },
      opsResults: [],
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/controller",
      req: {
        text: "Use agent codex:1 to handle: analyze this",
        request_meta: {
          source: "chat-dialog",
          force_project_root: "/tmp/project-b",
        },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      reportTaskStatus: jest.fn(),
      forwardProjectPrompt,
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runPromptWithAssistant).not.toHaveBeenCalled();
    expect(forwardProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({
      targetProjectRoot: "/tmp/project-b",
      routeReason: "forced_project_root",
    }));
    const msg = parseWritePayload(socket.write.mock.calls[0][0]);
    expect(msg.data.routed_project).toEqual({
      project_root: "/tmp/project-b",
      project_name: "beta",
      reason: "forced_project_root",
    });
  });

  test("main gate router dispatches pure routing requests without main router fallback", async () => {
    const socket = { write: jest.fn() };
    const dispatchMessages = jest.fn().mockResolvedValue(undefined);
    const runPromptWithAssistant = jest.fn();
    const runUfooRouteAgent = jest.fn().mockResolvedValue({
      ok: true,
      route: {
        decision: "direct_dispatch",
        target: "reviewer",
        message: "Continue with the current review thread",
        confidence: 0.91,
        reason: "prompt continuity",
        injection_mode: "immediate",
      },
      meta: {
        provider: "openai",
        model: "gpt-4o-mini",
      },
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: {
        text: "Continue with reviewer on the current review thread",
        request_meta: { agent_execution_path: "main" },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runUfooRouteAgent,
      runAssistantTask: jest.fn(),
      dispatchMessages,
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runUfooRouteAgent).toHaveBeenCalledTimes(1);
    expect(runPromptWithAssistant).not.toHaveBeenCalled();
    expect(dispatchMessages).toHaveBeenCalledWith("/tmp/project", [{
      target: "reviewer",
      message: "Continue with the current review thread",
      injection_mode: "immediate",
      source: "ufoo-agent-gate-router",
    }]);
    expect(parseWritePayload(socket.write.mock.calls[0][0])).toEqual({
      type: IPC_RESPONSE_TYPES.RESPONSE,
      data: {
        reply: "",
        dispatch: [{
          target: "reviewer",
          message: "Continue with the current review thread",
          injection_mode: "immediate",
          source: "ufoo-agent-gate-router",
        }],
        ops: [],
      },
      opsResults: [],
    });
  });

  test("main upgrades to main router when gate router returns an upgrade decision", async () => {
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "legacy", dispatch: [], ops: [] },
      opsResults: [],
    });
    const runUfooRouteAgent = jest.fn().mockResolvedValue({
      ok: true,
      route: {
        decision: "upgrade_to_main_router",
        target: "unknown",
        message: "Send this to the right agent",
        confidence: 0.42,
        reason: "ambiguous target",
        injection_mode: "immediate",
      },
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: {
        text: "Send this to the right agent",
        request_meta: { agent_execution_path: "main" },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runUfooRouteAgent,
      runAssistantTask: jest.fn(),
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runUfooRouteAgent).toHaveBeenCalledTimes(1);
    expect(runPromptWithAssistant).toHaveBeenCalledTimes(1);
    expect(runPromptWithAssistant.mock.calls[0][0].prompt).toContain("\"gate_router\"");
    expect(runPromptWithAssistant.mock.calls[0][0].prompt).toContain("\"decision\": \"upgrade_to_main_router\"");
  });

  test("main upgrades to main router when gate-router dispatch fails", async () => {
    const socket = { write: jest.fn() };
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "legacy", dispatch: [], ops: [] },
      opsResults: [],
    });
    const runUfooRouteAgent = jest.fn().mockResolvedValue({
      ok: true,
      route: {
        decision: "direct_dispatch",
        target: "reviewer",
        message: "Continue with reviewer",
        confidence: 0.88,
        reason: "continuity",
        injection_mode: "immediate",
      },
    });
    const dispatchMessages = jest.fn().mockRejectedValue(new Error("target not found"));

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: {
        text: "Continue with reviewer",
        request_meta: { agent_execution_path: "main" },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runUfooAgent: jest.fn(),
      runUfooRouteAgent,
      runAssistantTask: jest.fn(),
      dispatchMessages,
      handleOps: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(dispatchMessages).toHaveBeenCalledTimes(1);
    expect(runPromptWithAssistant).toHaveBeenCalledTimes(1);
    expect(runPromptWithAssistant.mock.calls[0][0].prompt).toContain("\"reason\": \"dispatch_failed\"");
    expect(runPromptWithAssistant.mock.calls[0][0].prompt).toContain("\"error\": \"target not found\"");
  });

  test("loop mode still attempts gate router first and upgrades through main router", async () => {
    process.env.UFOO_AGENT_ENABLE_LOOP = "1";
    const socket = { write: jest.fn() };
    const runPromptWithControllerLoop = jest.fn();
    const runPromptWithAssistant = jest.fn().mockResolvedValue({
      ok: true,
      payload: { reply: "main", dispatch: [], ops: [] },
      opsResults: [],
    });
    const runUfooRouteAgent = jest.fn().mockResolvedValue({
      ok: true,
      route: {
        decision: "upgrade_to_main_router",
        target: "unknown",
        message: "Review the current codebase",
        confidence: 0.31,
        reason: "needs tool-assisted exploration",
        injection_mode: "immediate",
      },
    });

    const ok = await handlePromptRequest({
      projectRoot: "/tmp/project",
      req: {
        text: "让reviewer审核当前代码",
        request_meta: { agent_execution_path: "loop" },
      },
      socket,
      provider: "codex-cli",
      model: "",
      runPromptWithAssistant,
      runPromptWithControllerLoop,
      runUfooAgent: jest.fn(),
      runUfooRouteAgent,
      dispatchMessages: jest.fn(),
      handleOps: jest.fn(),
      ackBus: jest.fn(),
      markPending: jest.fn(),
      log: jest.fn(),
    });

    expect(ok).toBe(true);
    expect(runUfooRouteAgent).toHaveBeenCalledTimes(1);
    expect(runPromptWithAssistant).toHaveBeenCalledTimes(1);
    expect(runPromptWithControllerLoop).not.toHaveBeenCalled();
    expect(runPromptWithAssistant.mock.calls[0][0].prompt).toContain("\"decision\": \"upgrade_to_main_router\"");
  });
});

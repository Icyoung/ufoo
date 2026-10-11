const fs = require("fs");
const os = require("os");
const path = require("path");
const { handlePromptRequest } = require("../../../src/runtime/daemon/promptRequest");
const { IPC_RESPONSE_TYPES } = require("../../../src/runtime/contracts/eventContract");
const { appendControllerInboxEntry, normalizeReportInput, listControllerInboxEntries } = require("../../../src/coordination/report/store");
jest.mock("../../../src/runtime/projects", () => ({ isGlobalControllerProjectRoot: jest.fn(() => false) }));
const { isGlobalControllerProjectRoot } = require("../../../src/runtime/projects");

describe("main agent prompt requests", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-main-prompt-")); isGlobalControllerProjectRoot.mockReturnValue(false); });
  afterEach(() => { jest.clearAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  function harness(overrides = {}) {
    const socket = { write: jest.fn() };
    const runMainAgent = jest.fn().mockResolvedValue({ ok: true, payload: { reply: "done", dispatch: [], ops: [] } });
    const options = { projectRoot: root, socket, runMainAgent, log: jest.fn(), req: { text: "run task", request_id: "request-one" }, ...overrides };
    const response = () => JSON.parse(socket.write.mock.calls.at(-1)[0]);
    return { options, socket, runMainAgent, response };
  }
  function report() {
    appendControllerInboxEntry(root, "ufoo-agent", normalizeReportInput({ agent_id: "codex:worker", phase: "done", task_id: "task-one", summary: "verified" }));
  }
  test("passes the original prompt, session and structured request metadata to the main runtime", async () => {
    const h = harness({ req: { text: "implement it", request_id: "request-one", session_id: "conversation", request_meta: { source: "chat" } } });
    expect(await handlePromptRequest(h.options)).toBe(true);
    expect(h.runMainAgent).toHaveBeenCalledWith({ projectRoot: root, originalPrompt: "implement it", requestId: "request-one", sessionId: "conversation", requestMeta: { source: "chat" } });
    expect(h.socket.write).toHaveBeenCalledTimes(1);
    expect(h.response()).toEqual({ type: IPC_RESPONSE_TYPES.RESPONSE, data: { reply: "done", dispatch: [], ops: [] }, opsResults: [] });
  });
  test("mode metadata never selects another executor", async () => {
    const h = harness({ req: { text: "work", request_meta: { controller_mode: "shadow", agent_execution_path: "legacy", session_id: "existing" } } });
    expect(await handlePromptRequest(h.options)).toBe(true);
    expect(h.runMainAgent).toHaveBeenCalledTimes(1);
    expect(h.runMainAgent.mock.calls[0][0]).toMatchObject({ originalPrompt: "work", sessionId: "existing" });
  });
  test("accepts the protocol prompt field and defaults the main session", async () => {
    const h = harness({ req: { prompt: "protocol prompt", message_id: "message-one" } });
    expect(await handlePromptRequest(h.options)).toBe(true);
    expect(h.runMainAgent.mock.calls[0][0]).toMatchObject({ originalPrompt: "protocol prompt", requestId: "message-one", sessionId: "main-default" });
  });
  test("successful execution consumes reports without appending control metadata to the user prompt", async () => {
    report();
    const h = harness();
    expect(await handlePromptRequest(h.options)).toBe(true);
    expect(h.runMainAgent.mock.calls[0][0].originalPrompt).toBe("run task");
    expect(listControllerInboxEntries(root, "ufoo-agent")).toEqual([]);
  });
  test("runtime failure preserves reports and its error code for inspection", async () => {
    report();
    const h = harness();
    h.runMainAgent.mockResolvedValue({ ok: false, error: "effect outcome unknown", code: "uncertain_effect" });
    expect(await handlePromptRequest(h.options)).toBe(false);
    expect(h.response()).toEqual({ type: IPC_RESPONSE_TYPES.ERROR, error: "effect outcome unknown", code: "uncertain_effect" });
    expect(listControllerInboxEntries(root, "ufoo-agent")).toHaveLength(1);
  });
  test("runtime exceptions produce one error response", async () => {
    const h = harness();
    h.runMainAgent.mockRejectedValue(new Error("provider unavailable"));
    expect(await handlePromptRequest(h.options)).toBe(false);
    expect(h.response()).toMatchObject({ type: IPC_RESPONSE_TYPES.ERROR, error: "provider unavailable" });
    expect(h.socket.write).toHaveBeenCalledTimes(1);
  });
  test("an unavailable main runtime fails instead of using another execution path", async () => {
    const h = harness({ runMainAgent: undefined });
    expect(await handlePromptRequest(h.options)).toBe(false);
    expect(h.response()).toMatchObject({ type: IPC_RESPONSE_TYPES.ERROR, error: "main agent runtime is unavailable" });
  });
  test("a forced global project selection skips model execution", async () => {
    isGlobalControllerProjectRoot.mockReturnValue(true);
    const forwardProjectPrompt = jest.fn().mockResolvedValue({ ok: true, project_root: "/project", project_name: "project", payload: { reply: "project result", runtime: { status: "completed" } } });
    const h = harness({ req: { text: "implement", request_meta: { force_project_root: "/project", force_project_name: "project" } }, forwardProjectPrompt });
    expect(await handlePromptRequest(h.options)).toBe(true);
    expect(h.runMainAgent).not.toHaveBeenCalled();
    expect(forwardProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({ targetProjectRoot: "/project", prompt: "implement", routeReason: "forced_project_root" }));
    expect(h.response().data).toMatchObject({ reply: "project result", runtime: { status: "completed" }, routed_project: { project_root: "/project", reason: "forced_project_root" } });
  });
  test("the global main profile hands off a selected project and returns its result", async () => {
    isGlobalControllerProjectRoot.mockReturnValue(true);
    const forwardProjectPrompt = jest.fn().mockResolvedValue({ ok: true, payload: { reply: "implemented" }, opsResults: [] });
    const h = harness({ forwardProjectPrompt });
    h.runMainAgent.mockResolvedValue({ ok: true, payload: { reply: "routing", project_route: { project_root: "/project", project_name: "project", prompt: "build", reason: "selected" } } });
    expect(await handlePromptRequest(h.options)).toBe(true);
    expect(h.runMainAgent).toHaveBeenCalledTimes(1);
    expect(forwardProjectPrompt).toHaveBeenCalledWith(expect.objectContaining({ targetProjectRoot: "/project", prompt: "build" }));
    expect(h.response().data).toMatchObject({ reply: "implemented", routed_project: { project_root: "/project", reason: "selected" } });
  });
  test("a failed global handoff preserves reports and returns the forwarding error", async () => {
    isGlobalControllerProjectRoot.mockReturnValue(true); report();
    const h = harness({ forwardProjectPrompt: jest.fn().mockResolvedValue({ ok: false, error: "project offline" }) });
    h.runMainAgent.mockResolvedValue({ ok: true, payload: { reply: "", project_route: { project_root: "/project" } } });
    expect(await handlePromptRequest(h.options)).toBe(false);
    expect(h.response()).toMatchObject({ type: IPC_RESPONSE_TYPES.ERROR, error: "project offline" });
    expect(listControllerInboxEntries(root, "ufoo-agent")).toHaveLength(1);
  });
  test("global answers never execute or expose project-local dispatch and ops", async () => {
    isGlobalControllerProjectRoot.mockReturnValue(true);
    const h = harness();
    h.runMainAgent.mockResolvedValue({ ok: true, payload: { reply: "select a project", dispatch: [{ target: "worker" }], ops: [{ action: "launch" }] } });
    expect(await handlePromptRequest(h.options)).toBe(true);
    expect(h.response().data).toEqual({ reply: "select a project", dispatch: [], ops: [] });
  });
});

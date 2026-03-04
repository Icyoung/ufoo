const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/agent/cliRunner", () => ({
  runCliAgent: jest.fn(),
}));

jest.mock("../../../src/agent/normalizeOutput", () => ({
  normalizeCliOutput: jest.fn((value) => String(value || "")),
}));

const { runCliAgent } = require("../../../src/agent/cliRunner");
const { normalizeCliOutput } = require("../../../src/agent/normalizeOutput");
const {
  runAssistantAgentTask,
  parseTaskPayload,
  normalizeAssistantPayload,
  getAssistantSessionStateFile,
} = require("../../../src/assistant/agent");

describe("assistant agent task runner", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-assistant-agent-"));
    jest.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("parseTaskPayload applies defaults", () => {
    const parsed = parseTaskPayload({});
    expect(parsed.provider).toBe("");
    expect(parsed.fallbackProvider).toBe("");
    expect(parsed.kind).toBe("mixed");
    expect(parsed.timeoutMs).toBe(300000);
  });

  test("returns error when task is missing", async () => {
    const result = await runAssistantAgentTask({});
    expect(result.ok).toBe(false);
    expect(result.error).toBe("missing task");
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  test("runs cli agent with assistant schema and parses JSON", async () => {
    runCliAgent.mockResolvedValue({
      ok: true,
      output: "{\"ok\":true,\"summary\":\"done\",\"artifacts\":[\"tree\"],\"logs\":[]}",
    });
    normalizeCliOutput.mockImplementation((value) => String(value));

    const result = await runAssistantAgentTask({
      project_root: projectRoot,
      provider: "claude-cli",
      model: "sonnet",
      task: "scan files",
      kind: "explore",
      timeout_ms: 1234,
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("done");
    expect(result.artifacts).toEqual(["tree"]);
    expect(result.metrics.duration_ms).toEqual(expect.any(Number));
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "sonnet",
        prompt: "scan files",
        cwd: projectRoot,
        timeoutMs: 1234,
        disableSession: false,
        sandbox: "read-only",
        jsonSchema: expect.any(Object),
      })
    );
  });

  test("falls back to summary text when output is non-json", async () => {
    runCliAgent.mockResolvedValue({
      ok: true,
      output: "plain text summary",
    });
    normalizeCliOutput.mockReturnValue("plain text summary");

    const result = await runAssistantAgentTask({
      task: "inspect",
      kind: "bash",
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("plain text summary");
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: "workspace-write",
      })
    );
  });

  test("normalizeAssistantPayload keeps error fallback for invalid input", () => {
    const result = normalizeAssistantPayload(null, "bad");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bad");
  });

  test("reuses assistant session and history on next task", async () => {
    runCliAgent
      .mockResolvedValueOnce({
        ok: true,
        sessionId: "assistant-sess-1",
        output: "{\"ok\":true,\"summary\":\"first\"}",
      })
      .mockResolvedValueOnce({
        ok: true,
        sessionId: "assistant-sess-1",
        output: "{\"ok\":true,\"summary\":\"second\"}",
      });
    normalizeCliOutput.mockImplementation((value) => String(value));

    const first = await runAssistantAgentTask({
      project_root: projectRoot,
      provider: "claude",
      task: "inspect src",
      kind: "explore",
    });
    expect(first.ok).toBe(true);

    const second = await runAssistantAgentTask({
      project_root: projectRoot,
      provider: "claude",
      task: "inspect tests",
      kind: "explore",
    });
    expect(second.ok).toBe(true);

    expect(runCliAgent).toHaveBeenCalledTimes(2);
    expect(runCliAgent.mock.calls[1][0]).toEqual(expect.objectContaining({
      sessionId: "assistant-sess-1",
      prompt: "inspect tests",
    }));

    const stateFile = getAssistantSessionStateFile(projectRoot, "claude");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    expect(state.sessionId).toBe("assistant-sess-1");
    expect(state.engine).toBe("claude");
  });
});

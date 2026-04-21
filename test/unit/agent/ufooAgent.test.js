const fs = require("fs");
const { runUfooAgent, runUfooRouteAgent } = require("../../../src/agent/ufooAgent");

jest.mock("../../../src/agent/cliRunner", () => ({
  runCliAgent: jest.fn(),
}));
jest.mock("../../../src/daemon/status", () => ({
  buildStatus: jest.fn(),
}));
jest.mock("../../../src/agent/normalizeOutput", () => ({
  normalizeCliOutput: jest.fn((value) => String(value || "")),
}));
jest.mock("../../../src/code/nativeRunner", () => ({
  resolveRuntimeConfig: jest.fn(() => ({
    provider: "openai",
    model: "gpt-4o",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test-key",
    transport: "openai-chat",
  })),
  resolveCompletionUrl: jest.fn(() => "https://api.openai.com/v1/chat/completions"),
  resolveAnthropicMessagesUrl: jest.fn(() => "https://api.anthropic.com/v1/messages"),
}));
jest.mock("../../../src/projects/registry", () => ({
  listProjectRuntimes: jest.fn(() => []),
}));

const { runCliAgent } = require("../../../src/agent/cliRunner");
const { buildStatus } = require("../../../src/daemon/status");
const { listProjectRuntimes } = require("../../../src/projects/registry");

describe("ufooAgent prompt schema", () => {
  const projectRoot = "/tmp/ufoo-agent-schema-test";

  beforeEach(() => {
    if (fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(projectRoot, { recursive: true });
    buildStatus.mockReturnValue({ active_meta: [] });
    runCliAgent.mockResolvedValue({
      ok: true,
      sessionId: "sess-1",
      output: "{\"reply\":\"ok\",\"dispatch\":[],\"ops\":[]}",
    });
  });

  afterEach(() => {
    if (fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    jest.clearAllMocks();
  });

  test("does not expose assistant_call in controller prompt schema", async () => {
    const res = await runUfooAgent({
      projectRoot,
      prompt: "inspect project",
      provider: "codex-cli",
      model: "",
    });

    expect(res.ok).toBe(true);
    expect(runCliAgent).toHaveBeenCalledTimes(1);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).not.toContain("\"assistant_call\": {");
    expect(call.systemPrompt).toContain("legacy assistant_call / helper-agent path has been removed");
    expect(call.systemPrompt).toContain("\"injection_mode\":\"immediate|queued (optional)\"");
    expect(call.systemPrompt).toContain("dispatch.injection_mode defaults to immediate when omitted.");
  });

  test("switches to limited loop schema when loop runtime is enabled", async () => {
    const res = await runUfooAgent({
      projectRoot,
      prompt: "inspect project",
      provider: "codex-cli",
      model: "",
      loopRuntime: {
        enabled: true,
        maxRounds: 3,
        remainingToolCalls: 2,
      },
    });

    expect(res.ok).toBe(true);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("limited loop mode");
    expect(call.systemPrompt).toContain("\"tool_call\": {\"id\":\"optional\",\"name\":\"dispatch_message|ack_bus|launch_agent\"");
    expect(call.systemPrompt).toContain("Do not emit assistant_call or ops.assistant_call");
    expect(call.systemPrompt).toContain("remainingToolCalls=2");
  });

  test("keeps assistant_call removed under main controller mode", async () => {
    const res = await runUfooAgent({
      projectRoot,
      prompt: "inspect",
      provider: "codex-cli",
      model: "",
      controllerMode: "main",
    });

    expect(res.ok).toBe(true);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).not.toContain("\"assistant_call\": {");
    expect(call.systemPrompt).toContain("Controller mode=main");
  });

  test("keeps assistant_call removed under loop controller mode (non-loop-runtime path)", async () => {
    const res = await runUfooAgent({
      projectRoot,
      prompt: "inspect",
      provider: "codex-cli",
      model: "",
      controllerMode: "loop",
    });

    expect(res.ok).toBe(true);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).not.toContain("\"assistant_call\": {");
    expect(call.systemPrompt).toContain("Controller mode=loop");
    expect(call.systemPrompt).toContain("\"upgrade_to_loop_router\": true");
  });

  test("keeps assistant_call removed under shadow controller mode", async () => {
    const res = await runUfooAgent({
      projectRoot,
      prompt: "inspect",
      provider: "codex-cli",
      model: "",
      controllerMode: "shadow",
    });

    expect(res.ok).toBe(true);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).not.toContain("\"assistant_call\": {");
    expect(call.systemPrompt).toContain("Controller mode=shadow");
  });

  test("injects activity and report summaries into system prompt context", async () => {
    buildStatus.mockReturnValue({
      active_meta: [
        {
          id: "codex:a1",
          nickname: "worker-1",
          launch_mode: "terminal",
          activity_state: "working",
          activity_since: "2026-03-08T00:00:00.000Z",
        },
        {
          id: "codex:a2",
          nickname: "worker-2",
          launch_mode: "internal",
          activity_state: "ready",
          activity_since: "2026-03-08T00:00:01.000Z",
        },
      ],
      reports: {
        pending_total: 2,
        agents: [
          {
            agent_id: "codex:a1",
            pending_count: 2,
            updated_at: "2026-03-08T00:00:10.000Z",
            last: { phase: "progress", task_id: "task-1", ok: true },
          },
        ],
      },
    });

    const res = await runUfooAgent({
      projectRoot,
      prompt: "assign task",
      provider: "codex-cli",
      model: "",
    });

    expect(res.ok).toBe(true);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("\"activity_state\":\"working\"");
    expect(call.systemPrompt).toContain("\"pending_total\":2");
    expect(call.systemPrompt).toContain("\"busy_count\":1");
    expect(call.systemPrompt).toContain("\"ready_count\":1");
  });

  test("injects per-agent prompt history summary from bus events", async () => {
    buildStatus.mockReturnValue({
      active_meta: [
        {
          id: "codex:a1",
          nickname: "worker-1",
          launch_mode: "terminal",
          activity_state: "idle",
          activity_since: "2026-03-08T00:00:00.000Z",
        },
      ],
      reports: { pending_total: 0, agents: [] },
    });

    const eventsDir = `${projectRoot}/.ufoo/bus/events`;
    fs.mkdirSync(eventsDir, { recursive: true });
    const eventFile = `${eventsDir}/2026-03-08.jsonl`;
    fs.writeFileSync(
      eventFile,
      [
        JSON.stringify({
          timestamp: "2026-03-08T01:00:00.000Z",
          event: "message",
          publisher: "ufoo-agent",
          target: "worker-1",
          data: { message: "Continue fixing daemon reconnection edge case" },
        }),
        JSON.stringify({
          timestamp: "2026-03-08T00:30:00.000Z",
          event: "message",
          publisher: "ufoo-agent",
          target: "worker-1",
          data: { message: "Review previous reconnect patch and add tests" },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const res = await runUfooAgent({
      projectRoot,
      prompt: "route new follow-up",
      provider: "codex-cli",
      model: "",
    });

    expect(res.ok).toBe(true);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("\"agent_prompt_history\"");
    expect(call.systemPrompt).toContain("\"agent_id\":\"codex:a1\"");
    expect(call.systemPrompt).toContain("Continue fixing daemon reconnection edge case");
  });

  test("global-router mode injects registered project routing context", async () => {
    listProjectRuntimes.mockReturnValue([
      {
        project_root: "/tmp/project-alpha",
        project_name: "alpha",
        status: "running",
        last_seen: "2026-03-16T08:00:00.000Z",
      },
    ]);
    buildStatus.mockImplementation((root) => {
      if (root === "/tmp/project-alpha") {
        return {
          active_meta: [
            {
              id: "codex:a1",
              nickname: "alpha-coder",
              launch_mode: "terminal",
              activity_state: "working",
              activity_since: "2026-03-16T08:10:00.000Z",
            },
          ],
          unread: { total: 3 },
          decisions: { open: 2 },
          reports: { pending_total: 1, agents: [] },
          groups: { active: 0 },
        };
      }
      return { active_meta: [], unread: { total: 0 }, decisions: { open: 0 }, reports: { pending_total: 0, agents: [] }, groups: { active: 0 } };
    });

    const res = await runUfooAgent({
      projectRoot,
      prompt: "Fix the billing issue",
      provider: "codex-cli",
      model: "",
      routingMode: "global-router",
    });

    expect(res.ok).toBe(true);
    const call = runCliAgent.mock.calls[0][0];
    expect(call.systemPrompt).toContain("global project router");
    expect(call.systemPrompt).toContain("\"project_route\": {\"project_root\":\"absolute-path\"");
    expect(call.systemPrompt).toContain("Keep dispatch empty in global-router mode");
    expect(call.systemPrompt).toContain("\"project_root\":\"/tmp/project-alpha\"");
    expect(call.systemPrompt).toContain("\"project_name\":\"alpha\"");
    expect(call.systemPrompt).toContain("\"active_count\":1");
  });

  test("ucode provider uses native HTTP path instead of CLI", async () => {
    const responsePayload = { reply: "native ok", dispatch: [], ops: [] };
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(responsePayload) } }],
      }),
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await runUfooAgent({
      projectRoot,
      prompt: "hello",
      provider: "ucode",
      model: "gpt-4o",
    });

    expect(res.ok).toBe(true);
    expect(res.payload.reply).toBe("native ok");
    // Should NOT have called the CLI runner
    expect(runCliAgent).not.toHaveBeenCalled();
    // Should have called fetch
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain("chat/completions");
    const body = JSON.parse(opts.body);
    // System prompt should contain router schema
    const systemMsg = body.messages.find((m) => m.role === "system");
    expect(systemMsg).toBeTruthy();
    expect(systemMsg.content).toContain("ufoo-agent");

    delete global.fetch;
  });

  test("ucode provider strips markdown fence from response", async () => {
    const responsePayload = { reply: "fenced ok", dispatch: [], ops: [] };
    const fenced = "```json\n" + JSON.stringify(responsePayload, null, 2) + "\n```";
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: fenced } }],
      }),
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await runUfooAgent({
      projectRoot,
      prompt: "test fence",
      provider: "ucode",
      model: "gpt-4o",
    });

    expect(res.ok).toBe(true);
    expect(res.payload.reply).toBe("fenced ok");
    expect(runCliAgent).not.toHaveBeenCalled();

    delete global.fetch;
  });

  test("ucode provider handles fetch failure gracefully", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));

    const res = await runUfooAgent({
      projectRoot,
      prompt: "hello",
      provider: "ucode",
      model: "",
    });

    expect(res.ok).toBe(false);
    expect(runCliAgent).not.toHaveBeenCalled();

    delete global.fetch;
  });

  test("runUfooRouteAgent uses the native gate-router path and normalizes the route result", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              target: "reviewer",
              confidence: 0.85,
              reason: "continuity",
            }),
          },
        }],
      }),
    };
    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const res = await runUfooRouteAgent({
      projectRoot,
      prompt: "Continue with reviewer",
      provider: "ucode",
      model: "gpt-4o-mini",
      timeoutMs: 4000,
    });

    expect(res.ok).toBe(true);
    expect(res.route).toEqual({
      decision: "direct_dispatch",
      target: "reviewer",
      confidence: 0.85,
      reason: "continuity",
      message: "Continue with reviewer",
      injection_mode: "immediate",
    });
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    delete global.fetch;
  });
});

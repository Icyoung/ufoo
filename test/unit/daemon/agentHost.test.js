"use strict";

jest.mock("undici", () => ({
  ...jest.requireActual("undici"),
  fetch: (...args) => global.fetch(...args),
}));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAgentHost } = require("../../../src/runtime/daemon/agentHost");

const response = (content, toolCalls = []) => new Response(JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls } }] }), { headers: { "content-type": "application/json" } });
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const credentials = async () => ({ provider: "kimi", model: "test", transport: "openai-chat", baseUrl: "https://runtime.invalid/v1", auth: { apiKey: "isolated-vendor-key" } });

describe("project main agent host", () => {
  let root;
  let host;
  let previousFetch;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-main-host-")); previousFetch = global.fetch; });
  afterEach(async () => { if (host) await host.close(); host = null; global.fetch = previousFetch; jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  const make = (options = {}) => createAgentHost({ projectRoot: root, provider: "kimi", model: "test", resolveProvider: credentials,
    ports: { handleOps: jest.fn(), dispatchMessages: jest.fn() }, ...options });
  test("background exit automatically wakes the same main session without replaying bash", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("background-build", "bash", { command: "sleep 0.1; exit 0", background: true, startupWaitMs: 0 })]))
      .mockResolvedValueOnce(response("等待构建结果。"))
      .mockResolvedValue(response("构建已完成。"));
    host = make();
    const first = await host.runPrompt({ prompt: "请构建，结束后告诉我", requestId: "background-build", sessionId: "build-session" });
    const runtime = host.getSession("build-session");
    expect(host.hasPendingHooks()).toBe(true);
    let wake;
    for (let n = 0; n < 100 && !wake; n++) {
      await runtime.hooks.tick();
      wake = Object.values(runtime.snapshot().tasks).find(task => task.request.runtimeEvent);
      if (!wake) await new Promise(resolve => setTimeout(resolve, 30));
    }
    expect(wake.request.parentTaskRunId).toBe(first.payload.runtime.taskRunId);
    expect((await runtime.wait(wake.taskRunId)).status).toBe("completed");
    expect(runtime.events().filter(event => event.type === "tool.started" && event.toolName === "bash")).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(runtime.events().find(event => event.type === "context.turn_indexed" && event.taskRunId === wake.taskRunId).turnKind).toBe("system_wake");
    expect(host.hasPendingHooks()).toBe(false);
  });
  test("main can inspect daily-browser status without shell execution or opening Chrome", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("browser-status", "browser", { operation: "status" })]))
      .mockResolvedValueOnce(response("Browser connection is not started."));
    host = make();
    const result = await host.runPrompt({ prompt: "inspect browser status", requestId: "browser-status" });
    expect(result.ok).toBe(true);
    expect(host.getSession().tools.names()).toContain("browser");
    const followup = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(JSON.parse(followup.messages.find(message => message.tool_call_id === "browser-status").content)).toMatchObject({ ok: true, state: "disconnected" });
  });
  test("main corrects an invalid delegation target without failing its runtime or creating uncertain effects", async () => {
    const EventBus = require("../../../src/coordination/bus");
    const bus = new EventBus(root);
    await bus.init();
    const ports = { handleOps: jest.fn(async () => {
      await bus.join("worker", "codex", "worker", { launchMode: "internal", parentPid: process.pid });
      return [{ action: "launch", ok: true, subscriber_ids: ["codex:worker"] }];
    }), dispatchMessages: jest.fn(async () => [{ seq: 10, targets: ["codex:worker"] }]) };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("bad", "delegate_task", { command_id: "job", agent: "codex", target: "new-worker", objective: "修复" })]))
      .mockResolvedValueOnce(response(null, [call("good", "delegate_task", { command_id: "job", agent: "codex", nickname: "worker", objective: "修复" })]))
      .mockResolvedValueOnce(response("已委派。"));
    host = make({ ports });
    const result = await host.runPrompt({ prompt: "请委派修复", requestId: "retry-delegate" });
    expect(result.ok).toBe(true);
    expect(ports.handleOps).toHaveBeenCalledTimes(1);
    expect(ports.dispatchMessages).toHaveBeenCalledTimes(1);
    expect(ports.dispatchMessages.mock.calls[0][1][0]).toMatchObject({ task_id: expect.stringMatching(/^delegated-/), runtime_context: { parentRequestId: "retry-delegate", parentTaskRunId: result.payload.runtime.taskRunId } });
    expect(host.snapshot().uncertainReceipts).toEqual([]);
    const task = host.getSession().snapshot().tasks[result.payload.runtime.taskRunId];
    expect(task).toMatchObject({ status: "completed", effects: {} });
    expect(host.getSession().events().find(e => e.type === "tool.completed" && e.toolCallId === "bad").result.ok).toBe(false);
  });
  test("the final main reply excludes streamed progress and stays separate after durable replay", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response("正在检查。", [call("read", "list_agents", {})]))
      .mockResolvedValueOnce(response("检查完成。"));
    host = make();
    const result = await host.runPrompt({ prompt: "检查", requestId: "final-reply" });
    expect(result.payload.reply).toBe("检查完成。");
    expect(host.getSession().snapshot().tasks[result.payload.runtime.taskRunId].result.text).toContain("正在检查。");
    expect((await host.runPrompt({ prompt: "检查", requestId: "final-reply" })).payload.reply).toBe("检查完成。");
  });
  test("automatic report wakes retain the original user's language reference and trace", async () => {
    const EventBus = require("../../../src/coordination/bus");
    const bus = new EventBus(root); await bus.init();
    await bus.join("worker", "codex", "worker", { launchMode: "internal", parentPid: process.pid });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("delegate", "delegate_task", { command_id: "job", target: "codex:worker", objective: "验证" })]))
      .mockResolvedValueOnce(response("已委派。"))
      .mockResolvedValueOnce(response("已核对失败报告。"));
    host = make({ ports: { dispatchMessages: async () => [{ seq: 10 }] } });
    const original = "请验证失败回传。全程用中文回复。";
    const result = await host.runPrompt({ prompt: original, requestId: "language", sessionId: "language-test" });
    const task = Object.values(host.management.snapshot().tasks)[0];
    await host.management.report({ entry_id: "error", phase: "error", task_id: task.taskId, agent_id: "codex:worker", error: "provider unavailable" });
    const runtime = host.getSession("language-test");
    const resumed = Object.values(runtime.snapshot().tasks).find(t => t.request.parentTaskRunId === result.payload.runtime.taskRunId);
    expect(resumed.request).toMatchObject({ responseLanguageSource: original, traceId: result.payload.runtime.taskRunId });
    expect(resumed.request.text).toContain("not a new user request");
    expect(resumed.request.text).toContain(original);
    expect((await runtime.wait(resumed.taskRunId)).status).toBe("completed");
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).messages.at(-1).content).toContain(original);
  });
  test("main indexes full history and injects <turn_context> continuity for early multiline requirements through host restart", async () => {
    global.fetch = jest.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      return response(payload.tools?.length ? "已验证当前步骤。" : "已完成前序检查，后续继续验证；接口字段保持原样。");
    });
    const contextPolicy = { limitTokens: 1000000, rawTurnCount: 3, hardMaxTurns: 5, keepRecentUnits: 2 };
    host = make({ contextPolicy });
    const goal = "修复登录界面\n接口字段保持原样：session_nonce 保留现有命名。";
    for (let i = 0; i < 12; i++) await host.runPrompt({ prompt: i ? `继续检查步骤 ${i}` : goal, requestId: `history-${i}` });
    const events = host.getSession().events();
    expect(events.some((event) => event.type === "context.turn_indexed")).toBe(true);
    expect(events.some((event) => event.type === "context.window.projected")).toBe(true);
    expect(events.some((event) => event.type === "context.checkpoint")).toBe(false);
    expect(events.filter((event) => event.type === "request.accepted")
      .every((event) => !String(event.request?.text || "").includes("<turn_context>"))).toBe(true);
    const completed = events.filter((event) => event.type === "task.completed");
    expect(completed).toHaveLength(12);
    expect(completed.every((event) => event.result.historyOffset === 0 && event.result.messages.length === 2)).toBe(true);
    await host.close();
    host = make({ contextPolicy });
    await host.recover();
    await host.runPrompt({ prompt: "继续验证恢复后的会话", requestId: "history-resume" });
    const last = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(JSON.stringify(last.messages)).toContain("session_nonce");
    expect(JSON.stringify(last.messages)).toContain("<turn_context>");
    expect(last.messages.at(-1).content).toContain("<turn_context>");
    expect(host.getSession().events().filter((event) => event.type === "task.completed")).toHaveLength(13);
  });
  test("custom models and thinking apply to the next request and preserve conversation across host restart", async () => {
    const { saveConfig } = require("../../../src/config");
    const { applySettingsPatch } = require("../../../src/ui/settingsBridge");
    saveConfig(root, { agentProvider: "custom", agentModel: "model-one", agentBaseUrl: "https://custom.invalid/v1",
      agentApiKey: "isolated-custom-credential", agentThinking: "low" });
    global.fetch = jest.fn(async () => response("Saved conversation context."));
    host = createAgentHost({ projectRoot: root, provider: "custom" });
    await host.runPrompt({ prompt: "Keep this context", requestId: "custom-first" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toMatchObject({ model: "model-one", reasoning_effort: "low" });
    expect(global.fetch.mock.calls[0][1].headers.authorization).toBe("Bearer isolated-custom-credential");
    expect(global.fetch.mock.calls[0][0]).toBe("https://custom.invalid/v1/chat/completions");
    applySettingsPatch(root, { agent_model: "model-two", agent_thinking: "high" });
    await host.runPrompt({ prompt: "Continue after switching models", requestId: "custom-second" });
    const next = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(next).toMatchObject({ model: "model-two", reasoning_effort: "high" });
    expect(JSON.stringify(next.messages)).toContain("Keep this context");
    expect(next.temperature).toBeUndefined();
    expect(JSON.stringify(host.getSession().snapshot())).not.toContain("isolated-custom-credential");
    await host.close();
    host = createAgentHost({ projectRoot: root, provider: "custom" });
    await host.recover();
    await host.runPrompt({ prompt: "Continue after restart", requestId: "custom-third" });
    expect(JSON.parse(global.fetch.mock.calls[2][1].body).model).toBe("model-two");
  });
  test("external wrappers enter the communication roster without blocking an unassigned workspace", async () => {
    const EventBus = require("../../../src/coordination/bus");
    const bus = new EventBus(root);
    await bus.init();
    await bus.join("outside", "codex", "outside-wrapper", { launchMode: "terminal", parentPid: process.pid });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("roster", "list_agents", {})]))
      .mockResolvedValueOnce(response(null, [call("write", "write", { path: "managed.txt", content: "main work" })]))
      .mockResolvedValueOnce(response("done"));
    host = make();
    expect((await host.runPrompt({ prompt: "list managed agents and write managed.txt", requestId: "internal-roster" })).ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "managed.txt"), "utf8")).toBe("main work");
    const round = JSON.parse(global.fetch.mock.calls[1][1].body);
    const result = round.messages.find((message) => message.tool_call_id === "roster").content;
    expect(result).toContain('"count":1');
    expect(JSON.stringify(round.messages)).toContain("outside-wrapper");
  });

  test("main dispatch rejects departed workers and includes active external agents in direct, type and broadcast delivery", async () => {
    const EventBus = require("../../../src/coordination/bus");
    const { getUfooPaths } = require("../../../src/coordination/state/paths");
    const { updateAgentsData } = require("../../../src/coordination/state/agentsStore");
    const bus = new EventBus(root);
    await bus.init();
    await bus.join("live", "codex", "live", { launchMode: "internal", parentPid: process.pid });
    await bus.join("closed", "codex", "closed", { launchMode: "internal", parentPid: process.pid });
    await bus.join("outside", "codex", "outside", { launchMode: "terminal", parentPid: process.pid });
    updateAgentsData(getUfooPaths(root).agentsFile, (data) => { data.agents["codex:closed"].status = "inactive"; });
    const ports = { handleOps: jest.fn(), dispatchMessages: jest.fn(async (_root, messages) => messages.map((message) => ({ seq: 1, targets: [message.target] }))), markPending: jest.fn() };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("missing", "dispatch_message", { target: "codex:missing", message: "work" })]))
      .mockResolvedValueOnce(response(null, [call("closed", "dispatch_message", { target: "codex:closed", message: "work" })]))
      .mockResolvedValueOnce(response(null, [call("outside", "dispatch_message", { target: "codex:outside", message: "work" })]))
      .mockResolvedValueOnce(response(null, [call("type", "dispatch_message", { target: "codex", message: "type work" })]))
      .mockResolvedValueOnce(response(null, [call("broadcast", "dispatch_message", { target: "broadcast", message: "broadcast work" })]))
      .mockResolvedValueOnce(response("Only live internal children received work."));
    host = make({ ports });
    expect((await host.runPrompt({ prompt: "dispatch to live children", requestId: "live-dispatch" })).ok).toBe(true);
    expect(ports.dispatchMessages.mock.calls.map((args) => args[1])).toEqual([
      [{ target: "codex:outside", message: "work", injection_mode: "immediate", source: "ufoo-agent", dispatch_id: expect.stringMatching(/^tool-/) }],
      ["codex:live", "codex:outside"].map((target) => ({ target, message: "type work", injection_mode: "immediate", source: "ufoo-agent", dispatch_id: expect.stringMatching(/^tool-/) })),
      ["codex:live", "codex:outside"].map((target) => ({ target, message: "broadcast work", injection_mode: "immediate", source: "ufoo-agent", dispatch_id: expect.stringMatching(/^tool-/) })),
    ]);
    const messages = JSON.parse(global.fetch.mock.calls[5][1].body).messages;
    for (const id of ["missing", "closed"]) {
      expect(messages.find((message) => message.tool_call_id === id).content).toContain("invalid_target");
    }
    require("../../../src/config").saveConfig(root, { agentConversationId: "main-other" });
    global.fetch.mockResolvedValueOnce(response("Reply received."));
    const dispatchId = ports.dispatchMessages.mock.calls[0][1][0].dispatch_id;
    const reply = host.receiveWorkerMessage({ publisher: "codex:outside", seq: 10, message: "work finished", data: { reply_to_dispatch: dispatchId } });
    expect((await host.getSession("main-default").wait(reply.taskRunId)).status).toBe("completed");
    global.fetch.mockResolvedValueOnce(response("Explicit parent received reply."));
    const explicit = host.receiveWorkerMessage({ publisher: "codex:outside", seq: 11, message: "follow-up",
      data: { reply_to_dispatch: dispatchId, parent_session_id: "main-explicit" } });
    expect((await host.getSession("main-explicit").wait(explicit.taskRunId)).status).toBe("completed");
    expect(ports.markPending).toHaveBeenCalledTimes(3);
    expect(ports.markPending).toHaveBeenCalledWith("codex:outside");
  });

  test("external workers support delegation and correlated report wakeups without lifecycle takeover or double-wake", async () => {
    const bus = new (require("../../../src/coordination/bus"))(root);
    await bus.init();
    await bus.join("outside", "ucode", "outside", { launchMode: "terminal", parentPid: process.pid });
    const ports = { handleOps: jest.fn(), dispatchMessages: jest.fn(async () => [{ seq: 10, targets: ["ucode:outside"] }]) };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("delegate", "delegate_task", { command_id: "external-job", target: "outside", objective: "验证" })]))
      .mockResolvedValueOnce(response(null, [call("shared-write", "write", { path: "main-side.txt", content: "non-overlapping work" })]))
      .mockResolvedValueOnce(response(null, [call("close", "close_agent", { agent_id: "ucode:outside" })]))
      .mockResolvedValueOnce(response("等待外部验证。"))
      .mockResolvedValueOnce(response("验证已完成。"));
    host = make({ ports });
    const original = await host.runPrompt({ prompt: "请让 outside 验证", requestId: "external", sessionId: "external-session" });
    expect(original.ok).toBe(true);
    expect(ports.handleOps).not.toHaveBeenCalled();
    expect(ports.dispatchMessages).toHaveBeenCalledTimes(1);
    expect(ports.dispatchMessages.mock.calls[0][1][0].target).toBe("ucode:outside");
    expect(fs.readFileSync(path.join(root, "main-side.txt"), "utf8")).toBe("non-overlapping work");
    const events = host.getSession("external-session").events().filter(e => e.type === "tool.completed");
    expect(events.find(e => e.toolCallId === "shared-write").result.ok).toBe(true);
    expect(JSON.stringify(events.find(e => e.toolCallId === "close").result)).toContain("external_lifecycle");
    const task = Object.values(host.management.snapshot().tasks)[0];
    // Duplicate bus reply for a tracked delegated task does not trigger a second wake.
    expect(host.receiveWorkerMessage({ publisher: "ucode:outside", seq: 20, message: "verified", data: { task_id: task.taskId, parent_session_id: "external-session" } })).toBeUndefined();
    await host.management.report({ entry_id: "wrong", phase: "done", task_id: task.taskId, agent_id: "ucode:other" });
    const runtime = host.getSession("external-session");
    expect(Object.values(runtime.snapshot().tasks)).toHaveLength(1);
    await host.management.report({ entry_id: "done", phase: "done", task_id: task.taskId, agent_id: "ucode:outside", summary: "verified" });
    const wake = Object.values(runtime.snapshot().tasks).find(t => t.request.parentTaskRunId === original.payload.runtime.taskRunId);
    expect(wake).toBeDefined();
    expect((await runtime.wait(wake.taskRunId)).status).toBe("completed");
    await host.management.report({ entry_id: "done", phase: "done", task_id: task.taskId, agent_id: "ucode:outside" });
    expect(Object.values(runtime.snapshot().tasks)).toHaveLength(2);
  });

  test("shared repository allows main writes and bash alongside active workers while preserving group members", async () => {
    const EventBus = require("../../../src/coordination/bus");
    const { getUfooPaths } = require("../../../src/coordination/state/paths");
    const { updateAgentsData } = require("../../../src/coordination/state/agentsStore");
    const bus = new EventBus(root);
    await bus.init();
    await bus.join("member", "codex", "architect", { launchMode: "internal", parentPid: process.pid });
    updateAgentsData(getUfooPaths(root).agentsFile, (data) => { data.agents["codex:member"].activity_state = "working"; });
    fs.writeFileSync(path.join(root, "existing.txt"), "existing work");
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("write-ok", "write", { path: "main-edit.txt", content: "shared ok" })]))
      .mockResolvedValueOnce(response(null, [call("bash-ok", "bash", { command: "node -e 'process.exit(0)'" })]))
      .mockResolvedValueOnce(response(null, [call("read", "read", { path: "existing.txt" }), call("launch", "launch_agent", { agent: "ucode" })]))
      .mockResolvedValueOnce(response("Collaborated cleanly in the shared workspace."));
    const { runCoreToolAsync } = require("../../../src/code/tools/executor");
    const ports = { handleOps: jest.fn(async () => [{ ok: true, agent_id: "ucode:new" }]), dispatchMessages: jest.fn() };
    host = make({ ports });
    const [main, ...workers] = await Promise.all([
      host.runPrompt({ prompt: "edit main-edit.txt and inspect existing.txt", requestId: "shared-repo-ok" }),
      ...["worker-a", "worker-b"].map(sessionId => runCoreToolAsync({ workspaceRoot: root, sessionId, tool: "bash",
        args: { command: `echo ${sessionId} > ${sessionId}.txt` } })),
    ]);
    expect(main.ok).toBe(true);
    expect(workers.map(result => result.ok)).toEqual([true, true]);
    for (const worker of ["worker-a", "worker-b"]) {
      expect(fs.readFileSync(path.join(root, worker + ".txt"), "utf8").trim()).toBe(worker);
    }
    expect(fs.readFileSync(path.join(root, "main-edit.txt"), "utf8")).toBe("shared ok");
    const messages = JSON.parse(global.fetch.mock.calls[3][1].body).messages;
    expect(JSON.parse(messages.find((message) => message.tool_call_id === "write-ok").content).ok).toBe(true);
    expect(JSON.parse(messages.find((message) => message.tool_call_id === "bash-ok").content).ok).toBe(true);
    expect(messages.find((message) => message.tool_call_id === "read").content).toContain("existing work");
    expect(messages[0].content).toContain("Multiple agents share this repository directly without whole-repo write locks");
    expect(ports.handleOps).toHaveBeenCalledTimes(1);
    bus.loadBusData();
    expect(bus.busData.agents["codex:member"].status).toBe("active");
  });

  test("the main profile edits and verifies real workspace files through the shared HTTP loop", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("write-1", "write", { path: "greeting.txt", content: "hello" })]))
      .mockResolvedValueOnce(response(null, [call("test-1", "bash", { command: "node -e 'process.exit(require(\"fs\").readFileSync(\"greeting.txt\",\"utf8\")===\"hello\"?0:1)'" })]))
      .mockResolvedValueOnce(response("Created greeting.txt and verified its content."));
    host = make();
    const result = await host.runPrompt({ prompt: "create and verify greeting.txt", requestId: "code-request" });
    expect(result.ok).toBe(true);
    expect(host.inspectTask(result.payload.runtime.taskRunId).task).toMatchObject({ status: "completed", effects: {} });
    expect(host.listTasks().tasks).toEqual(expect.arrayContaining([expect.objectContaining({ taskRunId: result.payload.runtime.taskRunId, status: "completed" })]));
    expect(fs.readFileSync(path.join(root, "greeting.txt"), "utf8")).toBe("hello");
    const tools = JSON.parse(global.fetch.mock.calls[0][1].body).tools.map((tool) => tool.function.name);
    const system = JSON.parse(global.fetch.mock.calls[0][1].body).messages.find((message) => message.role === "system").content;
    expect(system).toContain("same natural language as the user's prompt");
    expect(system).toContain("no bus reply, no lifecycle report, and no final response text");
    expect(tools).toEqual(expect.arrayContaining(["write", "bash", "delegate_task", "accept_task", "recall", "read_agent_history"]));
    for (const removed of ["manage_tasks", "route_agent", "read_prompt_history", "read_bus_summary", "read_agent_metrics", "search_memory"]) {
      expect(tools).not.toContain(removed);
    }
    const runtime = host.getSession();
    const events = runtime.events();
    expect(events.filter((event) => event.type === "tool.completed").map((event) => event.toolCallId)).toEqual(["write-1", "test-1"]);
    expect(events.find((event) => event.toolCallId === "test-1" && event.type === "tool.completed").result.ok).toBe(true);
    const metrics = require("../../../src/coordination/history/agentTrace").readAgentPerformance(root, { task_id: result.payload.runtime.taskRunId });
    expect(metrics.summary).toMatchObject({ runs: 1, outcomes: { completed: 1 }, counts: { modelCalls: 3, toolCalls: 2, toolErrors: 0 } });
    expect(metrics.runs[0]).toMatchObject({ configuration: { model: "test", thinkingLevel: "medium", executionKind: "native" }, coverage: { lifecycle: true, configuration: true } });
    expect(metrics.runs[0].configuration.engineFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(metrics)).not.toContain("isolated-vendor-key");
    expect(JSON.stringify(runtime.snapshot())).not.toContain("isolated-vendor-key");
    expect(fs.readdirSync(path.join(root, ".ufoo/agent/main/artifacts/main-default"))).toHaveLength(2);
    await host.runPrompt({ prompt: "create and verify greeting.txt", requestId: "code-request" });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test("main work passes 64 model turns and 128 tools with the default ucode budget", async () => {
    const previous = process.env.UFOO_UCODE_MAX_TOOL_CALLS;
    delete process.env.UFOO_UCODE_MAX_TOOL_CALLS;
    try {
      let turn = 0;
      global.fetch = jest.fn(async (_url, options) => {
        if (!JSON.parse(options.body).tools?.length) return response("已完成记录中的写入操作，继续当前任务并验证结果。");
        if (turn === 65) return response("Completed the long task.");
        const first = turn++ * 2;
        return response(null, [first, first + 1].map((index) => call(`step-${index}`, "write", { path: "long-task.txt", content: String(index) })));
      });
      host = make();
      const result = await host.runPrompt({ prompt: "complete long coding work", requestId: "long-budget" });
      expect(result.ok).toBe(true);
      expect(fs.readFileSync(path.join(root, "long-task.txt"), "utf8")).toBe("129");
      const task = host.getSession().snapshot().tasks[result.payload.runtime.taskRunId];
      expect(task).toMatchObject({ status: "completed", result: { usage: { turns: 66 }, toolCallsExecuted: 130 } });
    } finally {
      if (previous === undefined) delete process.env.UFOO_UCODE_MAX_TOOL_CALLS;
      else process.env.UFOO_UCODE_MAX_TOOL_CALLS = previous;
    }
  }, 15000);

  test("main work honors the same optional tool limit as ucode", async () => {
    const previous = process.env.UFOO_UCODE_MAX_TOOL_CALLS;
    process.env.UFOO_UCODE_MAX_TOOL_CALLS = "2";
    try {
      global.fetch = jest.fn(async () => response(null, [0, 1, 2].map((index) => call(`limited-${index}`, "write", { path: `limited-${index}.txt`, content: "work" }))));
      host = make();
      const result = await host.runPrompt({ prompt: "work with an explicit budget", requestId: "limited-budget" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("tool call budget exceeded (2)");
      expect(fs.existsSync(path.join(root, "limited-1.txt"))).toBe(true);
      expect(fs.existsSync(path.join(root, "limited-2.txt"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.UFOO_UCODE_MAX_TOOL_CALLS;
      else process.env.UFOO_UCODE_MAX_TOOL_CALLS = previous;
    }
  });
  test("the five recent delegated outcomes follow completion time, with active tasks retained", async () => {
    const { createRuntimeStore } = require("../../../src/agents/runtime");
    const store = createRuntimeStore({ workspaceRoot: fs.realpathSync(root), namespace: "main-control", sessionId: "control" });
    const tasks = {};
    for (const [id, day] of [["late", 7], ["oldest", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5]]) {
      tasks[id] = { taskId: id, status: "accepted", acceptance: { time: `2026-01-0${day}T00:00:00Z` } };
    }
    tasks.active = { taskId: "active", status: "running" };
    store.append({ type: "capability.state_committed", capabilityId: "agent-management", version: 1, value: { tasks } });
    global.fetch = jest.fn().mockResolvedValue(response("ok"));
    host = make();
    expect((await host.runPrompt({ prompt: "status", requestId: "recent" })).ok).toBe(true);
    const messages = JSON.parse(global.fetch.mock.calls[0][1].body).messages;
    const prompt = messages.map(message => typeof message.content === "string" ? message.content : "").join("\n");
    expect(prompt).toContain('"taskId":"late"');
    expect(prompt).toContain('"taskId":"active"');
    expect(prompt).not.toContain('"taskId":"oldest"');
  });

  test("recover ignores legacy task-execution child jobs in main-control without reviving zombie children", async () => {
    const { createRuntimeStore } = require("../../../src/agents/runtime");
    const controlStore = createRuntimeStore({ workspaceRoot: fs.realpathSync(root), namespace: "main-control", sessionId: "control" });
    controlStore.append({
      type: "capability.state_committed",
      capabilityId: "task-execution",
      version: 1,
      value: {
        jobs: {
          "child-legacy": {
            id: "child-legacy",
            requestId: "legacy-req",
            objective: "stale zombie job",
            workspaceRoot: fs.realpathSync(root),
            readOnly: false,
            parentSessionId: "main-default",
            status: "running",
          },
        },
      },
    });
    global.fetch = jest.fn().mockResolvedValue(response("Recovered cleanly."));
    host = make();
    await host.recover();
    expect(host.snapshot().children).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect((await host.runPrompt({ prompt: "status", requestId: "post-legacy-recover" })).ok).toBe(true);
  });
  test("global router profile cannot execute coding tools or inherit project management permissions", async () => {
    jest.spyOn(os, "homedir").mockReturnValue(root);
    global.fetch = jest.fn().mockResolvedValueOnce(response(null, [call("forbidden-write", "write", { path: "escaped.txt", content: "bad" })]))
      .mockResolvedValueOnce(response(JSON.stringify({ reply: "Select a project", dispatch: [], ops: [] })));
    host = make();
    const result = await host.runPrompt({ prompt: "route the request", requestId: "global-request" });
    expect(result.ok).toBe(true);
    expect(host.getSession().tools.names()).toEqual(["read_project_registry"]);
    expect(fs.existsSync(path.join(root, "escaped.txt"))).toBe(false);
    const retry = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(retry.messages.find((message) => message.role === "system").content).toContain("same natural language as the user's prompt");
    expect(retry.messages.find((message) => message.tool_call_id === "forbidden-write").content).toContain("unsupported_tool");
  });
  test("controller tool failures return recoverable tool results instead of aborting the turn with uncertain_effect", async () => {
    const ports = {
      handleOps: jest.fn(),
      dispatchMessages: jest.fn(),
      groups: {
        getStatus: jest.fn(() => { throw new Error("group daemon busy"); }),
        runGroup: jest.fn(async () => { throw new Error("unexpected group startup error"); }),
      },
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("read-err", "manage_group", { operation: "status" })]))
      .mockResolvedValueOnce(response(null, [call("write-err", "manage_group", { operation: "start", command_id: "grp-1", target: "dev" })]))
      .mockResolvedValueOnce(response("Recovered from both controller tool errors."));
    host = make({ ports });
    const result = await host.runPrompt({ prompt: "check and start group", requestId: "recoverable-errors", sessionId: "err-session" });
    expect(result.ok).toBe(true);
    expect(result.payload.reply).toBe("Recovered from both controller tool errors.");
    // Only the mutating start command records a durable uncertain receipt; read-only status never does.
    expect(host.snapshot().uncertainReceipts).toEqual([expect.objectContaining({ kind: "manage_group", commandId: expect.stringMatching(/^coord-/) })]);
    const events = host.getSession("err-session").events();
    expect(events.some((e) => e.type === "tool.failed")).toBe(false);
    expect(events.find((e) => e.type === "tool.completed" && e.toolCallId === "read-err").result).toMatchObject({ ok: false, error: { code: "tool_execution_failed", message: "group daemon busy" } });
    expect(events.find((e) => e.type === "tool.completed" && e.toolCallId === "write-err").result).toMatchObject({ ok: false, error: { code: "tool_execution_failed", message: "unexpected group startup error" } });
  });
  test("restarted sessions retain provider and model while new sessions use new settings", async () => {
    const resolveProvider = jest.fn(async ({ provider, model }) => ({ provider, model,
      transport: provider === "claude" ? "anthropic-messages" : "openai-chat", baseUrl: "https://runtime.invalid/v1", auth: { apiKey: "isolated-key" } }));
    global.fetch = jest.fn().mockResolvedValue(response("Old settings."));
    host = make({ resolveProvider });
    await host.runPrompt({ prompt: "first", requestId: "binding-first" });
    await host.close();
    host = make({ provider: "claude", model: "changed-model", resolveProvider });
    await host.recover();
    await host.runPrompt({ prompt: "second", requestId: "binding-second" });
    expect(resolveProvider).toHaveBeenLastCalledWith({ projectRoot: fs.realpathSync(root), provider: "kimi", model: "test" });
    global.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "New settings." }], usage: {} }), { headers: { "content-type": "application/json" } }));
    await host.runPrompt({ prompt: "new conversation", requestId: "binding-new", sessionId: "new-session" });
    expect(resolveProvider).toHaveBeenLastCalledWith({ projectRoot: fs.realpathSync(root), provider: "claude", model: "changed-model" });
  });
  test("a paused interaction survives restart and invalid answers do not consume it", async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response("Earlier task recorded."))
      .mockResolvedValueOnce(response(null, [call("ask-1", "ask_user", { kind: "choice", prompt: "Which file?", options: ["a", "b"], allowFreeChat: false })]));
    host = make();
    await host.runPrompt({ prompt: "Keep earlier_user_constraint", requestId: "earlier-task" });
    const result = await host.runPrompt({ prompt: "ask before editing", requestId: "question-request" });
    expect(result.payload.runtime.status).toBe("waiting_user");
    const interactionId = result.payload.runtime.interaction.id;
    await expect(host.getSession().resume({ interactionId, answer: "invalid" })).rejects.toThrow("option");
    expect(host.getSession().snapshot().tasks[result.payload.runtime.taskRunId].status).toBe("waiting_user");
    await host.close(); host = make(); await host.recover();
    global.fetch.mockResolvedValueOnce(response("Selected a."));
    const accepted = await host.findRuntime({ interactionId }).resume({ interactionId, answer: "1" });
    const completed = await host.getSession().wait(accepted.taskRunId);
    expect(completed.status).toBe("completed");
    expect(completed.effects).toEqual({});
    const request = JSON.parse(global.fetch.mock.calls[2][1].body);
    expect(request.messages.find((message) => message.tool_call_id === "ask-1").content).toContain('"selected":"1"');
    await host.getSession().resume({ interactionId, answer: "1" });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    global.fetch.mockResolvedValueOnce(response("Next task recorded."));
    await host.runPrompt({ prompt: "Continue after the interaction", requestId: "after-interaction" });
    const next = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(next.messages.filter(message => message.content === "Keep earlier_user_constraint")).toHaveLength(1);
    expect(next.messages.some(message => message.content === "ask before editing")).toBe(true);
  });
  test("Codex main keeps trusted instructions and the user prefix intact across a tool call", async () => {
    const model = "gpt-6.2-sol";
    const resolveProvider = async () => ({ provider: "codex", model, transport: "codex-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex", requestProfile: "codex-subscription", auth: { apiKey: "test" } });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Follow project convention ABC.");
    const payloads = [];
    global.fetch = jest.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      const foreground = Boolean(payload.tools?.length);
      if (foreground) payloads.push(payload);
      const item = foreground && payloads.length === 1
        ? { type: "function_call", name: "list_agents", call_id: "list-1", arguments: "{}" }
        : { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] };
      return new Response(JSON.stringify({ object: "response", status: "completed", output: [item] }), { headers: { "content-type": "application/json" } });
    });
    host = make({ provider: "codex", model, resolveProvider, contextPolicy: { cacheStrategy: "stable-prefix" } });
    const result = await host.runPrompt({ prompt: "Inspect workers", requestId: "list" });
    expect(result.ok).toBe(true);
    expect(payloads).toHaveLength(2);
    const [first, next] = payloads;
    expect(first.input[0]).toMatchObject({ role: "developer", content: [{ text: expect.stringContaining("Follow project convention ABC.") }] });
    expect(first.instructions).toBeTruthy();
    expect(first.instructions).toBe(next.instructions);
    expect(next.input.slice(0, first.input.length)).toEqual(first.input);
    expect(first.input[0].content[0].text).not.toContain("Runtime context (untrusted data");
    expect(first.input.some(item => item.role === "user" && JSON.stringify(item).includes("Runtime context (untrusted data"))).toBe(true);
  });
  test.each([
    ["codex", "codex-responses", { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex connected." }] }], usage: {} }, { authorization: "Bearer isolated-codex-token" }],
    ["claude", "anthropic-messages", { content: [{ type: "text", text: "Claude connected." }], usage: {} }, { authorization: "Bearer isolated-claude-token", "anthropic-beta": "oauth-2025-04-20" }],
  ])("%s keeps provider-owned auth on isolated HTTP requests", async (provider, transport, payload, headers) => {
    const resolveProvider = jest.fn(async () => ({ provider, model: "test", transport, baseUrl: "https://runtime.invalid/v1", auth: { headers } }));
    global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }));
    host = make({ provider, resolveProvider });
    const result = await host.runPrompt({ prompt: "hello", requestId: "provider-smoke" });
    expect(result.ok).toBe(true);
    expect(global.fetch.mock.calls[0][1].headers).toEqual(expect.objectContaining(headers));
    expect(global.fetch.mock.calls[0][1].headers).not.toHaveProperty("x-ufoo-agent-handle");
    expect(JSON.stringify(host.getSession().snapshot())).not.toContain("isolated-");
    expect(fs.existsSync(path.join(root, ".ufoo/config.json"))).toBe(false);
  });
  test("accept_task verifies cross-turn read evidence, allows reason-only acceptance, and rejects fabricated IDs or error reports", async () => {
    const EventBus = require("../../../src/coordination/bus");
    const bus = new EventBus(root);
    await bus.init();
    await bus.join("worker", "ucode", "builder", { launchMode: "internal", parentPid: process.pid });
    fs.writeFileSync(path.join(root, "output.txt"), "verified content");
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("del-1", "delegate_task", { command_id: "job-read", target: "ucode:worker", objective: "produce output.txt" })]))
      .mockResolvedValueOnce(response("Delegated."))
      .mockResolvedValueOnce(response(null, [call("read-check-1", "read", { path: "output.txt" })]))
      .mockResolvedValueOnce(response("Read output.txt."));
    host = make({ ports: { dispatchMessages: async () => [{ seq: 11, targets: ["ucode:worker"] }] } });
    await host.runPrompt({ prompt: "delegate output.txt", requestId: "req-del", sessionId: "accept-session" });
    const delegatedTask = Object.values(host.management.snapshot().tasks)[0];
    expect(host.inspectTask(delegatedTask.taskId).task).toMatchObject({ taskId: delegatedTask.taskId, status: "queued" });

    // Perform a read check in a separate turn before accepting in another turn.
    await host.runPrompt({ prompt: "inspect output.txt", requestId: "req-inspect", sessionId: "accept-session" });
    await host.management.report({ entry_id: "done-1", phase: "done", task_id: delegatedTask.taskId, agent_id: "ucode:worker", summary: "wrote output.txt" });
    const runtime = host.getSession("accept-session");
    const wakeTask = Object.values(runtime.snapshot().tasks).find((t) => t.request.taskId === delegatedTask.taskId);
    if (wakeTask) {
      global.fetch.mockResolvedValueOnce(response("Wake received."));
      await runtime.wait(wakeTask.taskRunId);
    }

    // Fabricated toolCallId is still rejected.
    expect(host.management.accept({ task_id: delegatedTask.taskId, outcome: "accepted", reason: "checked", evidence: ["invented-id"] }, { sessionId: "accept-session", taskRunId: "other-turn" }))
      .toMatchObject({ ok: false, code: "invalid_evidence" });

    // Cross-turn read toolCallId is accepted.
    expect(host.management.accept({ task_id: delegatedTask.taskId, outcome: "accepted", reason: "read output.txt and confirmed content", evidence: ["read-check-1"] }, { sessionId: "accept-session", taskRunId: "other-turn" }).task.status)
      .toBe("accepted");

    // Reason-only acceptance works for completed non-code/research reports; error reports cannot be accepted.
    const research = await host.management.delegate({ command_id: "job-research", target: "ucode:worker", objective: "summarize docs" }, { sessionId: "accept-session", requestId: "req-res" });
    await host.management.report({ entry_id: "done-res", phase: "done", task_id: research.task.taskId, agent_id: "ucode:worker", summary: "docs summarized" });
    expect(host.management.accept({ task_id: research.task.taskId, outcome: "accepted", reason: "summary covers all requested sections" }, { sessionId: "accept-session" }).task.status)
      .toBe("accepted");

    const broken = await host.management.delegate({ command_id: "job-broken", target: "ucode:worker", objective: "run failing task" }, { sessionId: "accept-session", requestId: "req-brk" });
    await host.management.report({ entry_id: "err-brk", phase: "error", task_id: broken.task.taskId, agent_id: "ucode:worker", error: "failed" });
    expect(host.management.accept({ task_id: broken.task.taskId, outcome: "accepted", reason: "ignore failure" }, { sessionId: "accept-session" }))
      .toMatchObject({ ok: false, code: "acceptance_required" });
  });

  test("ephemeral streaming deltas bypass WAL persistence while reaching onEvent live", async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "thinking step" } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello " } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    global.fetch = jest.fn().mockResolvedValueOnce(new Response(sseBody, { headers: { "content-type": "text/event-stream" } }));
    const liveEvents = [];
    host = make({ onEvent: (event) => liveEvents.push(event) });
    const result = await host.runPrompt({ prompt: "stream reply", requestId: "stream-ephemeral", sessionId: "stream-session" });
    expect(result.ok).toBe(true);
    expect(result.payload.reply).toBe("hello world");
    expect(liveEvents.some((e) => e.type === "message.delta" && e.ephemeral === true)).toBe(true);
    expect(liveEvents.some((e) => e.type === "thinking.delta" && e.ephemeral === true)).toBe(true);
    const persisted = host.getSession("stream-session").events();
    expect(persisted.some((e) => ["message.delta", "thinking.delta", "model.phase"].includes(e.type))).toBe(false);
    expect(persisted.find((e) => e.type === "model.completed")).toMatchObject({ firstTextAt: expect.any(String), firstThinkingAt: expect.any(String), streamedCharacters: 11 });
  });

  test("switching agent_provider in settings seamlessly transitions an existing session across transports", async () => {
    const { saveConfig } = require("../../../src/config");
    const { applySettingsPatch } = require("../../../src/ui/settingsBridge");
    saveConfig(root, { agentProvider: "kimi-cli", agentModel: "kimi-one" });
    const resolveProvider = jest.fn(async ({ provider, model }) => ({
      provider,
      model,
      transport: provider === "claude" ? "anthropic-messages" : "openai-chat",
      baseUrl: "https://runtime.invalid/v1",
      auth: { apiKey: "isolated-switch-key" },
    }));
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response("First turn on Kimi."))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: "text", text: "Second turn on Claude." }], usage: {} }), { headers: { "content-type": "application/json" } }));
    host = make({ provider: "kimi", model: "kimi-one", resolveProvider });
    const first = await host.runPrompt({ prompt: "remember alpha_token", requestId: "switch-1", sessionId: "switch-session" });
    expect(first.ok).toBe(true);
    applySettingsPatch(root, { agent_provider: "claude-cli", agent_model: "claude-two" });
    const second = await host.runPrompt({ prompt: "continue on claude", requestId: "switch-2", sessionId: "switch-session" });
    expect(second.ok).toBe(true);
    expect(second.payload.reply).toBe("Second turn on Claude.");
    const claudeReq = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(claudeReq.model).toBe("claude-two");
    expect(JSON.stringify(claudeReq.messages)).toContain("alpha_token");
  });

  test("supervised permissionMode blocks mutating main tools while permitting reads", async () => {
    fs.writeFileSync(path.join(root, "notes.txt"), "safe content");
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("read-1", "read", { path: "notes.txt" }), call("write-1", "write", { path: "blocked.txt", content: "nope" })]))
      .mockResolvedValueOnce(response("Read succeeded; write required approval."));
    host = make();
    expect(require("../../../src/ui/settingsBridge").applySettingsPatch(root, { permission_mode: "supervised" }).ok).toBe(true);
    const result = await host.runPrompt({ prompt: "read notes and write blocked.txt", requestId: "supervised-main", sessionId: "sup-session" });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(root, "blocked.txt"))).toBe(false);
    const events = host.getSession("sup-session").events().filter((e) => e.type === "tool.completed");
    expect(events.find((e) => e.toolCallId === "read-1").result.ok).toBe(true);
    expect(events.find((e) => e.toolCallId === "write-1").result).toMatchObject({ ok: false, code: "forbidden_tool" });
    const tools = host.getSession("sup-session").tools;
    for (const [name, args] of [["bash", { command: "pwd" }], ["browser", { operation: "status" }], ["mac_app", { operation: "status" }]]) {
      expect(await tools.execute(name, args, { workspaceRoot: root })).toMatchObject({ code: "forbidden_tool" });
    }
  });

  test("receiveWorkerMessage routes non-delegated replies to parent_session_id without cross-session bleed", async () => {
    global.fetch = jest.fn().mockResolvedValue(response("Received worker update."));
    host = make();
    const accepted = host.receiveWorkerMessage({
      publisher: "ucode:helper",
      seq: 55,
      message: "finished audit",
      data: { parent_session_id: "tab-two" },
    });
    expect((await host.getSession("tab-two").wait(accepted.taskRunId)).status).toBe("completed");
    expect(host.snapshot().sessions.map((s) => s.sessionId)).toEqual(["tab-two"]);
  });

  test("recall_turn is non-deferable and returns a recoverable error instead of crashing the turn", async () => {
    const { createTurnRecallCapability } = require("../../../src/agents/capabilities/turnRecall");
    const cap = createTurnRecallCapability({ projectRoot: root }, { defaultNamespace: "main" });
    expect(cap.tools[0].deferable).toBeUndefined();
    const brokenDir = path.join(root, ".ufoo", "agent", "main", "context", "bad-session.turns.jsonl");
    fs.mkdirSync(brokenDir, { recursive: true });
    const res = await cap.tools[0].handler({ mode: "search", query: "anything" }, { workspaceRoot: root, sessionId: "bad-session" });
    expect(res).toMatchObject({ ok: false, code: "recall_turn_failed" });
  });
});

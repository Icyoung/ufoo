"use strict";

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
  test("main checkpoints full history and keeps early multiline requirements through host restart", async () => {
    global.fetch = jest.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      return response(payload.tools?.length ? "已验证当前步骤。" : "已完成前序检查，后续继续验证；接口字段保持原样。");
    });
    const contextPolicy = { limitTokens: 1000000, maxMessages: 6, keepRecentUnits: 2, batchTokens: 12000 };
    host = make({ contextPolicy });
    const goal = "修复登录界面\n接口字段保持原样：session_nonce 保留现有命名。";
    for (let i = 0; i < 12; i++) await host.runPrompt({ prompt: i ? `继续检查步骤 ${i}` : goal, requestId: `history-${i}` });
    expect(host.getSession().events().some(event => event.type === "context.checkpoint")).toBe(true);
    const completed = host.getSession().events().filter(event => event.type === "task.completed");
    expect(completed).toHaveLength(12);
    expect(completed.every(event => event.result.historyOffset === 0 && event.result.messages.length === 2)).toBe(true);
    await host.close();
    host = make({ contextPolicy });
    await host.recover();
    await host.runPrompt({ prompt: "继续验证恢复后的会话", requestId: "history-resume" });
    const last = JSON.parse(global.fetch.mock.calls.at(-1)[1].body);
    expect(JSON.stringify(last.messages)).toContain("session_nonce");
    expect(last.messages.some(message => message.content?.startsWith("Session continuity"))).toBe(true);
    expect(host.getSession().events().filter(event => event.type === "task.completed")).toHaveLength(13);
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
  test("external wrappers neither enter the main roster nor block its managed workspace", async () => {
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
    expect(result).toContain('"count":0');
    expect(JSON.stringify(round.messages)).not.toContain("outside-wrapper");
  });

  test("main dispatch rejects departed workers and sends type/broadcast targets only to live internal children", async () => {
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
      [{ target: "codex:live", message: "type work", injection_mode: "immediate", source: "ufoo-agent" }],
      [{ target: "codex:live", message: "broadcast work", injection_mode: "immediate", source: "ufoo-agent" }],
    ]);
    const messages = JSON.parse(global.fetch.mock.calls[5][1].body).messages;
    for (const id of ["missing", "closed", "outside"]) {
      expect(messages.find((message) => message.tool_call_id === id).content).toContain("invalid_target");
    }
    expect(ports.markPending).toHaveBeenCalledTimes(1);
    expect(ports.markPending).toHaveBeenCalledWith("codex:live");
  });

  test("workspace denial preserves group members and gives the main agent delegation guidance", async () => {
    const EventBus = require("../../../src/coordination/bus");
    const bus = new EventBus(root);
    await bus.init();
    await bus.join("member", "codex", "architect", { launchMode: "internal", parentPid: process.pid });
    fs.writeFileSync(path.join(root, "existing.txt"), "existing work");
    global.fetch = jest.fn()
      .mockResolvedValueOnce(response(null, [call("blocked", "bash", { command: "git status --short" })]))
      .mockResolvedValueOnce(response(null, [call("read", "read", { path: "existing.txt" })]))
      .mockResolvedValueOnce(response("Workspace belongs to the existing workers."));
    const ports = { handleOps: jest.fn(), dispatchMessages: jest.fn() };
    host = make({ ports });
    expect((await host.runPrompt({ prompt: "inspect the workspace", requestId: "preserve-group" })).ok).toBe(true);
    const messages = JSON.parse(global.fetch.mock.calls[2][1].body).messages;
    const denied = messages.find((message) => message.tool_call_id === "blocked").content;
    expect(denied).toContain("workspace_busy");
    expect(denied).toContain("Do not close workers");
    expect(messages.find((message) => message.tool_call_id === "read").content).toContain("existing work");
    expect(messages[0].content).toContain("Never use close_agent or stop a group to free the workspace");
    expect(ports.handleOps).not.toHaveBeenCalled();
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
    expect((await host.taskPort.execute({ operation: "inspect", task_run_id: result.payload.runtime.taskRunId })).task).toMatchObject({ status: "completed", effects: {} });
    expect(fs.readFileSync(path.join(root, "greeting.txt"), "utf8")).toBe("hello");
    const tools = JSON.parse(global.fetch.mock.calls[0][1].body).tools.map((tool) => tool.function.name);
    const system = JSON.parse(global.fetch.mock.calls[0][1].body).messages.find((message) => message.role === "system").content;
    expect(system).toContain("same natural language as the user's prompt");
    expect(system).toContain("no bus reply, no lifecycle report, and no final response text");
    expect(tools).toEqual(expect.arrayContaining(["write", "bash", "delegate_task", "manage_tasks", "accept_task"]));
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
  test("an independent long task leaves the main conversation, status and cancellation responsive", async () => {
    let entered;
    let cancelled;
    const childEntered = new Promise((resolve) => { entered = resolve; });
    const childCancelled = new Promise((resolve) => { cancelled = resolve; });
    global.fetch = jest.fn((_url, options) => {
      const body = JSON.parse(options.body);
      const child = body.messages.some((message) => message.role === "user" && message.content === "slow objective");
      if (!child) return Promise.resolve(response("Main conversation is responsive."));
      entered();
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true }));
    });
    host = make({ onEvent: (event) => { if (event.type === "task.cancelled") cancelled(); } });
    const started = await host.taskPort.execute({ operation: "start", command_id: "long-task", objective: "slow objective" }, { sessionId: "main-default", taskRunId: "parent-task" });
    await childEntered;
    expect(host.snapshot().children[0].status).toBe("running");
    expect((await host.runPrompt({ prompt: "give me status", requestId: "status-request" })).payload.reply).toContain("responsive");
    const cancel = await host.taskPort.execute({ operation: "cancel", task_run_id: started.taskRunId, reason: "user_cancel" });
    expect(cancel.status).toBe("cancelling");
    await childCancelled;
    expect(host.snapshot().children[0].status).toBe("cancelled");
    expect(await host.taskPort.execute({ operation: "start", command_id: "long-task", objective: "slow objective" }, { sessionId: "main-default" })).toMatchObject({ taskRunId: started.taskRunId });
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
  test("a task cannot select a directory outside its project or verified worktrees", async () => {
    host = make();
    await expect(host.taskPort.execute({ operation: "start", command_id: "escape-task", objective: "escape", workspace: os.tmpdir() }, {})).rejects.toThrow("outside the project grant");
    expect(host.snapshot().children).toEqual([]);
  });
  test("verified worktrees run in independent writable task contexts", async () => {
    const { execFileSync } = require("child_process");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "baseline"], { cwd: root });
    const worktree = `${root}-worktree`;
    execFileSync("git", ["worktree", "add", "--quiet", "--detach", worktree], { cwd: root });
    try {
      global.fetch = jest.fn(async (_url, options) => {
        const messages = JSON.parse(options.body).messages;
        return messages.some((message) => message.tool_call_id === "worktree-write") ? response("Wrote in worktree.")
          : response(null, [call("worktree-write", "write", { path: "isolated.txt", content: "child" })]);
      });
      host = make();
      const started = await host.taskPort.execute({ operation: "start", command_id: "worktree-task", objective: "write in isolated workspace", workspace: worktree }, { sessionId: "main-default" });
      expect((await host.resolveRuntime(started.task.id).wait(started.taskRunId)).status).toBe("completed");
      expect(fs.readFileSync(path.join(worktree, "isolated.txt"), "utf8")).toBe("child");
      expect(fs.existsSync(path.join(root, "isolated.txt"))).toBe(false);
    } finally {
      if (host) { await host.close(); host = null; }
      execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root });
    }
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
  test("completion is separate from acceptance and fabricated validation cannot accept a child", async () => {
    global.fetch = jest.fn().mockImplementation(async () => response("Child completed."));
    host = make();
    const accepted = await host.taskPort.execute({ operation: "start", command_id: "child-review", objective: "inspect project", read_only: true }, { sessionId: "main-default" });
    await host.resolveRuntime(accepted.task.id).wait(accepted.taskRunId);
    expect((await host.taskPort.execute({ operation: "inspect", task_run_id: accepted.taskRunId }, {})).task.status).toBe("completed");
    await expect(host.taskPort.execute({ operation: "accept", task_run_id: accepted.taskRunId, reason: "verified", evidence: ["invented"] }, { sessionId: "main-default" })).rejects.toThrow("validation");
    global.fetch.mockImplementation(async (_url, options) => {
      const messages = JSON.parse(options.body).messages;
      const latest = messages.filter((message) => message.role === "user").at(-1);
      return latest?.content === "verify child" && !messages.some((message) => message.tool_call_id === "validation-1")
        ? response(null, [call("validation-1", "bash", { command: "node -e 'process.exit(0)'" })]) : response("Validated.");
    });
    const reviewed = await host.runPrompt({ prompt: "verify child", requestId: "review-child" });
    const ctx = { sessionId: "main-default", taskRunId: reviewed.payload.runtime.taskRunId };
    expect((await host.taskPort.execute({ operation: "accept", task_run_id: accepted.taskRunId, reason: "passed relevant check", evidence: ["validation-1"] }, ctx)).task.status).toBe("accepted");
  });
});

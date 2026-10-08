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
    expect(tools).toEqual(expect.arrayContaining(["write", "bash", "delegate_task", "manage_tasks", "accept_task"]));
    const runtime = host.getSession();
    const events = runtime.events();
    expect(events.filter((event) => event.type === "tool.completed").map((event) => event.toolCallId)).toEqual(["write-1", "test-1"]);
    expect(events.find((event) => event.toolCallId === "test-1" && event.type === "tool.completed").result.ok).toBe(true);
    expect(JSON.stringify(runtime.snapshot())).not.toContain("isolated-vendor-key");
    expect(fs.readdirSync(path.join(root, ".ufoo/agent/main/artifacts/main-default"))).toHaveLength(2);
    await host.runPrompt({ prompt: "create and verify greeting.txt", requestId: "code-request" });
    expect(global.fetch).toHaveBeenCalledTimes(3);
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
    global.fetch = jest.fn().mockResolvedValueOnce(response(null, [call("ask-1", "ask_user", { kind: "choice", prompt: "Which file?", options: ["a", "b"], allowFreeChat: false })]));
    host = make();
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
    const request = JSON.parse(global.fetch.mock.calls[1][1].body);
    expect(request.messages.find((message) => message.tool_call_id === "ask-1").content).toContain('"selected":"1"');
    await host.getSession().resume({ interactionId, answer: "1" });
    expect(global.fetch).toHaveBeenCalledTimes(2);
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

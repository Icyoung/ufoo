"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAgentRuntime, createRuntimeStore, createCommandStore } = require("../../../src/agents/runtime");
const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports");

function transport(runTurn) {
  return createOpenAiChatTransport({ resolveUrl: () => "test://local", runTurn,
    normalizeToolName: (value) => value, normalizeToolCallArgs: (value) => JSON.parse(value),
    toJsonString: JSON.stringify, clipText: (value) => value });
}
const answer = (text) => ({ text, toolCalls: [] });
describe("durable shared runtime", () => {
  let root;
  let runtimes;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-durable-runtime-")); runtimes = []; });
  afterEach(async () => { await Promise.all(runtimes.map((runtime) => runtime.close())); fs.rmSync(root, { recursive: true, force: true }); });
  function make(runTurn, options = {}) {
    const store = options.sessionStore || createRuntimeStore({ workspaceRoot: root, namespace: "main", sessionId: "test-session" });
    const runtime = createAgentRuntime({ profile: { id: options.profileId || "main", capabilities: [] }, capabilities: [],
      transport: transport(runTurn), host: { sessionStore: store, ...options }, defaults: { model: "test", workspaceRoot: root } });
    runtimes.push(runtime);
    return runtime;
  }
  test("durably deduplicates accepted requests and recovers projections from the journal", async () => {
    const runTurn = jest.fn().mockResolvedValue(answer("done"));
    const runtime = make(runTurn);
    const first = runtime.submit({ requestId: "request-1", text: "do it" });
    expect(runtime.submit({ requestId: "request-1", text: "do it" }).taskRunId).toBe(first.taskRunId);
    expect(() => runtime.submit({ requestId: "request-1", text: "different" })).toThrow("different content");
    expect((await runtime.wait(first.taskRunId)).result.text).toBe("done");
    await runtime.close();
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "main", sessionId: "test-session" });
    fs.writeFileSync(path.join(store.directory, "snapshot.json"), "broken projection");
    const reopened = make(runTurn, { sessionStore: store });
    expect(reopened.submit({ requestId: "request-1", text: "do it" }).status).toBe("completed");
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(store.events().map((event) => event.sequence)).toEqual(store.events().map((_, index) => index + 1));
    expect(fs.statSync(store.journal).mode & 0o777).toBe(0o600);
  });
  test("keeps status responsive and cancels a running provider while preserving queued tasks", async () => {
    let started;
    const entered = new Promise((resolve) => { started = resolve; });
    const runTurn = jest.fn().mockImplementationOnce(({ signal }) => new Promise((resolve, reject) => {
      started(); signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true });
    })).mockResolvedValue(answer("next"));
    const runtime = make(runTurn);
    const first = runtime.submit({ requestId: "request-long", text: "long work" });
    const next = runtime.submit({ requestId: "request-next", text: "next work" });
    await entered;
    expect(runtime.snapshot().tasks[first.taskRunId].status).toBe("running");
    expect(runtime.cancel({ taskRunId: first.taskRunId }).status).toBe("cancelling");
    expect((await runtime.wait(first.taskRunId)).status).toBe("cancelled");
    expect((await runtime.wait(next.taskRunId)).result.text).toBe("next");
  });
  test("rejects a second live owner and pins the session profile", async () => {
    const runtime = make(jest.fn());
    expect(() => make(jest.fn())).toThrow("already owned");
    await runtime.close();
    expect(() => make(jest.fn(), { profileId: "global-router" })).toThrow("profile is pinned");
  });
  test("marks interrupted effects as uncertain without replaying the provider or tool", async () => {
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "main", sessionId: "test-session" });
    store.append({ type: "runtime.opened", owner: { id: "dead-owner", pid: 99999999, profile: "main" } });
    store.append({ type: "request.accepted", taskRunId: "task-interrupted", request: { requestId: "request-before-crash", text: "launch worker" } });
    store.append({ type: "task.started", taskRunId: "task-interrupted", attemptId: "attempt-before-crash" });
    store.append({ type: "tool.started", taskRunId: "task-interrupted", toolCallId: "launch-1", toolName: "launch_agent" });
    const runTurn = jest.fn();
    const runtime = make(runTurn, { sessionStore: store });
    expect((await runtime.wait("task-interrupted"))).toMatchObject({ status: "interrupted", effects: { "launch-1": { status: "uncertain" } } });
    expect(runTurn).not.toHaveBeenCalled();
  });
  test("ignores a torn final append and fails closed for corruption of committed events", () => {
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "main", sessionId: "test-session" });
    store.append({ type: "test" });
    fs.appendFileSync(store.journal, '{"type":"torn"');
    store.append({ type: "test-after-recovery" });
    expect(store.events().map((event) => event.type)).toEqual(["test", "test-after-recovery"]);
    fs.appendFileSync(store.journal, "broken committed event\n");
    expect(() => store.append({ type: "must-not-append" })).toThrow();
  });
  test("client observer failure does not cancel accepted work", async () => {
    const runtime = make(jest.fn().mockResolvedValue(answer("done")), { eventSink: () => { throw new Error("client disconnected"); } });
    const accepted = runtime.submit({ requestId: "request-client", text: "continue" });
    expect((await runtime.wait(accepted.taskRunId)).status).toBe("completed");
  });
  test("durable command receipts deduplicate retries and block unknown effects", async () => {
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "commands", sessionId: "control" });
    const commands = createCommandStore(store);
    const operation = jest.fn().mockResolvedValue({ ok: true, agent_id: "codex:worker" });
    const input = { commandId: "launch-1", kind: "launch", args: { agent: "codex" } };
    expect(await commands.execute(input, operation)).toMatchObject({ ok: true });
    expect(await createCommandStore(store).execute(input, operation)).toMatchObject({ agent_id: "codex:worker" });
    expect(operation).toHaveBeenCalledTimes(1);
    const failure = { commandId: "dispatch-1", kind: "dispatch", args: { message: "work" } };
    await expect(commands.execute(failure, async () => { throw new Error("lost receipt"); })).rejects.toThrow("lost receipt");
    expect(await createCommandStore(store).execute(failure, operation)).toMatchObject({ code: "uncertain_effect" });
    expect(operation).toHaveBeenCalledTimes(1);
  });
  test("capability reducers persist versioned state and event handlers submit durable commands", async () => {
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "main", sessionId: "event-session" });
    const dispose = jest.fn();
    const executor = jest.fn().mockResolvedValue({ ok: true });
    const cap = { id: "metrics", version: "1", requestedPermissions: ["metrics.write"], dispose,
      reducer(value = { turns: 0 }, event) { return { turns: value.turns + (event.type === "model.completed" ? 1 : 0) }; },
      stateCodec: { encode: (value) => ({ total: value.turns }), decode: (value) => ({ turns: value.total }) },
      handleEvent: (event) => event.type === "model.completed" ? [{ name: "record_metric", args: { taskRunId: event.taskRunId }, permissions: ["metrics.write"] }] : [],
    };
    const runtime = createAgentRuntime({ profile: { id: "main", capabilities: [cap.id] }, capabilities: [cap], transport: transport(jest.fn().mockResolvedValue(answer("done"))),
      host: { sessionStore: store, grantedPermissions: ["metrics.write"], commandExecutor: executor }, defaults: { model: "test" } });
    runtimes.push(runtime);
    const accepted = runtime.submit({ requestId: "metrics-request", text: "measure" });
    await runtime.wait(accepted.taskRunId);
    expect(runtime.snapshot().capabilityState.metrics).toEqual({ version: "1", value: { total: 1 } });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(Object.values(runtime.snapshot().commands)[0].status).toBe("resolved");
    await runtime.close(); await runtime.close();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

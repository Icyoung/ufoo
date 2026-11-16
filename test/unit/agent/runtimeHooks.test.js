"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRuntimeHooks, createRuntimeStore, createAgentRuntime } = require("../../../src/agents/runtime");
const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports");

describe("durable runtime hooks", () => {
  let root, services, runtimes;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-hooks-")); services = []; runtimes = []; });
  afterEach(async () => { services.forEach(service => service.close()); await Promise.all(runtimes.map(runtime => runtime.close())); fs.rmSync(root, { recursive: true, force: true }); });
  const source = { check: async () => ({ done: true, events: [{ key: "exit", type: "background.exited", data: { exitCode: 0 } }] }) };
  function make(options = {}) {
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "hooks", sessionId: "same" });
    const service = createRuntimeHooks({ store, sources: { process: source }, ...options });
    services.push(service); return service;
  }
  const register = service => service.register({ id: "process-1", source: "process", ownerTaskRunId: "original", spec: {} });
  test("persists matches while busy and delivers once after restart without replaying the source command", async () => {
    const deliver = jest.fn();
    const first = make({ deliver, canDeliver: () => false }); register(first);
    await first.tick(); expect(deliver).not.toHaveBeenCalled();
    expect(Object.values(first.snapshot().events)[0].status).toBe("pending");
    first.close();
    const second = make({ deliver }); await second.tick(); await second.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(Object.values(second.snapshot().events)[0].status).toBe("delivered");
  });
  test("rejects competing owners and conflicting subscriptions", () => {
    const service = make(); register(service); register(service);
    expect(() => make()).toThrow("already owned");
    expect(() => service.register({ id: "process-1", source: "process", ownerTaskRunId: "other", spec: {} })).toThrow("conflict");
  });
  test("owner cancellation revokes active watchers and already matched pending events", async () => {
    const deliver = jest.fn(); const service = make({ deliver, canDeliver: () => false }); register(service);
    await service.tick(); service.cancelOwner("original"); await service.tick();
    expect(Object.values(service.snapshot().events)[0].status).toBe("cancelled");
    expect(deliver).not.toHaveBeenCalled();
  });
  test("cancellation during delivery prevents subsequent events from the same batch waking", async () => {
    let service;
    const deliver = jest.fn(async () => { service.cancelOwner("original"); });
    service = make({ deliver, sources: { process: { check: async () => ({ done: true,
      events: [{ key: "ready", type: "ready", data: {} }, { key: "exit", type: "exit", data: {} }] }) } } });
    register(service); await service.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(Object.values(service.snapshot().events).map(event => event.status)).toEqual(["cancelled", "cancelled"]);
  });
  test("uncertain claimed delivery never re-executes after restart; unaccepted delivery retries", async () => {
    const first = make({ deliver: async (_event, claim) => { claim(); throw new Error("host died after executing"); } });
    register(first); await first.tick(); first.close();
    const deliver = jest.fn(); const second = make({ deliver }); await second.tick();
    expect(deliver).not.toHaveBeenCalled(); expect(Object.values(second.snapshot().events)[0].status).toBe("uncertain");
    second.register({ id: "process-2", source: "process", ownerTaskRunId: "next", spec: {} });
    await second.tick(); expect(deliver).toHaveBeenCalledTimes(1);
  });
  test("expiry emits once and does not call the source", async () => {
    const check = jest.fn(); const deliver = jest.fn();
    const service = make({ sources: { process: { check } }, deliver });
    service.register({ id: "expired", source: "process", ownerTaskRunId: "original", spec: {}, timeoutMs: 100 });
    const now = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
    try { await service.tick(); await service.tick(); } finally { now.mockRestore(); }
    expect(check).not.toHaveBeenCalled(); expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].type).toBe("watch.expired");
  });
  test("continues observing while a wake invocation is still executing", async () => {
    let finish;
    const deliver = jest.fn((_event, claim) => { claim(); return new Promise(resolve => { finish = resolve; }); });
    const service = make({ deliver }); register(service);
    const active = service.tick();
    await new Promise(resolve => setImmediate(resolve));
    service.register({ id: "process-2", source: "process", ownerTaskRunId: "second", spec: {} });
    await service.tick();
    expect(Object.values(service.snapshot().events).map(event => event.status)).toEqual(["claimed", "pending"]);
    service.close(); finish(true); await active;
  });
  test("runtime holds wakes behind a user interaction and resumes them after answer", async () => {
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "main", sessionId: "paused" });
    store.append({ type: "request.accepted", taskRunId: "original", request: { requestId: "original", text: "build" } });
    store.append({ type: "task.paused", taskRunId: "original", result: { interactionId: "question" } });
    const runTurn = jest.fn().mockResolvedValue({ text: "done", toolCalls: [] });
    const transport = createOpenAiChatTransport({ resolveUrl: () => "test://local", runTurn });
    const runtime = createAgentRuntime({ profile: { id: "test", capabilities: [] }, capabilities: [], transport,
      host: { sessionStore: store, hookSources: { process: source }, resumeRequest: async () => ({ prompt: "answer" }) },
      defaults: { model: "test" } });
    runtimes.push(runtime); register(runtime.hooks);
    await runtime.hooks.tick(); expect(runTurn).not.toHaveBeenCalled();
    const event = Object.values(runtime.hooks.snapshot().events)[0];
    const accepted = runtime.wake(event); // Also protect already accepted queue entries.
    await new Promise(resolve => setImmediate(resolve)); expect(runTurn).not.toHaveBeenCalled();
    await runtime.resume({ interactionId: "question", answer: "yes" });
    await runtime.wait(accepted.taskRunId); await runtime.hooks.tick();
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runtime.wake(event).taskRunId).toBe(accepted.taskRunId);
  });
  test("cancelling an owner also settles an already accepted queued wake", async () => {
    const store = createRuntimeStore({ workspaceRoot: root, namespace: "main", sessionId: "cancel" });
    store.append({ type: "request.accepted", taskRunId: "original", request: { requestId: "original", text: "build" } });
    store.append({ type: "task.completed", taskRunId: "original", result: { text: "waiting for exit" } });
    const runtime = createAgentRuntime({ profile: { id: "test", capabilities: [] }, capabilities: [],
      transport: createOpenAiChatTransport({ resolveUrl: () => "test://local", runTurn: jest.fn() }),
      host: { sessionStore: store } }); runtimes.push(runtime);
    const accepted = runtime.wake({ id: "wake-build", ownerTaskRunId: "original", type: "background.exited", data: {} });
    const waiting = runtime.wait(accepted.taskRunId);
    runtime.cancel({ taskRunId: "original" });
    expect((await waiting).status).toBe("cancelled");
  });
});

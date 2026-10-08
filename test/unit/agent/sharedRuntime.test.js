"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createAgentRuntime, composeCapabilities, createToolRegistry, createSessionJournal, createSessionStore } = require("../../../src/agents/runtime");
const { createOpenAiChatTransport } = require("../../../src/agents/providers/transports");
const { getNativeTransport } = require("../../../src/agents/providers/nativeTransport");

function transportFor(runTurn) {
  return createOpenAiChatTransport({
    resolveUrl: () => "https://runtime.invalid/v1/chat/completions", runTurn,
    normalizeToolName: (name) => name,
    normalizeToolCallArgs: (args) => JSON.parse(args || "{}"),
    toJsonString: JSON.stringify, clipText: (text) => text,
  });
}
function capability(handler = jest.fn(() => ({ ok: true, count: 2 }))) {
  return {
    id: "agent-status", version: "1.0", tools: [{
      name: "list_agents", description: "List project agents",
      inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false },
      permissions: ["agents.read"], handler,
    }],
  };
}
function call(id = "call-status", args = { project: "demo" }) {
  return { id, type: "function", function: { name: "list_agents", arguments: JSON.stringify(args) } };
}
function runtimeFor(cap, transport, options = {}) {
  return createAgentRuntime({
    capabilities: [cap], profile: { capabilities: [cap.id] }, transport,
    host: { grantedPermissions: ["agents.read"], ...options },
  });
}

describe("capability-composed shared agent runtime", () => {
  test("runs a coordination-only tool using the provider transport with paired results", async () => {
    const cap = capability();
    const runTurn = jest.fn()
      .mockResolvedValueOnce({ text: "", toolCalls: [call()], usage: { input: 12, output: 3 } })
      .mockResolvedValueOnce({ text: "Two agents online", toolCalls: [], usage: { input: 20, output: 4 } });
    const runtime = runtimeFor(cap, transportFor(runTurn));
    const result = await runtime.run({ prompt: "show status", model: "test", baseUrl: "https://runtime.invalid" });
    expect(result.text).toBe("Two agents online");
    expect(result.usage).toMatchObject({ turns: 2, input: 32, output: 7 });
    expect(cap.tools[0].handler).toHaveBeenCalledTimes(1);
    expect(runTurn.mock.calls[0][0].tools.map((tool) => tool.function.name)).toEqual(["list_agents"]);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(result.messages[2]).toMatchObject({ tool_call_id: "call-status" });
    expect(result.protocolLedger.calls["call-status"].state).toBe("resolved");
  });

  test("the real HTTP provider accepts the injected tool set instead of advertising coding tools", async () => {
    const previousFetch = global.fetch;
    const fetch = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call()] } }] }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { headers: { "content-type": "application/json" } }));
    global.fetch = fetch;
    try {
      const result = await runtimeFor(capability(), getNativeTransport("openai-chat")).run({
        prompt: "status", model: "test", baseUrl: "https://runtime.invalid", apiKey: "isolated-runtime-test",
      });
      expect(result.text).toContain("done");
      const request = JSON.parse(fetch.mock.calls[0][1].body);
      expect(request.tools.map((tool) => tool.function.name)).toEqual(["list_agents"]);
      expect(JSON.parse(fetch.mock.calls[1][1].body).messages.some((message) => message.tool_call_id === "call-status")).toBe(true);
    } finally { global.fetch = previousFetch; }
  });

  test.each([
    ["invalid schema arguments", { wrong: true }, null, "invalid_tool_arguments"],
    ["a revoked host grant", { project: "demo" }, () => false, "forbidden_tool"],
  ])("does not execute %s", async (_label, args, authorizeTool, code) => {
    const cap = capability();
    const runTurn = jest.fn().mockResolvedValueOnce({ text: "", toolCalls: [call("call-denied", args)] }).mockResolvedValueOnce({ text: "denied", toolCalls: [] });
    const result = await runtimeFor(cap, transportFor(runTurn), { authorizeTool }).run({ prompt: "status", model: "test", baseUrl: "test" });
    expect(cap.tools[0].handler).not.toHaveBeenCalled();
    expect(JSON.parse(result.messages[2].content).code).toBe(code);
    expect(result.protocolLedger.calls["call-denied"].state).toBe("resolved");
  });

  test("rejects unregistered model tool calls without adding coding privileges", async () => {
    const cap = capability();
    const forbidden = { id: "call-write", function: { name: "write", arguments: '{"path":"secret","content":"bad"}' } };
    const runTurn = jest.fn().mockResolvedValueOnce({ text: "", toolCalls: [forbidden] }).mockResolvedValueOnce({ text: "denied", toolCalls: [] });
    const result = await runtimeFor(cap, transportFor(runTurn)).run({ prompt: "status", model: "test", baseUrl: "test" });
    expect(cap.tools[0].handler).not.toHaveBeenCalled();
    expect(JSON.parse(result.messages[2].content).code).toBe("unsupported_tool");
  });

  test("rejects duplicate provider call IDs before executing any effects", async () => {
    const cap = capability();
    const runTurn = jest.fn().mockResolvedValue({ text: "", toolCalls: [call(), call()] });
    await expect(runtimeFor(cap, transportFor(runTurn)).run({ prompt: "status", model: "test", baseUrl: "test" })).rejects.toMatchObject({ code: "duplicate_tool_call_id" });
    expect(cap.tools[0].handler).not.toHaveBeenCalled();
  });

  test("keeps single ownership of a running runtime and accepts another run after completion", async () => {
    let resolveTurn;
    const runTurn = jest.fn(() => new Promise((resolve) => { resolveTurn = resolve; }));
    const runtime = runtimeFor(capability(), transportFor(runTurn));
    const input = { prompt: "status", model: "test", baseUrl: "test" };
    const running = runtime.run(input);
    await expect(runtime.run(input)).rejects.toMatchObject({ code: "runtime_busy" });
    resolveTurn({ text: "done", toolCalls: [] });
    await running;
    runTurn.mockResolvedValueOnce({ text: "again", toolCalls: [] });
    expect((await runtime.run(input)).text).toBe("again");
  });

  test("an aborted run has no model/tool effects and does not leave the runtime busy", async () => {
    const controller = new AbortController(); controller.abort();
    const runTurn = jest.fn().mockResolvedValue({ text: "ok", toolCalls: [] });
    const runtime = runtimeFor(capability(), transportFor(runTurn));
    await expect(runtime.run({ model: "test", baseUrl: "test", signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(runTurn).not.toHaveBeenCalled();
    expect((await runtime.run({ model: "test", baseUrl: "test", prompt: "retry" })).text).toBe("ok");
  });

  test("a custom deferred interaction is independent of ask_user", async () => {
    const cap = capability(); cap.tools[0].deferable = true;
    cap.tools[0].handler = jest.fn(() => ({ ok: true, deferToolResult: true, interactionId: "choice-1" }));
    const runTurn = jest.fn().mockResolvedValue({ text: "", toolCalls: [call()] });
    const result = await runtimeFor(cap, transportFor(runTurn)).run({ model: "test", baseUrl: "test" });
    expect(result).toMatchObject({ waitingUserInteraction: true, interactionId: "choice-1" });
    expect(result.protocolLedger.calls["call-status"].state).toBe("deferred");
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  test("capabilities can supply scoped context without registering tools", async () => {
    const composition = composeCapabilities({ capabilities: [{ id: "summary", version: "1", contextSources: [(input) => ({ project: input.project, source: "registry" })] }] });
    expect(await composition.buildContext({ project: "demo" })).toEqual([{ capabilityId: "summary", value: { project: "demo", source: "registry" } }]);
  });

  test("rejects duplicate tools and missing host grants at creation", () => {
    const cap = capability();
    expect(() => createToolRegistry({ tools: [cap.tools[0]] })).toThrow("requires permission");
    expect(() => createToolRegistry({ tools: [cap.tools[0], cap.tools[0]], grantedPermissions: ["agents.read"] })).toThrow("duplicate runtime tool");
  });

  test("resolves dependencies and rejects missing/circular dependencies and missing ports", () => {
    const base = { id: "base", version: "1" };
    const dependent = { id: "dependent", version: "1", requires: { capabilities: ["base"] } };
    expect(composeCapabilities({ capabilities: [dependent, base], profile: { capabilities: ["dependent"] } }).capabilities.map((cap) => cap.id)).toEqual(["base", "dependent"]);
    expect(() => composeCapabilities({ capabilities: [dependent] })).toThrow("missing capability");
    expect(() => composeCapabilities({ capabilities: [dependent, { ...base, requires: { capabilities: ["dependent"] } }] })).toThrow("circular capability");
    expect(() => composeCapabilities({ capabilities: [{ ...base, requires: { ports: ["coordination"] } }] })).toThrow("requires host port");
    expect(() => composeCapabilities({ capabilities: [{ ...base, requires: { providerFeatures: ["custom-feature"] } }] })).toThrow("requires provider feature");
    expect(() => composeCapabilities({ capabilities: [{ ...base, requestedPermissions: ["agents.manage"] }] })).toThrow("requires permission");
  });
});

describe("shared session journal namespaces", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-runtime-journal-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test("isolates main and coding histories with the same session ID and retains append idempotency", () => {
    const main = createSessionJournal({ namespace: "main" });
    const coding = createSessionJournal({ namespace: "ucode" });
    main.appendTurnMessages(root, "same-session", "turn-1", [{ role: "user", content: "coordinate" }]);
    coding.appendTurnMessages(root, "same-session", "turn-1", [{ role: "user", content: "code" }]);
    main.appendTurnMessages(root, "same-session", "turn-1", [{ role: "user", content: "coordinate" }]);
    expect(main.loadTranscriptProjection(root, "same-session").events.map((event) => event.content)).toEqual(["coordinate"]);
    expect(coding.loadTranscriptProjection(root, "same-session").events.map((event) => event.content)).toEqual(["code"]);
    expect(coding.getJournalPath(root, "same-session")).toBe(path.join(root, ".ufoo/agent/ucode/journal/same-session.jsonl"));
  });

  test("rejects namespaces/session IDs that escape the bound directory", () => {
    expect(() => createSessionJournal({ namespace: "../outside" })).toThrow("invalid session namespace");
    const journal = createSessionJournal({ namespace: "main" });
    expect(journal.appendTurnMessages(root, "../../outside", "turn-1", [{ role: "user", content: "bad" }]).ok).toBe(false);
    expect(journal.getJournalPath(root, "../../outside")).toBe("");
    expect(fs.existsSync(path.join(root, ".ufoo"))).toBe(false);
  });

  test("stores independent snapshots through host codecs without assuming coding state", () => {
    const store = createSessionStore({
      namespace: "main",
      encode: (snapshot) => ({ ...snapshot, version: 1 }),
      toDisk: ({ transient, ...snapshot }) => snapshot,
      decode: (snapshot, { sessionId }) => ({ ...snapshot, sessionId, hydrated: true }),
    });
    const saved = store.save(root, { sessionId: "same-session", routes: ["worker-1"], transient: true });
    expect(saved.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(saved.filePath, "utf8"))).toEqual({ version: 1, sessionId: "same-session", routes: ["worker-1"] });
    expect(store.load(root, "same-session").snapshot.hydrated).toBe(true);
    expect(createSessionStore({ namespace: "ucode" }).load(root, "same-session").ok).toBe(false);
    expect(fs.statSync(saved.filePath).mode & 0o777).toBe(0o600);
  });

  test("a failed snapshot commit retains previous data and removes temporary files", () => {
    const store = createSessionStore({ namespace: "main" });
    const saved = store.save(root, { sessionId: "same-session", value: "original" });
    const rename = jest.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("injected commit failure"); });
    try {
      expect(store.save(root, { sessionId: "same-session", value: "replacement" }).ok).toBe(false);
    } finally { rename.mockRestore(); }
    expect(store.load(root, "same-session").snapshot.value).toBe("original");
    expect(fs.readdirSync(path.dirname(saved.filePath))).toEqual(["same-session.json"]);
  });
});

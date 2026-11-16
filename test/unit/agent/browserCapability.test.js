"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createBrowserSessions, readConnectionConfig, browserProcessEnvironment } = require("../../../src/runtime/browser/playwrightSession");
const { createBrowserCapability } = require("../../../src/agents/capabilities/browser");
const { createToolRegistry } = require("../../../src/agents/runtime/tools/registry");
const { createOpenAiChatTransport, createOpenAiResponsesTransport, createAnthropicMessagesTransport } = require("../../../src/agents/providers/transports");

const definition = (name, properties = {}, required = []) => ({ name, description: name,
  inputSchema: { type: "object", properties, required, additionalProperties: false } });
const definitions = [
  definition("browser_tabs", { action: { type: "string", enum: ["list", "select", "new", "close"] }, index: { type: "integer" }, isolatedContext: { type: "string" } }, ["action"]),
  definition("browser_snapshot"), definition("browser_take_screenshot"),
  definition("browser_click", { target: { type: "string" } }, ["target"]),
  definition("browser_run_code"), definition("browser_install"), definition("browser_close"),
];
const ok = text => ({ content: [{ type: "text", text }], isError: false });

describe("shared Playwright browser capability", () => {
  let root, manager, created, factory, context;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-browser-test-"));
    context = { workspaceRoot: root, sessionId: "daily", artifactNamespace: "ucode" };
    created = [];
    factory = jest.fn(options => {
      const client = { connect: jest.fn(async () => {}), listTools: jest.fn(async () => ({ tools: definitions })),
        callTool: jest.fn(async () => ok("page snapshot")), close: jest.fn(async () => {}) };
      const transport = { close: jest.fn(async () => {}) };
      const connection = { client, transport, options }; created.push(connection); return connection;
    });
    manager = createBrowserSessions({ createConnection: factory, env: {} });
  });
  afterEach(async () => { await manager.closeAll(); fs.rmSync(root, { recursive: true, force: true }); jest.restoreAllMocks(); });
  const call = (tool, args = {}) => ({ operation: "call", tool, arguments: args });

  test("status is lazy, tool discovery does not control Chrome, and schemas are discoverable", async () => {
    expect(await manager.execute({ operation: "status" }, context)).toMatchObject({ state: "disconnected", mode: "extension" });
    expect(factory).not.toHaveBeenCalled();
    const tools = await manager.execute({ operation: "tools" }, context);
    expect(tools.tools.map(tool => tool.name)).not.toContain("browser_install");
    expect(tools.tools.map(tool => tool.name)).not.toContain("browser_run_code");
    expect(created[0].client.callTool).not.toHaveBeenCalled();
    expect(await manager.execute({ operation: "tools", tool: "browser_click" }, context)).toMatchObject({ inputSchema: { required: ["target"] } });
    expect(await manager.execute(call("browser_click", { ref: "e1" }), context)).toMatchObject({ ok: false, code: "invalid_browser_arguments" });
    expect(created[0].client.callTool).not.toHaveBeenCalled();
  });

  test("reuses a connection across turns and isolates project, namespace and session ownership", async () => {
    await manager.execute({ operation: "connect" }, context);
    await manager.execute(call("browser_snapshot"), { ...context, taskRunId: "next-turn" });
    expect(factory).toHaveBeenCalledTimes(1);
    await manager.execute({ operation: "connect" }, { ...context, sessionId: "other" });
    await manager.execute({ operation: "connect" }, { ...context, artifactNamespace: "main" });
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-browser-other-"));
    try {
      await manager.execute({ operation: "connect" }, { ...context, workspaceRoot: otherRoot });
      expect(new Set(created.map(item => item.options.name)).size).toBe(4);
    } finally { await manager.disconnect({ ...context, workspaceRoot: otherRoot }); fs.rmSync(otherRoot, { recursive: true, force: true }); }
  });

  test("serializes actions on one connection", async () => {
    await manager.execute({ operation: "tools" }, context);
    let finish;
    created[0].client.callTool.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = manager.execute(call("browser_click", { target: "e1" }), context);
    await new Promise(resolve => setImmediate(resolve));
    const second = manager.execute(call("browser_snapshot"), context);
    await new Promise(resolve => setImmediate(resolve));
    expect(created[0].client.callTool).toHaveBeenCalledTimes(1);
    finish(ok("clicked"));
    await Promise.all([first, second]);
    expect(created[0].client.callTool).toHaveBeenCalledTimes(2);
  });

  test("does not replay actions after transport failure; reconnect must be explicit", async () => {
    await manager.execute({ operation: "connect" }, context);
    created[0].client.callTool.mockRejectedValueOnce(new Error("connection lost with private token"));
    const failed = await manager.execute(call("browser_click", { target: "submit" }), context);
    expect(failed).toMatchObject({ ok: false, code: "browser_action_uncertain" });
    expect(JSON.stringify(failed)).not.toContain("private token");
    expect(await manager.execute(call("browser_snapshot"), context)).toMatchObject({ code: "browser_reconnect_required" });
    expect(factory).toHaveBeenCalledTimes(1);
    await manager.execute({ operation: "connect" }, context);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(created[1].client.callTool).toHaveBeenCalledTimes(1);
    expect(created[1].client.callTool.mock.calls[0][0]).toEqual({ name: "browser_tabs", arguments: { action: "list" } });
  });

  test("cancels in-flight work and does not execute already cancelled requests", async () => {
    await manager.execute({ operation: "tools" }, context);
    const controller = new AbortController();
    created[0].client.callTool.mockImplementationOnce((_params, _schema, options) => new Promise((resolve, reject) => {
      expect(options.timeout).toBe(60000);
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const pending = manager.execute(call("browser_click", { target: "e1" }), { ...context, signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    expect(await pending).toMatchObject({ code: "browser_action_uncertain" });
    expect(await manager.execute({ operation: "connect" }, { ...context, signal: controller.signal })).toMatchObject({ code: "cancelled" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("ordinary stale references remain recoverable without reconnecting", async () => {
    await manager.execute({ operation: "connect" }, context);
    created[0].client.callTool.mockResolvedValueOnce({ ...ok("target no longer exists; snapshot again"), isError: true });
    expect(await manager.execute(call("browser_click", { target: "e1" }), context)).toMatchObject({ code: "browser_action_failed" });
    expect(await manager.execute(call("browser_snapshot"), context)).toMatchObject({ ok: true });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  test("plan mode permits inspection, blocks mutations and forbids separate browser contexts", async () => {
    const plan = { ...context, executionState: { planMode: true } };
    expect(await manager.execute(call("browser_click", { target: "e1" }), plan)).toMatchObject({ code: "plan_mode" });
    expect(factory).not.toHaveBeenCalled();
    expect(await manager.execute(call("browser_snapshot"), plan)).toMatchObject({ ok: true });
    expect(await manager.execute(call("browser_tabs", { action: "new", isolatedContext: "isolated" }), context)).toMatchObject({ code: "existing_browser_only" });
  });

  test("saves full long text and returns images through the shared vision shape", async () => {
    await manager.execute({ operation: "tools" }, context);
    const text = "long page\n".repeat(4000);
    created[0].client.callTool.mockResolvedValueOnce({ content: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] });
    const result = await manager.execute(call("browser_take_screenshot"), context);
    expect(result).toMatchObject({ ok: true, truncated: true, mediaType: "image/png", base64: "aW1hZ2U=" });
    expect(result.text.length).toBeLessThan(16200);
    expect(fs.readFileSync(result.outputPath, "utf8")).toBe(text);
    expect(fs.readFileSync(result.path).toString()).toBe("image");
    for (const factory of [createOpenAiChatTransport, createOpenAiResponsesTransport, createAnthropicMessagesTransport]) {
      const transport = factory({ resolveUrl: () => "test://browser", runTurn: async () => ({}), toJsonString: JSON.stringify, clipText: value => value });
      const messages = [], collected = [];
      transport.appendToolResult({ messages, collected, call: { id: "screenshot", name: "browser", source: { id: "screenshot" } }, toolResult: result });
      expect(JSON.stringify([...messages, ...collected])).toContain("aW1hZ2U=");
    }
  });

  test("CDP leases are released on disconnect and failed initialization", async () => {
    const release = jest.fn(async () => {});
    const acquireLease = jest.fn(async () => release);
    await manager.closeAll();
    manager = createBrowserSessions({ createConnection: factory, env: { UFOO_BROWSER_CDP_ENDPOINT: "chrome" }, acquireLease });
    await manager.execute({ operation: "connect" }, context);
    expect(created[0].options.config).toMatchObject({ mode: "cdp", endpoint: "chrome" });
    await manager.disconnect(context);
    expect(release).toHaveBeenCalledTimes(1);
    factory.mockImplementationOnce(() => { throw new Error("initialization failed"); });
    expect(await manager.execute({ operation: "connect" }, context)).toMatchObject({ code: "browser_connection_failed" });
    expect(release).toHaveBeenCalledTimes(2);
  });

  test("CDP contention never starts a second client or falls back to extension", async () => {
    await manager.closeAll();
    manager = createBrowserSessions({ createConnection: factory, env: { UFOO_BROWSER_CDP_ENDPOINT: "chrome" },
      acquireLease: async () => { throw Object.assign(new Error("busy"), { code: "browser_busy" }); } });
    expect(await manager.execute({ operation: "connect" }, context)).toMatchObject({ code: "browser_busy" });
    expect(factory).not.toHaveBeenCalled();
  });

  test("host grants gate capability and disposal disconnects without closing Chrome", async () => {
    const capability = createBrowserCapability({ sessions: manager });
    expect(() => createToolRegistry({ tools: capability.tools, grantedPermissions: [] })).toThrow("browser.control");
    const registry = createToolRegistry({ tools: capability.tools, grantedPermissions: ["browser.control"] });
    const onToolEvent = jest.fn();
    await registry.execute("browser", { operation: "connect" }, { ...context, onToolEvent });
    expect(onToolEvent.mock.calls.map(([event]) => event.phase)).toEqual(["start", "end"]);
    await capability.dispose();
    expect(created[0].client.close).toHaveBeenCalled();
    expect(created[0].client.callTool.mock.calls.every(([params]) => params.name !== "browser_close")).toBe(true);
  });

  test("real pinned MCP advertises tools without launching or attaching a browser", async () => {
    await manager.closeAll();
    manager = createBrowserSessions({ env: {} });
    const result = await manager.execute({ operation: "tools", tool: "browser_click" }, context);
    expect(result).toMatchObject({ ok: true, name: "browser_click", inputSchema: { required: ["target"] } });
    expect(await manager.execute({ operation: "tools", tool: "browser_mouse_click_xy" }, context)).toMatchObject({ ok: true, inputSchema: { required: ["x", "y"] } });
    expect(await manager.execute({ operation: "status" }, context)).toMatchObject({ state: "ready" });
  });

  test("connection configuration defaults to extension and rejects invalid endpoints", () => {
    const config = readConnectionConfig({});
    expect(config.mode).toBe("extension");
    expect(() => readConnectionConfig({ UFOO_BROWSER_CDP_ENDPOINT: "file:///tmp/profile" })).toThrow();
    expect(readConnectionConfig({ UFOO_BROWSER_CDP_ENDPOINT: "chrome" })).toMatchObject({ mode: "cdp", endpoint: "chrome" });
  });

  test("passes desktop connection environment without forwarding model credentials", () => {
    const childEnv = browserProcessEnvironment({ TMPDIR: "/tmp/browser", DISPLAY: ":1", PLAYWRIGHT_MCP_EXTENSION_TOKEN: "extension-test", OPENAI_API_KEY: "private-model-key" });
    expect(childEnv).toMatchObject({ TMPDIR: "/tmp/browser", DISPLAY: ":1", PLAYWRIGHT_MCP_EXTENSION_TOKEN: "extension-test" });
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
  });

  test("idle expiry releases the connection and requires a fresh tab inspection", async () => {
    await manager.closeAll();
    jest.useFakeTimers();
    manager = createBrowserSessions({ env: {}, createConnection: factory, idleMs: 1000 });
    try {
      await manager.execute({ operation: "connect" }, context);
      await jest.advanceTimersByTimeAsync(1001);
      expect(created[0].client.close).toHaveBeenCalled();
      expect(await manager.execute(call("browser_snapshot"), context)).toMatchObject({ code: "browser_reconnect_required" });
    } finally { jest.useRealTimers(); }
  });

  test("an unexpected client exit releases its lease without waiting for another call", async () => {
    await manager.closeAll();
    const release = jest.fn(async () => {});
    manager = createBrowserSessions({ env: { UFOO_BROWSER_CDP_ENDPOINT: "chrome" }, createConnection: factory, acquireLease: async () => release });
    await manager.execute({ operation: "connect" }, context);
    created[0].client.onclose();
    await new Promise(resolve => setImmediate(resolve));
    expect(release).toHaveBeenCalledTimes(1);
    expect(await manager.execute({ operation: "status" }, context)).toMatchObject({ state: "disconnected", reconnectRequired: true });
  });
});

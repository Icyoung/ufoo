"use strict";

const { PassThrough } = require("stream");

const {
  createMcpStdioProxy,
  validateEndpoint,
} = require("../../../src/runtime/daemon/mcpStdioProxy");
const {
  createGlobalMcpHttpServer,
} = require("../../../src/runtime/daemon/mcpHttpServer");

function parseLines(stream) {
  let buffer = "";
  const messages = [];
  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.trim()) messages.push(JSON.parse(line));
    }
  });
  return messages;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for proxy output");
}

const initializeRequest = {
  jsonrpc: "2.0", id: "init", method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
};

function makeProxy(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  errors.resume();
  return createMcpStdioProxy({
    input, output, errorOutput: errors,
    endpoint: "http://127.0.0.1:47631/mcp", token: "test", autoStart: false,
    ...options,
  });
}

describe("MCP stdio compatibility proxy", () => {
  test("rejects non-loopback upstream endpoints", () => {
    expect(() => validateEndpoint("https://example.com/mcp"))
      .toThrow("Refusing non-loopback");
    expect(validateEndpoint("http://127.0.0.1:47631/mcp"))
      .toBe("http://127.0.0.1:47631/mcp");
  });

  test("forwards protocol traffic without owning Agent registrations", async () => {
    const call = jest.fn(async (projectRoot, operation, args) => ({
      ok: true,
      project_root: projectRoot,
      operation,
      subscriber: args.subscriber,
    }));
    const upstream = createGlobalMcpHttpServer({
      projectRoot: "/tmp/ufoo-mcp-proxy-test",
      port: 0,
      token: "proxy-token",
      validateProjectRoot: false,
      endpointPath: "/tmp/ufoo-mcp-proxy-endpoint.json",
      projectRuntimeGateway: { call, cancel: () => false },
    });
    await upstream.start();

    const input = new PassThrough();
    const output = new PassThrough();
    const errors = new PassThrough();
    const messages = parseLines(output);
    const proxy = createMcpStdioProxy({
      input,
      output,
      errorOutput: errors,
      endpoint: upstream.endpoint,
      token: "proxy-token",
      autoStart: false,
    }).start();

    try {
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-test", version: "1.0.0" },
        },
      })}\n`);
      await waitFor(() => messages.find((message) => message.id === "init"));

      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`);
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "call",
        method: "tools/call",
        params: {
          name: "heartbeat_agent",
          arguments: {
            project_root: "/tmp/ufoo-mcp-proxy-test",
            subscriber: "codex:proxy",
            agent_handle: "proxy-test-handle",
          },
        },
      })}\n`);
      const response = await waitFor(() => messages.find((message) => message.id === "call"));
      expect(response.result.structuredContent).toMatchObject({
        operation: "heartbeat_agent",
        subscriber: "codex:proxy",
      });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await proxy.close();
      await upstream.stop();
    }

    expect(call.mock.calls.map((entry) => entry[1])).not.toContain("unregister_agent");
  });

  test("recovers concurrent reads after a real daemon restart without re-registering Agents", async () => {
    const call = jest.fn(async () => ({ ok: true }));
    const upstream = createGlobalMcpHttpServer({
      projectRoot: "/tmp/ufoo-mcp-proxy-restart", port: 0, token: "restart",
      endpointPath: "/tmp/ufoo-mcp-proxy-restart-endpoint.json",
      validateProjectRoot: false, projectRuntimeGateway: { call },
    });
    await upstream.start();
    const proxy = makeProxy({ endpoint: upstream.endpoint, token: "restart" });
    proxy.output.resume();
    try {
      expect((await proxy.forward(initializeRequest)).result).toBeTruthy();
      const oldSession = proxy.sessionId;
      await upstream.stop();
      await upstream.start();
      const responses = await Promise.all([1, 2].map((id) => proxy.forward({
        jsonrpc: "2.0", id, method: "tools/list",
      })));
      expect(responses.every((response) => response.result?.tools.length > 0)).toBe(true);
      expect(proxy.sessionId).not.toBe(oldSession);
      expect(upstream.getStatus().session_count).toBe(1);
      expect(call).not.toHaveBeenCalled();
    } finally {
      await proxy.close();
      await upstream.stop();
    }
  });

  test("does not replay a write whose response was lost", async () => {
    let writes = 0;
    const fakeFetch = jest.fn(async (_endpoint, options) => {
      const request = options.body ? JSON.parse(options.body) : {};
      if (request.method === "tools/call") {
        writes += 1;
        throw new TypeError("fetch failed after commit");
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: "2025-06-18",
      } }), { status: 200, headers: { "mcp-session-id": "session" } });
    });
    const proxy = makeProxy({ fetch: fakeFetch });
    proxy.output.resume();
    try {
      await proxy.forward(initializeRequest);
      const response = await proxy.forward({
        jsonrpc: "2.0", id: "send", method: "tools/call", params: { name: "dispatch_message", arguments: {} },
      });
      expect(writes).toBe(1);
      expect(response.error.data.code).toBe("UFOO_MCP_OUTCOME_UNKNOWN");
    } finally { await proxy.close(); }
  });

  test("restores an outstanding resident wait after a restart gap without changing its Agent identity", async () => {
    let initialized = 0;
    let waits = 0;
    const identity = { project_root: "/tmp/project", subscriber: "codex:stable", agent_handle: "private", timeout_seconds: 0 };
    const fakeFetch = jest.fn(async (_endpoint, options) => {
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(options.body);
      if (request.method === "initialize") {
        initialized += 1;
        if (initialized === 2) throw new TypeError("listener still restarting");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } }), {
          headers: { "mcp-session-id": `session-${initialized}` },
        });
      }
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      waits += 1;
      expect(request.params.arguments).toEqual(identity);
      if (waits === 1) throw new TypeError("listener restarted while waiting");
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { status: "message", last_seq: 7 } } }));
    });
    const proxy = makeProxy({ fetch: fakeFetch, endpointPollMs: 5 });
    proxy.output.resume();
    try {
      await proxy.forward(initializeRequest);
      const result = await proxy.forward({ jsonrpc: "2.0", id: "wait", method: "tools/call", params: { name: "wait_for_message", arguments: identity } });
      expect(result.result.structuredContent).toMatchObject({ status: "message", last_seq: 7 });
      expect(waits).toBe(2);
      expect(initialized).toBe(3);
    } finally { await proxy.close(); }
  });

  test("keeps resident waits pending past the ordinary timeout and cancels them locally", async () => {
    const fakeFetch = jest.fn(async (_endpoint, options) => {
      const request = options.body ? JSON.parse(options.body) : {};
      if (request.method === "tools/call") {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: "2025-06-18",
      } }), { status: 200, headers: { "mcp-session-id": "session" } });
    });
    const proxy = makeProxy({ fetch: fakeFetch, requestTimeoutMs: 30 });
    proxy.output.resume();
    try {
      await proxy.forward(initializeRequest);
      let completed = false;
      const wait = proxy.forward({
        jsonrpc: "2.0", id: "wait", method: "tools/call",
        params: { name: "wait_for_message", arguments: { timeout_seconds: 0 } },
      }).then((response) => { completed = true; return response; });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(completed).toBe(false);
      await proxy.forward({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "wait" } });
      expect((await wait).error).toBeTruthy();
      expect(proxy.activeRequests.size).toBe(0);
    } finally { await proxy.close(); }
  });

  test("reports initialization failures to requests waiting for the handshake", async () => {
    const proxy = makeProxy({ fetch: async () => { throw new Error("unavailable"); } });
    proxy.output.resume();
    const responses = await Promise.all([
      proxy.forward(initializeRequest),
      proxy.forward({ jsonrpc: "2.0", id: "list", method: "tools/list" }),
    ]);
    expect(responses.every((response) => response.error)).toBe(true);
    await proxy.close();
  });
});

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
});

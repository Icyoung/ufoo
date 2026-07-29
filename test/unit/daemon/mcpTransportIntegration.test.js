"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

const {
  createGlobalMcpHttpServer,
} = require("../../../src/runtime/daemon/mcpHttpServer");
const {
  createMcpStdioProxy,
} = require("../../../src/runtime/daemon/mcpStdioProxy");
const {
  createLocalProjectRuntimeGateway,
} = require("../../../src/runtime/daemon/projectRuntimeGateway");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

function initializeProject(root) {
  const paths = getUfooPaths(root);
  fs.mkdirSync(paths.busQueuesDir, { recursive: true });
  fs.mkdirSync(paths.busEventsDir, { recursive: true });
  fs.mkdirSync(paths.busLogsDir, { recursive: true });
  fs.mkdirSync(paths.busOffsetsDir, { recursive: true });
  fs.mkdirSync(paths.agentDir, { recursive: true });
  fs.mkdirSync(paths.runDir, { recursive: true });
  fs.writeFileSync(paths.agentsFile, JSON.stringify({
    created_at: new Date().toISOString(),
    agents: {},
  }, null, 2));
}

function headers(token, sessionId = "") {
  return {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
}

async function httpRpc(endpoint, token, body, sessionId = "") {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: headers(token, sessionId),
    body: JSON.stringify(body),
  });
  return {
    response,
    payload: response.status === 202 ? null : await response.json(),
  };
}

function collectLines(stream) {
  const messages = [];
  let buffer = "";
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

async function waitFor(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for MCP transport integration");
}

describe("MCP HTTP and stdio transport interoperability", () => {
  test("collaborates across transports without adapter-owned membership", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-transports-"));
    initializeProject(projectRoot);
    const token = "transport-integration-token";
    const server = createGlobalMcpHttpServer({
      projectRoot,
      port: 0,
      token,
      validateProjectRoot: false,
      endpointPath: path.join(projectRoot, ".ufoo", "run", "test-mcp-endpoint.json"),
      projectRuntimeGateway: createLocalProjectRuntimeGateway(),
    });
    await server.start();

    const proxyInput = new PassThrough();
    const proxyOutput = new PassThrough();
    const proxyErrors = new PassThrough();
    const proxyMessages = collectLines(proxyOutput);
    const proxy = createMcpStdioProxy({
      input: proxyInput,
      output: proxyOutput,
      errorOutput: proxyErrors,
      endpoint: server.endpoint,
      token,
      autoStart: false,
    }).start();

    try {
      const initializedA = await httpRpc(server.endpoint, token, {
        jsonrpc: "2.0",
        id: "init-a",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "http-a", version: "1.0.0" },
        },
      });
      const sessionA = initializedA.response.headers.get("mcp-session-id");
      const registeredA = await httpRpc(server.endpoint, token, {
        jsonrpc: "2.0",
        id: "register-a",
        method: "tools/call",
        params: {
          name: "register_agent",
          arguments: {
            project_root: projectRoot,
            agent_type: "codex",
            client_instance_id: "http-a",
          },
        },
      }, sessionA);
      const agentA = registeredA.payload.result.structuredContent;

      proxyInput.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "init-b",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stdio-b", version: "1.0.0" },
        },
      })}\n`);
      await waitFor(() => proxyMessages.find((message) => message.id === "init-b"));
      proxyInput.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })}\n`);
      proxyInput.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "register-b",
        method: "tools/call",
        params: {
          name: "register_agent",
          arguments: {
            project_root: projectRoot,
            agent_type: "cursor",
            client_instance_id: "stdio-b",
          },
        },
      })}\n`);
      const registeredB = await waitFor(
        () => proxyMessages.find((message) => message.id === "register-b")
      );
      const agentB = registeredB.result.structuredContent;

      proxyInput.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: "wait-b",
        method: "tools/call",
        params: {
          name: "wait_for_message",
          arguments: {
            project_root: projectRoot,
            subscriber: agentB.subscriber,
            agent_handle: agentB.agent_handle,
            timeout_seconds: 10,
          },
        },
      })}\n`);
      await waitFor(() => server.getStatus().active_wait_count === 1);

      const sent = await httpRpc(server.endpoint, token, {
        jsonrpc: "2.0",
        id: "send-a",
        method: "tools/call",
        params: {
          name: "dispatch_message",
          arguments: {
            project_root: projectRoot,
            subscriber: agentA.subscriber,
            agent_handle: agentA.agent_handle,
            target: agentB.subscriber,
            message: "cross-transport wake",
          },
        },
      }, sessionA);
      expect(sent.payload.result.structuredContent.ok).toBe(true);

      const wake = await waitFor(() => proxyMessages.find((message) => message.id === "wait-b"));
      expect(wake.result.structuredContent).toMatchObject({
        status: "message",
        count: 1,
      });

      await proxy.close();
      const registryAfterClose = JSON.parse(fs.readFileSync(
        getUfooPaths(projectRoot).agentsFile,
        "utf8"
      ));
      expect(registryAfterClose.agents[agentB.subscriber].status).toBe("active");
    } finally {
      await proxy.close();
      await server.stop();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 10000);
});

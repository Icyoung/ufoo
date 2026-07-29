"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  createGlobalMcpHttpServer,
  isAllowedHost,
  isAllowedOrigin,
  loadOrCreateMcpToken,
} = require("../../../src/runtime/daemon/mcpHttpServer");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

const tempRoots = [];

function makeTempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-http-"));
  tempRoots.push(root);
  fs.mkdirSync(getUfooPaths(root).runDir, { recursive: true });
  return root;
}

function mcpHeaders(token, sessionId = "") {
  const headers = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return headers;
}

async function rpc(endpoint, token, body, sessionId = "") {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: mcpHeaders(token, sessionId),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function initialize(endpoint, token, id = "init") {
  const result = await rpc(endpoint, token, {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ufoo-test", version: "1.0.0" },
    },
  });
  return {
    ...result,
    sessionId: result.response.headers.get("mcp-session-id"),
  };
}

describe("global MCP Streamable HTTP server", () => {
  afterAll(() => {
    for (const root of tempRoots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("creates and reuses a private bearer token", () => {
    const root = makeTempRoot();
    const tokenPath = getUfooPaths(root).mcpToken;
    const first = loadOrCreateMcpToken(tokenPath);
    const second = loadOrCreateMcpToken(tokenPath);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(30);
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  });

  test("accepts only loopback Host and Origin values", () => {
    expect(isAllowedHost("127.0.0.1:47631", 47631)).toBe(true);
    expect(isAllowedHost("localhost:47631", 47631)).toBe(true);
    expect(isAllowedHost("attacker.example:47631", 47631)).toBe(false);
    expect(isAllowedHost("127.0.0.1:9999", 47631)).toBe(false);
    expect(isAllowedOrigin("")).toBe(true);
    expect(isAllowedOrigin("http://localhost:3000")).toBe(true);
    expect(isAllowedOrigin("https://attacker.example")).toBe(false);
  });

  test("fails visibly instead of selecting another port on listener conflict", async () => {
    const firstRoot = makeTempRoot();
    const secondRoot = makeTempRoot();
    const first = createGlobalMcpHttpServer({
      projectRoot: firstRoot,
      port: 0,
      token: "first-token",
    });
    await first.start();
    const second = createGlobalMcpHttpServer({
      projectRoot: secondRoot,
      port: first.port,
      token: "second-token",
    });
    try {
      await expect(second.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(second.getStatus().running).toBe(false);
    } finally {
      await first.stop();
    }
  });

  test("serves health, authenticates MCP, and keeps independent client sessions", async () => {
    const root = makeTempRoot();
    const token = "test-token";
    const call = jest.fn(async (projectRoot, operation, args) => ({
      ok: true,
      project_root: projectRoot,
      operation,
      subscriber: args.subscriber,
    }));
    const server = createGlobalMcpHttpServer({
      projectRoot: root,
      port: 0,
      token,
      validateProjectRoot: false,
      projectRuntimeGateway: { call, cancel: () => false },
    });

    await server.start();
    try {
      const health = await fetch(server.endpoint.replace("/mcp", "/health"));
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, service: "ufoo-global-mcp" });

      const unauthorized = await fetch(server.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(unauthorized.status).toBe(401);

      const first = await initialize(server.endpoint, token, "init-a");
      const second = await initialize(server.endpoint, token, "init-b");
      expect(first.response.status).toBe(200);
      expect(first.payload.result.serverInfo.name).toBe("ufoo-global-mcp");
      expect(first.sessionId).toBeTruthy();
      expect(second.sessionId).toBeTruthy();
      expect(second.sessionId).not.toBe(first.sessionId);

      const listed = await rpc(server.endpoint, token, {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
        params: {},
      }, first.sessionId);
      expect(listed.payload.result.tools.some((tool) => tool.name === "wait_for_message")).toBe(true);

      const called = await rpc(server.endpoint, token, {
        jsonrpc: "2.0",
        id: "heartbeat",
        method: "tools/call",
        params: {
          name: "heartbeat_agent",
          arguments: {
            project_root: root,
            subscriber: "codex:http-test",
            agent_handle: "http-test-handle",
          },
        },
      }, second.sessionId);
      expect(called.payload.result.structuredContent).toMatchObject({
        ok: true,
        operation: "heartbeat_agent",
        subscriber: "codex:http-test",
      });
      expect(call).toHaveBeenCalledTimes(1);
      expect(server.getStatus()).toMatchObject({
        running: true,
        session_count: 2,
        active_request_count: 0,
      });
    } finally {
      await server.stop();
    }
    expect(server.getStatus().running).toBe(false);
  });

  test("propagates MCP cancellation into the project runtime gateway", async () => {
    const root = makeTempRoot();
    let waitStarted;
    const started = new Promise((resolve) => {
      waitStarted = resolve;
    });
    let aborted = false;
    const call = jest.fn((projectRoot, operation, args, context) => {
      if (operation !== "wait_for_message") return Promise.resolve({ ok: true });
      waitStarted();
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener("abort", () => {
          aborted = true;
          const err = new Error("cancelled in project runtime");
          err.code = "request_cancelled";
          reject(err);
        }, { once: true });
      });
    });
    const server = createGlobalMcpHttpServer({
      projectRoot: root,
      port: 0,
      token: "cancel-token",
      validateProjectRoot: false,
      projectRuntimeGateway: { call, cancel: () => false },
    });
    await server.start();
    try {
      const initialized = await initialize(server.endpoint, "cancel-token");
      const pendingController = new AbortController();
      const pending = fetch(server.endpoint, {
        method: "POST",
        headers: mcpHeaders("cancel-token", initialized.sessionId),
        signal: pendingController.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "wait-http",
          method: "tools/call",
          params: {
            name: "wait_for_message",
            arguments: {
              project_root: root,
              subscriber: "codex:cancel",
              agent_handle: "cancel-handle",
              timeout_seconds: 600,
            },
          },
        }),
      });
      await started;

      const cancelled = await fetch(server.endpoint, {
        method: "POST",
        headers: mcpHeaders("cancel-token", initialized.sessionId),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "wait-http", reason: "test cancellation" },
        }),
      });
      expect(cancelled.status).toBe(202);

      expect(aborted).toBe(true);
      pendingController.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(server.getStatus().active_wait_count).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

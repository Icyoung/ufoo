"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} = require("@modelcontextprotocol/sdk/types.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");

const { getUfooPaths } = require("../../coordination/state/paths");
const {
  buildToolList,
  createMcpContent,
  invokeTool,
} = require("./mcpServer");
const {
  createSocketProjectRuntimeGateway,
} = require("./projectRuntimeGateway");

const PACKAGE_JSON = require("../../../package.json");
const DEFAULT_MCP_HOST = "127.0.0.1";
const DEFAULT_MCP_PORT = 47631;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function ensurePrivateFile(filePath, createValue) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(path.dirname(filePath), 0o700);
  } catch {
    // Best effort for filesystems without POSIX modes.
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, createValue(), { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort for filesystems without POSIX modes.
  }
  return String(fs.readFileSync(filePath, "utf8") || "").trim();
}

function loadOrCreateMcpToken(tokenPath) {
  const token = ensurePrivateFile(tokenPath, () => `${crypto.randomBytes(32).toString("base64url")}\n`);
  if (!token) {
    const err = new Error(`MCP bearer token is empty: ${tokenPath}`);
    err.code = "UFOO_MCP_EMPTY_TOKEN";
    throw err;
  }
  return token;
}

function safeTokenEquals(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseBearerToken(header = "") {
  const match = String(header || "").match(/^Bearer[ \t]+(.+)$/i);
  return match ? match[1].trim() : "";
}

function isAllowedOrigin(origin = "") {
  const value = String(origin || "").trim();
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && LOCAL_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isAllowedHost(hostHeader = "", port) {
  const value = String(hostHeader || "").trim();
  if (!value) return false;
  try {
    const parsed = new URL(`http://${value}`);
    if (!LOCAL_HOSTNAMES.has(parsed.hostname)) return false;
    if (!parsed.port) return Number(port) === 80;
    return Number(parsed.port) === Number(port);
  } catch {
    return false;
  }
}

function jsonResponse(res, statusCode, payload, headers = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function rpcError(res, statusCode, message, code = -32000) {
  jsonResponse(res, statusCode, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function readJsonBody(req, maxBytes = MAX_REQUEST_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error("MCP request body is too large");
        err.code = "UFOO_MCP_BODY_TOO_LARGE";
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : undefined);
      } catch (err) {
        err.code = "UFOO_MCP_INVALID_JSON";
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

class GlobalMcpHttpServer {
  constructor(options = {}) {
    this.host = options.host || DEFAULT_MCP_HOST;
    this.port = Number.isInteger(options.port) ? options.port : DEFAULT_MCP_PORT;
    this.projectRoot = options.projectRoot;
    const paths = getUfooPaths(this.projectRoot);
    this.tokenPath = options.tokenPath || paths.mcpToken;
    this.endpointPath = options.endpointPath || paths.mcpEndpoint;
    this.token = options.token || "";
    this.log = typeof options.log === "function" ? options.log : () => {};
    this.projectRuntimeGateway = options.projectRuntimeGateway
      || createSocketProjectRuntimeGateway();
    this.validateProjectRoot = options.validateProjectRoot !== false;
    this.sessions = new Map();
    this.activeRequests = new Map();
    this.httpRequestCount = 0;
    this.server = null;
    this.startedAt = "";
    this.stopping = false;
  }

  get endpoint() {
    return `http://${this.host}:${this.port}/mcp`;
  }

  getStatus() {
    let activeWaits = 0;
    for (const request of this.activeRequests.values()) {
      if (request.tool === "wait_for_message") activeWaits += 1;
    }
    return {
      running: Boolean(this.server && this.server.listening),
      pid: process.pid,
      version: PACKAGE_JSON.version || "0.0.0",
      endpoint: this.endpoint,
      session_count: this.sessions.size,
      active_request_count: this.activeRequests.size,
      active_wait_count: activeWaits,
      http_request_count: this.httpRequestCount,
      started_at: this.startedAt || null,
      project_runtime_manager:
        this.projectRuntimeGateway
        && typeof this.projectRuntimeGateway.status === "function"
          ? this.projectRuntimeGateway.status()
          : null,
    };
  }

  createProtocolServer() {
    const protocolServer = new Server({
      name: "ufoo-global-mcp",
      version: PACKAGE_JSON.version || "0.0.0",
    }, {
      capabilities: {
        tools: { listChanged: false },
      },
      instructions: "Route every project-scoped tool through a project_root returned by read_project_registry.",
    });

    protocolServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: buildToolList(),
    }));

    protocolServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = String(request.params.name || "").trim();
      const args = request.params.arguments && typeof request.params.arguments === "object"
        ? request.params.arguments
        : {};
      const requestKey = `${extra.sessionId || "no-session"}:${String(extra.requestId)}`;
      this.activeRequests.set(requestKey, {
        tool: name,
        started_at: new Date().toISOString(),
      });
      try {
        const result = await invokeTool(name, args, {
          projectRuntimeGateway: this.projectRuntimeGateway,
          validateProjectRoot: this.validateProjectRoot,
          toolCallId: extra.requestId,
          signal: extra.signal,
          getMcpHttpStatus: () => this.getStatus(),
        });
        return createMcpContent(result);
      } finally {
        this.activeRequests.delete(requestKey);
      }
    });
    return protocolServer;
  }

  createSession() {
    let transport;
    const protocolServer = this.createProtocolServer();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { transport, protocolServer });
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) this.sessions.delete(sessionId);
    };
    return { transport, protocolServer };
  }

  authenticate(req, res) {
    if (!isAllowedHost(req.headers.host, this.port)) {
      rpcError(res, 403, "Forbidden host");
      return false;
    }
    if (!isAllowedOrigin(req.headers.origin)) {
      rpcError(res, 403, "Forbidden origin");
      return false;
    }
    const provided = parseBearerToken(req.headers.authorization);
    if (!provided || !safeTokenEquals(provided, this.token)) {
      rpcError(res, 401, "Unauthorized", -32001);
      return false;
    }
    return true;
  }

  async handleMcpRequest(req, res) {
    if (!this.authenticate(req, res)) return;
    const sessionId = String(req.headers["mcp-session-id"] || "").trim();
    let session = sessionId ? this.sessions.get(sessionId) : null;

    if (req.method === "POST") {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err && err.code === "UFOO_MCP_BODY_TOO_LARGE" ? 413 : 400;
        rpcError(res, status, err.message || "Invalid MCP request", -32700);
        return;
      }
      if (!session && !sessionId && isInitializeRequest(body)) {
        session = this.createSession();
        await session.protocolServer.connect(session.transport);
      } else if (!session) {
        rpcError(res, 400, "Bad Request: no valid MCP session");
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if ((req.method === "GET" || req.method === "DELETE") && session) {
      await session.transport.handleRequest(req, res);
      return;
    }

    rpcError(res, sessionId ? 400 : 405, sessionId
      ? "Bad Request: no valid MCP session"
      : "Method not allowed");
  }

  async handleHttpRequest(req, res) {
    this.httpRequestCount += 1;
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname === "/health") {
      jsonResponse(res, 200, {
        ok: true,
        service: "ufoo-global-mcp",
        version: PACKAGE_JSON.version || "0.0.0",
      });
      return;
    }
    if (requestUrl.pathname !== "/mcp") {
      jsonResponse(res, 404, { ok: false, error: "not_found" });
      return;
    }
    try {
      await this.handleMcpRequest(req, res);
    } catch (err) {
      this.log(`MCP HTTP request failed: ${err.message || err}`);
      rpcError(res, 500, "Internal MCP server error", -32603);
    }
  }

  writeEndpointFile() {
    fs.mkdirSync(path.dirname(this.endpointPath), { recursive: true, mode: 0o700 });
    const payload = {
      version: 1,
      endpoint: this.endpoint,
      token_path: this.tokenPath,
      pid: process.pid,
      started_at: this.startedAt,
    };
    fs.writeFileSync(this.endpointPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      fs.chmodSync(this.endpointPath, 0o600);
    } catch {
      // Best effort for filesystems without POSIX modes.
    }
  }

  async start() {
    if (this.server && this.server.listening) return this.getStatus();
    if (this.host !== "127.0.0.1" && this.host !== "::1") {
      const err = new Error(`MCP HTTP host must be loopback, got: ${this.host}`);
      err.code = "UFOO_MCP_NON_LOOPBACK_HOST";
      throw err;
    }
    this.token = this.token || loadOrCreateMcpToken(this.tokenPath);
    this.server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    this.server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
    const address = this.server.address();
    if (address && typeof address === "object") this.port = address.port;
    this.startedAt = new Date().toISOString();
    this.writeEndpointFile();
    this.log(`MCP Streamable HTTP listening at ${this.endpoint}`);
    return this.getStatus();
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async ({ transport, protocolServer }) => {
      await transport.close();
      await protocolServer.close();
    }));
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
    try {
      if (fs.existsSync(this.endpointPath)) fs.unlinkSync(this.endpointPath);
    } catch {
      // Best effort; a PID mismatch is still visible in status diagnostics.
    }
    this.stopping = false;
  }
}

function createGlobalMcpHttpServer(options = {}) {
  return new GlobalMcpHttpServer(options);
}

module.exports = {
  DEFAULT_MCP_HOST,
  DEFAULT_MCP_PORT,
  GlobalMcpHttpServer,
  createGlobalMcpHttpServer,
  isAllowedHost,
  isAllowedOrigin,
  loadOrCreateMcpToken,
  parseBearerToken,
};

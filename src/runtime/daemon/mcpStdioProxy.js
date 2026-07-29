"use strict";

const fs = require("fs");

const { getUfooPaths } = require("../../coordination/state/paths");
const {
  resolveGlobalControllerProjectRoot,
} = require("../projects");
const {
  MCP_ERROR_CODES,
  createJsonRpcError,
} = require("../contracts/mcpContract");

const DEFAULT_ENDPOINT_WAIT_MS = 5000;
const DEFAULT_ENDPOINT_POLL_MS = 50;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateEndpoint(raw = "") {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    throw new Error("Invalid global MCP endpoint");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.pathname !== "/mcp") {
    const err = new Error(`Refusing non-loopback global MCP endpoint: ${parsed.toString()}`);
    err.code = "UFOO_MCP_INVALID_ENDPOINT";
    throw err;
  }
  return parsed.toString();
}

function readConnectionFiles(projectRoot) {
  const paths = getUfooPaths(projectRoot);
  const endpointRecord = JSON.parse(fs.readFileSync(paths.mcpEndpoint, "utf8"));
  const endpoint = validateEndpoint(endpointRecord.endpoint);
  const token = String(fs.readFileSync(paths.mcpToken, "utf8") || "").trim();
  if (!token) {
    const err = new Error("Global MCP bearer token is empty");
    err.code = "UFOO_MCP_EMPTY_TOKEN";
    throw err;
  }
  return { endpoint, token };
}

class McpStdioProxy {
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.errorOutput = options.errorOutput || process.stderr;
    this.projectRoot = options.projectRoot || resolveGlobalControllerProjectRoot();
    this.autoStart = options.autoStart !== false;
    this.ensureDaemon = options.ensureDaemon || (async () => {});
    this.fetch = options.fetch || globalThis.fetch;
    this.endpoint = options.endpoint ? validateEndpoint(options.endpoint) : "";
    this.token = String(options.token || "");
    this.endpointWaitMs = Number(options.endpointWaitMs) || DEFAULT_ENDPOINT_WAIT_MS;
    this.endpointPollMs = Number(options.endpointPollMs) || DEFAULT_ENDPOINT_POLL_MS;
    this.sessionId = "";
    this.startup = null;
    this.initializing = null;
    this.activeRequests = new Map();
    this.closed = false;
    this.buffer = "";
  }

  writeMessage(message) {
    if (!message || this.closed) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  writeError(message) {
    this.errorOutput.write(`[ufoo-mcp-proxy] ${String(message || "")}\n`);
  }

  async connect() {
    if (this.endpoint && this.token) return { endpoint: this.endpoint };
    if (this.startup) return this.startup;
    this.startup = (async () => {
      if (this.autoStart) await this.ensureDaemon();
      const deadline = Date.now() + this.endpointWaitMs;
      let lastError = null;
      do {
        try {
          const connection = readConnectionFiles(this.projectRoot);
          this.endpoint = connection.endpoint;
          this.token = connection.token;
          return { endpoint: this.endpoint };
        } catch (err) {
          lastError = err;
        }
        if (!this.autoStart) break;
        await sleep(this.endpointPollMs);
      } while (Date.now() < deadline);
      const err = new Error(
        `Global MCP endpoint is unavailable: ${lastError ? lastError.message : "not started"}`
      );
      err.code = "UFOO_MCP_UNAVAILABLE";
      throw err;
    })();
    try {
      return await this.startup;
    } catch (err) {
      this.startup = null;
      throw err;
    }
  }

  async post(request, controller) {
    await this.connect();
    const headers = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) this.sessionId = nextSessionId;
    if (response.status === 202 || response.status === 204) return null;
    const text = await response.text();
    if (!text) {
      if (response.ok) return null;
      throw new Error(`Global MCP returned HTTP ${response.status}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Global MCP returned invalid JSON (HTTP ${response.status})`);
    }
    return payload;
  }

  async forward(request) {
    const hasId = Object.prototype.hasOwnProperty.call(request || {}, "id");
    const id = hasId ? request.id : undefined;
    const method = String((request && request.method) || "");
    if (method !== "initialize" && this.initializing) {
      await this.initializing;
    }

    const controller = new AbortController();
    if (hasId) this.activeRequests.set(id, controller);
    const operation = this.post(request, controller);
    if (method === "initialize") this.initializing = operation;
    try {
      const response = await operation;
      if (response) this.writeMessage(response);
      return response;
    } catch (err) {
      if (hasId) {
        const response = createJsonRpcError(
          id,
          MCP_ERROR_CODES.INTERNAL_ERROR,
          err && err.message ? err.message : String(err),
          { code: err && err.code ? String(err.code) : "mcp_proxy_error" }
        );
        this.writeMessage(response);
        return response;
      }
      this.writeError(err && err.message ? err.message : err);
      return null;
    } finally {
      if (hasId) this.activeRequests.delete(id);
      if (method === "initialize") this.initializing = null;
    }
  }

  handleLine(line) {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (err) {
      this.writeMessage(createJsonRpcError(
        null,
        MCP_ERROR_CODES.PARSE_ERROR,
        err.message || "Parse error"
      ));
      return;
    }
    void this.forward(request);
  }

  start() {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/);
      this.buffer = lines.pop() || "";
      for (const line of lines) this.handleLine(line);
    });
    this.input.on("end", () => {
      void this.close();
    });
    this.input.on("close", () => {
      void this.close();
    });
    return this;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.activeRequests.values()) controller.abort();
    this.activeRequests.clear();
    if (!this.endpoint || !this.token || !this.sessionId) return;
    try {
      await this.fetch(this.endpoint, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.token}`,
          "mcp-session-id": this.sessionId,
        },
      });
    } catch {
      // The adapter is disposable; the server will also close abandoned sessions.
    }
  }
}

function createMcpStdioProxy(options = {}) {
  return new McpStdioProxy(options);
}

async function runMcpStdioProxy(options = {}) {
  return createMcpStdioProxy(options).start();
}

module.exports = {
  McpStdioProxy,
  createMcpStdioProxy,
  readConnectionFiles,
  runMcpStdioProxy,
  validateEndpoint,
};

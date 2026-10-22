"use strict";

const fs = require("fs");
const { Agent } = require("undici");

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
const DEFAULT_REQUEST_TIMEOUT_MS = 610000;
// A disconnected write may already have committed. Only queue reads and other
// read-only operations can be replayed after an ambiguous transport failure.
const REPLAYABLE_TOOLS = new Set([
  "read_project_registry", "read_bus_summary", "read_prompt_history", "read_open_decisions",
  "list_agents", "ufoo_mcp_status", "poll_inbox", "wait_for_message",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CONTENT_LENGTH_HEADER = "content-length:";
const MAX_STDIO_HEADER_BYTES = 64 * 1024;
const MAX_STDIO_BODY_BYTES = 2 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skipAsciiSpace(buffer) {
  let index = 0;
  while (index < buffer.length && (buffer[index] === 0x20 || buffer[index] === 0x09)) index += 1;
  return index;
}

function classifyStdioChunk(buffer) {
  const offset = skipAsciiSpace(buffer);
  const sample = buffer.slice(offset, offset + CONTENT_LENGTH_HEADER.length).toString("latin1").toLowerCase();
  if (!sample) return "empty";
  if (sample.startsWith("{")) return "json";
  if (sample.startsWith(CONTENT_LENGTH_HEADER)) return "header";
  if (CONTENT_LENGTH_HEADER.startsWith(sample) && !sample.includes("\n")) return "prefix";
  return "line";
}

function takeContentLengthFrame(buffer) {
  let index = 0;
  while (
    index < buffer.length
    && (buffer[index] === 0x20 || buffer[index] === 0x09 || buffer[index] === 0x0d || buffer[index] === 0x0a)
  ) index += 1;
  if (index === buffer.length) return { status: "empty" };
  const slice = buffer.slice(index);
  const crlf = slice.indexOf("\r\n\r\n");
  const lf = slice.indexOf("\n\n");
  let headerEnd = -1;
  let separatorLength = 0;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    headerEnd = crlf;
    separatorLength = 4;
  } else if (lf >= 0) {
    headerEnd = lf;
    separatorLength = 2;
  }
  if (headerEnd < 0) {
    if (slice.length > MAX_STDIO_HEADER_BYTES) {
      return { status: "invalid", rest: Buffer.alloc(0), message: "MCP header is too large" };
    }
    return { status: "need-more" };
  }
  const header = slice.slice(0, headerEnd).toString("utf8");
  const match = header.match(/content-length:\s*(\d+)/i);
  if (!match) {
    return {
      status: "invalid",
      rest: slice.slice(headerEnd + separatorLength),
      message: "MCP frame is missing Content-Length",
    };
  }
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STDIO_BODY_BYTES) {
    return {
      status: "invalid",
      rest: slice.slice(headerEnd + separatorLength),
      message: "MCP Content-Length is invalid",
    };
  }
  const bodyStart = headerEnd + separatorLength;
  if (slice.length < bodyStart + length) return { status: "need-more" };
  return {
    status: "ok",
    body: slice.slice(bodyStart, bodyStart + length).toString("utf8"),
    rest: slice.slice(bodyStart + length),
  };
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
    // Undici's default headers/body deadlines also apply to fetch. Resident
    // MCP receives must not be ended by that hidden transport timer.
    this.dispatcher = options.dispatcher || (!options.fetch
      ? new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: DEFAULT_ENDPOINT_WAIT_MS } })
      : null);
    this.ownsDispatcher = Boolean(this.dispatcher && !options.dispatcher);
    this.endpoint = options.endpoint ? validateEndpoint(options.endpoint) : "";
    this.managedConnection = !options.endpoint;
    this.token = String(options.token || "");
    this.endpointWaitMs = Number(options.endpointWaitMs) || DEFAULT_ENDPOINT_WAIT_MS;
    this.endpointPollMs = Number(options.endpointPollMs) || DEFAULT_ENDPOINT_POLL_MS;
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS;
    this.sessionId = "";
    this.protocolVersion = "";
    this.initializeParams = null;
    this.generation = 0;
    this.recovering = null;
    this.startup = null;
    this.initializing = null;
    this.activeRequests = new Map();
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.inputFraming = "";
    this.outputFraming = "ndjson";
  }

  writeMessage(message) {
    if (!message || this.closed) return;
    const json = JSON.stringify(message);
    if (this.outputFraming === "content-length") {
      const body = Buffer.from(json, "utf8");
      this.output.write(`Content-Length: ${body.length}\r\n\r\n`);
      this.output.write(body);
      return;
    }
    this.output.write(`${json}\n`);
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
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion;
    const residentWait = request.method === "tools/call"
      && request.params?.name === "wait_for_message"
      && Number(request.params?.arguments?.timeout_seconds || 0) === 0;
    const timeout = residentWait ? null : AbortSignal.timeout(this.requestTimeoutMs);
    const signal = timeout ? AbortSignal.any([controller.signal, timeout]) : controller.signal;
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal,
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    const nextSessionId = response.headers.get("mcp-session-id");
    if (nextSessionId) this.sessionId = nextSessionId;
    if (response.status === 202 || response.status === 204) return null;
    const text = await response.text();
    if (!text) {
      if (response.ok) return null;
      const err = new Error(`Global MCP returned HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Global MCP returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const err = new Error(payload.error?.message || `Global MCP returned HTTP ${response.status}`);
      err.status = response.status;
      err.code = "UFOO_MCP_HTTP_ERROR";
      throw err;
    }
    if (request.method === "initialize" && payload.result) {
      this.initializeParams = request.params;
      this.protocolVersion = payload.result.protocolVersion;
    }
    return payload;
  }

  async recover(generation) {
    if (this.recovering) return this.recovering;
    if (generation !== this.generation) return;
    if (!this.initializeParams || this.closed) throw new Error("MCP session is not initialized");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.endpointWaitMs);
    this.recoveryController = controller;
    this.recovering = (async () => {
      this.sessionId = "";
      if (this.managedConnection) {
        this.endpoint = "";
        this.token = "";
        this.startup = null;
      }
      const request = { jsonrpc: "2.0", id: "ufoo-proxy-reinitialize", method: "initialize", params: this.initializeParams };
      let response;
      // An idle HTTP keep-alive socket can fail once after a listener restart.
      const deadline = Date.now() + this.endpointWaitMs;
      while (!controller.signal.aborted) {
        try {
          response = await this.post(request, controller);
          break;
        } catch (err) {
          if (controller.signal.aborted || Date.now() >= deadline
            || (err.status && ![401, 502, 503].includes(err.status))) throw err;
          if (this.managedConnection) {
            this.endpoint = "";
            this.token = "";
            this.startup = null;
          }
          await sleep(this.endpointPollMs);
        }
      }
      if (!response?.result) throw new Error(response?.error?.message || "MCP reinitialization failed");
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, controller);
      this.generation += 1;
    })();
    try {
      await this.recovering;
    } finally {
      clearTimeout(timer);
      this.recoveryController = null;
      this.recovering = null;
    }
  }

  async postWithRecovery(request, controller) {
    if (this.recovering) await this.recovering;
    const generation = this.generation;
    try {
      return await this.post(request, controller);
    } catch (err) {
      if (controller.signal.aborted || this.closed || request.method === "initialize") throw err;
      const rejectedSession = err.status === 404
        || (err.status === 400 && /no valid MCP session/i.test(err.message))
        || (err.status === 401 && this.managedConnection);
      const disconnected = !err.status && err instanceof TypeError;
      if (!rejectedSession && !disconnected) throw err;
      const replayable = rejectedSession || ["ping", "tools/list"].includes(request.method)
        || (request.method === "tools/call" && REPLAYABLE_TOOLS.has(request.params?.name));
      if (!replayable) {
        err.code = "UFOO_MCP_OUTCOME_UNKNOWN";
        err.message = `Connection lost; ${request.params?.name || request.method} may have completed. Check its result before retrying.`;
        try { await this.recover(generation); } catch { /* Preserve the uncertain write outcome even if recovery failed. */ }
        throw err;
      }
      await this.recover(generation);
      controller.signal.throwIfAborted();
      return this.post(request, controller);
    }
  }

  async forward(request) {
    if (this.closed) return null;
    const hasId = Object.prototype.hasOwnProperty.call(request || {}, "id");
    const id = hasId ? request.id : undefined;
    const method = String((request && request.method) || "");
    const controller = new AbortController();
    if (hasId) this.activeRequests.set(id, controller);
    if (method === "notifications/cancelled") {
      this.activeRequests.get(request.params?.requestId)?.abort();
    }
    try {
      if (method !== "initialize" && this.initializing) await this.initializing;
      const operation = this.postWithRecovery(request, controller);
      if (method === "initialize") this.initializing = operation;
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

  handleJsonText(text) {
    let request;
    try {
      request = JSON.parse(text);
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

  handleLine(line) {
    if (!line.trim()) return;
    this.handleJsonText(line);
  }

  drainInput() {
    while (this.buffer.length > 0) {
      if (this.inputFraming === "content-length") {
        const frame = takeContentLengthFrame(this.buffer);
        if (frame.status === "need-more") return;
        if (frame.status === "empty") {
          this.buffer = Buffer.alloc(0);
          return;
        }
        this.buffer = frame.rest;
        this.outputFraming = "content-length";
        if (frame.status === "invalid") {
          this.writeMessage(createJsonRpcError(
            null,
            MCP_ERROR_CODES.PARSE_ERROR,
            frame.message || "Parse error"
          ));
          continue;
        }
        this.handleJsonText(frame.body);
        continue;
      }

      const kind = classifyStdioChunk(this.buffer);
      if (kind === "empty" || kind === "prefix") return;
      if (kind === "header") {
        this.inputFraming = "content-length";
        this.outputFraming = "content-length";
        continue;
      }

      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.handleLine(line);
    }
  }

  start() {
    this.input.on("data", (chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, next]) : next;
      this.drainInput();
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
    this.recoveryController?.abort();
    for (const controller of this.activeRequests.values()) controller.abort();
    this.activeRequests.clear();
    try {
      if (this.endpoint && this.token && this.sessionId) await this.fetch(this.endpoint, {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.token}`,
          "mcp-session-id": this.sessionId,
          "mcp-protocol-version": this.protocolVersion,
        },
        signal: AbortSignal.timeout(this.endpointWaitMs),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch {
      // The adapter is disposable; the server will also close abandoned sessions.
    } finally {
      if (this.ownsDispatcher) await this.dispatcher.destroy();
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

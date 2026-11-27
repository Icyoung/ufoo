"use strict";

const { EventEmitter } = require("events");
const { StringDecoder } = require("string_decoder");

/**
 * Bidirectional line-delimited JSON-RPC 2.0 transport over stdio streams,
 * conforming to the Agent Client Protocol (ACP) framing contract.
 */
class JsonRpcStdioConnection extends EventEmitter {
  constructor({ input, output } = {}) {
    super();
    if (!input || !output) {
      throw new Error("JsonRpcStdioConnection requires input and output streams");
    }
    this.input = input;
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
    this.buffer = "";
    this._decoder = new StringDecoder("utf8");
    this.closed = false;

    this._onData = (chunk) => this._handleData(chunk);
    this._onClose = () => this._handleClose();
    this._onError = (err) => this.emit("error", err);

    this.input.on("data", this._onData);
    this.input.on("end", this._onClose);
    this.input.on("close", this._onClose);
    this.input.on("error", this._onError);
    this.output.on("error", this._onError);
  }

  onRequest(method, handler) {
    this.requestHandlers.set(String(method), handler);
    return this;
  }

  onNotification(method, handler) {
    this.notificationHandlers.set(String(method), handler);
    return this;
  }

  _writeFrame(message) {
    if (this.closed) return;
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.output.write(line);
    } catch (err) {
      this.emit("error", err);
    }
  }

  sendRequest(method, params = {}, { timeoutMs = 0, signal } = {}) {
    if (this.closed) {
      return Promise.reject(new Error(`ACP connection is closed (${method})`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanup();
        const err = new Error(`ACP request cancelled (${method})`);
        err.code = "cancelled";
        reject(err);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          cleanup();
          const err = new Error(`ACP request timed out after ${timeoutMs}ms (${method})`);
          err.code = "timeout";
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      });
      this._writeFrame({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });
    });
  }

  sendNotification(method, params = {}) {
    if (this.closed) return;
    this._writeFrame({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  _handleData(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? this._decoder.write(chunk) : String(chunk || "");
    this._drainBuffer();
  }

  _drainBuffer(flushAll = false) {
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        this._dispatchLine(line);
      }
      idx = this.buffer.indexOf("\n");
    }
    if (flushAll) {
      const rest = this.buffer.trim();
      this.buffer = "";
      if (rest) {
        this._dispatchLine(rest);
      }
    }
  }

  _dispatchLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      // Non-JSON diagnostic line on stdout; ignore safely without tearing down stream.
      this.emit("malformed", line);
      return;
    }
    if (!msg || typeof msg !== "object") return;

    // Response to an outbound request
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message || "ACP JSON-RPC error");
        err.code = msg.error.code;
        err.data = msg.error.data;
        waiter.reject(err);
      } else {
        waiter.resolve(msg.result);
      }
      return;
    }

    // Inbound request (expects a response)
    if (msg.id !== undefined && typeof msg.method === "string") {
      const handler = this.requestHandlers.get(msg.method) || this.requestHandlers.get("*");
      if (!handler) {
        this._writeFrame({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
        return;
      }
      Promise.resolve()
        .then(() => handler(msg.params || {}, msg.method))
        .then((result) => {
          this._writeFrame({
            jsonrpc: "2.0",
            id: msg.id,
            result: result === undefined ? {} : result,
          });
        })
        .catch((err) => {
          this._writeFrame({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: typeof err?.code === "number" ? err.code : -32000,
              message: err && err.message ? err.message : String(err),
            },
          });
        });
      return;
    }

    // Inbound notification
    if (typeof msg.method === "string") {
      const handler = this.notificationHandlers.get(msg.method) || this.notificationHandlers.get("*");
      if (handler) {
        try {
          handler(msg.params || {}, msg.method);
        } catch (err) {
          this.emit("error", err);
        }
      }
      this.emit("notification", msg);
    }
  }

  _handleClose() {
    if (this.closed) return;
    const trailing = this._decoder.end();
    if (trailing) this.buffer += trailing;
    this._drainBuffer(true);
    this.closed = true;
    const err = new Error("ACP connection closed");
    err.code = "closed";
    for (const waiter of this.pending.values()) {
      waiter.reject(err);
    }
    this.pending.clear();
    this.emit("close");
  }

  close() {
    if (this.closed) return;
    this.input.removeListener("data", this._onData);
    this.input.removeListener("end", this._onClose);
    this.input.removeListener("close", this._onClose);
    this.input.removeListener("error", this._onError);
    this.output.removeListener("error", this._onError);
    this._handleClose();
  }
}

module.exports = {
  JsonRpcStdioConnection,
};

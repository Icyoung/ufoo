const EventEmitter = require("events");
const WebSocket = require("ws");
const { loadTokens, defaultTokensPath } = require("./tokens");

function waitForOpen(ws, timeoutMs = 5000) {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket open timeout")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

class OnlineClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.url = options.url || "wss://online.ufoo.dev/ufoo/online";
    this.subscriberId = options.subscriberId || "";
    this.nickname = options.nickname || "";
    this.world = options.world || "default";
    this.agentType = options.agentType || "";
    this.version = options.version || "0.1.0";
    this.capabilities = Array.isArray(options.capabilities) ? options.capabilities : [];
    this.project = options.project || null;

    this.token = options.token || "";
    this.tokenHash = options.tokenHash || "";
    this.tokenFile = options.tokenFile || defaultTokensPath();
    this.allowInsecureWs = options.allowInsecureWs || false;

    this.ws = null;
    this.connected = false;
  }

  resolveToken() {
    if (this.token || this.tokenHash) return;
    if (!this.subscriberId) return;
    const data = loadTokens(this.tokenFile);
    const entry = data.agents?.[this.subscriberId];
    if (!entry) return;
    this.token = entry.token || this.token;
    this.tokenHash = entry.token_hash || this.tokenHash;
    if (!this.nickname && entry.nickname) this.nickname = entry.nickname;
    if (!this.url && entry.server) this.url = entry.server;
  }

  buildHello() {
    return {
      type: "hello",
      client: {
        subscriber_id: this.subscriberId,
        agent_type: this.agentType,
        nickname: this.nickname,
        world: this.world,
        version: this.version,
        capabilities: this.capabilities,
        project: this.project || undefined,
      },
    };
  }

  buildAuth() {
    const payload = { type: "auth", method: "token" };
    if (this.tokenHash) payload.token_hash = this.tokenHash;
    else payload.token = this.token;
    return payload;
  }

  async connect({ timeoutMs = 6000 } = {}) {
    if (this.connected) return;
    this.resolveToken();
    if (!this.subscriberId || !this.nickname) {
      throw new Error("subscriberId and nickname are required");
    }
    if (!this.token && !this.tokenHash) {
      throw new Error("token (or token_hash) is required");
    }

    // Step 10: Enforce TLS for non-local ws:// unless explicitly allowed
    if (this.url.startsWith("ws://")) {
      let parsed;
      try {
        parsed = new URL(this.url);
      } catch {
        throw new Error(`Invalid WebSocket URL: ${this.url}`);
      }
      const host = parsed.hostname;
      const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
      if (!isLocal) {
        if (!this.allowInsecureWs) {
          throw new Error(
            `Refusing to connect to non-localhost over unencrypted ws:// ("${host}"). Use wss:// or pass --allow-insecure-ws.`
          );
        }
        this.emit(
          "warning",
          `Connecting over unencrypted ws:// to non-localhost host "${host}". Consider using wss:// with TLS.`
        );
      }
    }

    this.ws = new WebSocket(this.url);
    await waitForOpen(this.ws, timeoutMs);

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.emit("message", msg);
        if (msg.type === "wake") {
          this.emit("wake", msg);
        }
      } catch {
        // ignore
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.emit("close");
    });

    this.ws.on("error", (err) => {
      this.emit("error", err);
    });

    const next = this.createMessageQueue();

    this.send(this.buildHello());
    const helloAck = await next(timeoutMs);
    if (helloAck.type === "error") throw new Error(helloAck.error || "hello failed");

    let authRequired = null;
    try {
      authRequired = await next(timeoutMs);
    } catch {
      authRequired = null;
    }
    if (!authRequired || authRequired.type !== "auth_required") {
      authRequired = { type: "auth_required" };
    }

    this.send(this.buildAuth());
    const authOk = await next(timeoutMs);
    if (authOk.type !== "auth_ok") {
      throw new Error(authOk.error || "auth failed");
    }

    if (typeof next.cleanup === "function") {
      next.cleanup();
    }

    this.connected = true;
  }

  createMessageQueue() {
    const messages = [];
    let resolver = null;

    const handler = (msg) => {
      if (resolver) {
        const next = resolver;
        resolver = null;
        next(msg);
      } else {
        messages.push(msg);
      }
    };

    const onMessage = (data) => {
      try {
        handler(JSON.parse(data.toString()));
      } catch {
        // ignore
      }
    };

    this.ws.on("message", onMessage);

    const next = (timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        if (messages.length > 0) return resolve(messages.shift());
        resolver = resolve;
        setTimeout(() => {
          if (resolver === resolve) {
            resolver = null;
            reject(new Error("Timeout waiting for message"));
          }
        }, timeoutMs);
      });

    next.cleanup = () => {
      this.ws.off("message", onMessage);
    };

    return next;
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  join(channel) {
    this.send({ type: "join", channel });
  }

  leave(channel) {
    this.send({ type: "leave", channel });
  }

  joinRoom(room, password = "") {
    this.send({ type: "join", room, password });
  }

  leaveRoom(room) {
    this.send({ type: "leave", room });
  }

  sendEvent({ channel, room, payload }) {
    return this.send({ type: "event", channel, room, payload });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
    }
  }
}

module.exports = OnlineClient;

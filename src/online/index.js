const http = require("http");
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const WebSocket = require("ws");

/**
 * ufoo-online (Phase 1)
 *
 * Minimal WebSocket relay implementing hello/auth + join/leave + event routing.
 * Intended WebSocket path: /ufoo/online (see docs/ufoo-online/PROTOCOL.md)
 */
class OnlineServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port ?? 8787;
    this.host = options.host ?? "127.0.0.1";
    this.server = null;
    this.wsServer = null;

    this.clientsById = new Map();
    this.clientsByNickname = new Map();
    this.channels = new Map();

    this.allowedTokens = this.loadTokens(options);
    this.allowAnyToken = this.allowedTokens === null;
    this.version = options.version || "0.1.0";
  }

  loadTokens(options) {
    if (options.tokens) {
      return new Set(Array.isArray(options.tokens) ? options.tokens : Object.keys(options.tokens));
    }

    if (options.tokenFile) {
      const filePath = path.resolve(options.tokenFile);
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
      if (Array.isArray(parsed.tokens)) return new Set(parsed.tokens);
      if (parsed.tokens && typeof parsed.tokens === "object") return new Set(Object.keys(parsed.tokens));
      if (typeof parsed === "object") return new Set(Object.keys(parsed));
      return new Set();
    }

    return null; // allow any token if none configured
  }

  start() {
    if (this.server) return Promise.resolve();

    this.server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ufoo-online: running\n");
    });

    this.wsServer = new WebSocket.Server({ noServer: true });
    this.wsServer.on("connection", (ws) => this.handleConnection(ws));

    this.server.on("upgrade", (req, socket, head) => {
      if (req.url && req.url.startsWith("/ufoo/online")) {
        this.wsServer.handleUpgrade(req, socket, head, (ws) => {
          this.wsServer.emit("connection", ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        const address = this.server.address();
        const actualPort = address && typeof address === "object" ? address.port : this.port;
        this.port = actualPort;
        this.emit("listening", { host: this.host, port: this.port });
        resolve();
      });
    });
  }

  stop() {
    const server = this.server;
    const wsServer = this.wsServer;
    this.server = null;
    this.wsServer = null;

    if (wsServer) {
      wsServer.clients.forEach((client) => client.terminate());
      wsServer.close();
    }

    if (!server) return Promise.resolve();

    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  handleConnection(ws) {
    const client = {
      ws,
      authed: false,
      subscriberId: null,
      nickname: null,
      channels: new Set(),
      helloReceived: false,
    };

    ws.on("message", (data) => {
      this.handleMessage(client, data);
    });

    ws.on("close", () => {
      this.cleanupClient(client);
    });
  }

  send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  sendError(ws, error, close = false, code = null) {
    if (ws.readyState !== WebSocket.OPEN) {
      if (close) ws.close();
      return;
    }
    const payload = code ? { type: "error", code, error } : { type: "error", error };
    if (close) {
      ws.send(JSON.stringify(payload), () => {
        ws.close();
      });
      return;
    }
    this.send(ws, payload);
  }

  requireAuth(client) {
    if (!client.authed) {
      this.sendError(client.ws, "Unauthorized", false, "UNAUTHORIZED");
      return false;
    }
    return true;
  }

  handleMessage(client, data) {
    let message = null;
    try {
      message = JSON.parse(data.toString());
    } catch {
      this.sendError(client.ws, "Invalid JSON");
      return;
    }

    if (!message || typeof message.type !== "string") {
      this.sendError(client.ws, "Invalid message", false, "INVALID_MESSAGE");
      return;
    }

    switch (message.type) {
      case "hello":
        this.handleHello(client, message);
        return;
      case "auth":
        this.handleAuth(client, message);
        return;
      case "join":
        this.handleJoin(client, message);
        return;
      case "leave":
        this.handleLeave(client, message);
        return;
      case "ping":
        this.send(client.ws, { type: "pong" });
        return;
      case "pong":
        return;
      case "event":
        this.handleEvent(client, message);
        return;
      default:
        this.sendError(client.ws, "Unknown message type", false, "UNKNOWN_TYPE");
    }
  }

  handleHello(client, message) {
    if (client.helloReceived) {
      this.sendError(client.ws, "Hello already received", false, "HELLO_DUPLICATE");
      return;
    }

    const info = message.client || {};
    const subscriberId = info.subscriber_id;
    const nickname = info.nickname;
    const channelType = info.channel_type;

    if (!subscriberId || !nickname) {
      this.sendError(client.ws, "Missing subscriber_id or nickname", false, "HELLO_INVALID");
      return;
    }

    if (!channelType || !["world", "public", "private"].includes(channelType)) {
      this.sendError(client.ws, "Invalid channel_type", false, "CHANNEL_TYPE_INVALID");
      return;
    }

    if (this.clientsById.has(subscriberId)) {
      this.sendError(client.ws, `Subscriber "${subscriberId}" already connected`, true, "SUBSCRIBER_EXISTS");
      return;
    }

    if (this.clientsByNickname.has(nickname)) {
      this.sendError(client.ws, `Nickname "${nickname}" already exists`, true, "NICKNAME_TAKEN");
      return;
    }

    client.helloReceived = true;
    client.subscriberId = subscriberId;
    client.nickname = nickname;
    client.channelType = channelType;

    this.clientsById.set(subscriberId, client);
    this.clientsByNickname.set(nickname, client);

    this.send(client.ws, {
      type: "hello_ack",
      ok: true,
      server: {
        version: this.version,
        time: new Date().toISOString(),
      },
    });

    this.send(client.ws, {
      type: "auth_required",
      methods: ["token"],
    });
  }

  handleAuth(client, message) {
    if (!client.helloReceived) {
      this.sendError(client.ws, "Hello required", false, "HELLO_REQUIRED");
      return;
    }

    if (client.authed) {
      this.sendError(client.ws, "Already authenticated", false, "AUTH_DUPLICATE");
      return;
    }

    if (message.method !== "token") {
      this.sendError(client.ws, "Unsupported auth method", false, "AUTH_METHOD_UNSUPPORTED");
      return;
    }

    if (!message.token) {
      this.sendError(client.ws, "Missing token", false, "AUTH_TOKEN_MISSING");
      return;
    }

    if (!this.allowAnyToken && !this.allowedTokens.has(message.token)) {
      this.sendError(client.ws, "Invalid token", true, "AUTH_TOKEN_INVALID");
      return;
    }

    client.authed = true;
    this.send(client.ws, { type: "auth_ok", ok: true });
  }

  handleJoin(client, message) {
    if (!this.requireAuth(client)) return;
    const channel = message.channel;
    if (!channel) {
      this.sendError(client.ws, "Missing channel", false, "CHANNEL_MISSING");
      return;
    }

    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Set());
    }

    const members = this.channels.get(channel);
    members.add(client);
    client.channels.add(channel);
    this.send(client.ws, { type: "join_ack", ok: true, channel });
  }

  handleLeave(client, message) {
    if (!this.requireAuth(client)) return;
    const channel = message.channel;
    if (!channel) {
      this.sendError(client.ws, "Missing channel", false, "CHANNEL_MISSING");
      return;
    }

    const members = this.channels.get(channel);
    if (members) {
      members.delete(client);
      if (members.size === 0) this.channels.delete(channel);
    }
    client.channels.delete(channel);
    this.send(client.ws, { type: "leave_ack", ok: true, channel });
  }

  handleEvent(client, message) {
    if (!this.requireAuth(client)) return;
    if (!client.subscriberId) {
      this.sendError(client.ws, "Unknown subscriber", false, "SUBSCRIBER_UNKNOWN");
      return;
    }

    if (!message.payload || typeof message.payload.kind !== "string") {
      this.sendError(client.ws, "Missing payload.kind", false, "EVENT_INVALID");
      return;
    }

    if (message.from && message.from !== client.subscriberId) {
      this.sendError(client.ws, "Invalid sender", false, "EVENT_SENDER_INVALID");
      return;
    }

    const payload = {
      ...message,
      from: client.subscriberId,
      ts: message.ts || new Date().toISOString(),
    };

    const kind = payload.payload.kind;
    const allowedByType = {
      world: new Set(["message"]),
      public: new Set(["message"]),
      private: new Set(["message", "decisions.sync", "bus.sync", "wake"]),
    };

    const typeAllowed = allowedByType[client.channelType] || new Set();
    if (!typeAllowed.has(kind)) {
      this.sendError(client.ws, "Event kind not allowed for channel type", false, "EVENT_KIND_FORBIDDEN");
      return;
    }

    if (payload.to) {
      const target = this.clientsById.get(payload.to);
      if (!target) {
        this.sendError(client.ws, `Target "${payload.to}" not found`, false, "TARGET_NOT_FOUND");
        return;
      }
      this.send(target.ws, payload);
      return;
    }

    if (payload.channel) {
      if (!client.channels.has(payload.channel)) {
        this.sendError(client.ws, "Join channel first", false, "NOT_IN_CHANNEL");
        return;
      }
      const members = this.channels.get(payload.channel);
      if (!members || members.size === 0) return;
      members.forEach((member) => {
        if (member !== client) this.send(member.ws, payload);
      });
      return;
    }

    this.sendError(client.ws, "Missing routing target", false, "ROUTE_MISSING");
  }

  cleanupClient(client) {
    if (client.subscriberId) {
      this.clientsById.delete(client.subscriberId);
    }
    if (client.nickname) {
      this.clientsByNickname.delete(client.nickname);
    }

    client.channels.forEach((channel) => {
      const members = this.channels.get(channel);
      if (members) {
        members.delete(client);
        if (members.size === 0) this.channels.delete(channel);
      }
    });
    client.channels.clear();
  }
}

module.exports = OnlineServer;

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
    this.channelNames = new Map();

    this.nicknameScope = options.nicknameScope || "global"; // global | world

    this.allowedTokens = this.loadTokens(options);
    this.allowAnyToken = this.allowedTokens === null;
    this.version = options.version || "0.1.0";
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 10000;
    this.sweepTimer = null;

    this.rooms = new Map();
    this.roomPasswords = new Map();
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
      if (parsed.agents && typeof parsed.agents === "object") {
        return new Set(
          Object.values(parsed.agents)
            .map((entry) => entry && (entry.token_hash || entry.token))
            .filter(Boolean)
        );
      }
      if (typeof parsed === "object") return new Set(Object.keys(parsed));
      return new Set();
    }

    return null; // allow any token if none configured
  }

  start() {
    if (this.server) return Promise.resolve();

    this.server = http.createServer((req, res) => {
      if (!req.url) {
        res.writeHead(404);
        res.end();
        return;
      }

      if (req.url.startsWith("/ufoo/online/rooms")) {
        this.handleRoomsRequest(req, res);
        return;
      }

      if (req.url.startsWith("/ufoo/online/channels")) {
        this.handleChannelsRequest(req, res);
        return;
      }

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
        this.startIdleSweep();
        resolve();
      });
    });
  }

  stop() {
    const server = this.server;
    const wsServer = this.wsServer;
    this.server = null;
    this.wsServer = null;

    this.stopIdleSweep();

    if (wsServer) {
      wsServer.clients.forEach((client) => client.terminate());
      wsServer.close();
    }

    if (!server) return Promise.resolve();

    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  readBody(req) {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
    });
  }

  sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  }

  hashPassword(password) {
    return crypto.createHash("sha256").update(String(password || "")).digest("hex");
  }

  listRooms() {
    return Array.from(this.rooms.entries()).map(([roomId, room]) => ({
      room_id: roomId,
      name: room.name || "",
      type: room.type,
      members: room.members.size,
      created_at: room.created_at,
    }));
  }

  listChannels() {
    return Array.from(this.channels.entries()).map(([channelId, channel]) => ({
      channel_id: channelId,
      name: channel.name || "",
      type: channel.type || "public",
      members: channel.members.size,
      created_at: channel.created_at,
    }));
  }

  handleRoomsRequest(req, res) {
    if (req.method === "GET") {
      this.sendJson(res, 200, { ok: true, rooms: this.listRooms() });
      return;
    }

    if (req.method === "POST") {
      this.readBody(req).then((body) => {
        let payload = null;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          payload = null;
        }
        if (!payload || !payload.type) {
          this.sendJson(res, 400, { ok: false, error: "Missing type" });
          return;
        }
        const name = String(payload.name || "").trim();
        const type = String(payload.type).trim();
        if (!["public", "private"].includes(type)) {
          this.sendJson(res, 400, { ok: false, error: "Invalid room type" });
          return;
        }
        let roomId = "";
        do {
          roomId = `room_${Math.floor(Math.random() * 1000000).toString().padStart(6, "0")}`;
        } while (this.rooms.has(roomId));
        if (type === "private") {
          const password = String(payload.password || "");
          if (!password) {
            this.sendJson(res, 400, { ok: false, error: "Private room requires password" });
            return;
          }
          this.roomPasswords.set(roomId, this.hashPassword(password));
        }
        this.rooms.set(roomId, {
          name,
          type,
          members: new Set(),
          created_at: new Date().toISOString(),
        });
        this.sendJson(res, 200, { ok: true, room: { room_id: roomId, name, type } });
      });
      return;
    }

    this.sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }

  handleChannelsRequest(req, res) {
    if (req.method === "GET") {
      this.sendJson(res, 200, { ok: true, channels: this.listChannels() });
      return;
    }

    if (req.method === "POST") {
      this.readBody(req).then((body) => {
        let payload = null;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          payload = null;
        }
        if (!payload || !payload.name) {
          this.sendJson(res, 400, { ok: false, error: "Missing name" });
          return;
        }
        const name = String(payload.name || "").trim();
        const type = String(payload.type || "public").trim();
        if (!name) {
          this.sendJson(res, 400, { ok: false, error: "Invalid channel name" });
          return;
        }
        if (!["world", "public"].includes(type)) {
          this.sendJson(res, 400, { ok: false, error: "Invalid channel type" });
          return;
        }
        if (this.channelNames.has(name)) {
          this.sendJson(res, 409, { ok: false, error: "Channel name already exists" });
          return;
        }
        let channelId = "";
        do {
          channelId = `channel_${Math.floor(Math.random() * 1000000).toString().padStart(6, "0")}`;
        } while (this.channels.has(channelId));
        this.channels.set(channelId, {
          name,
          type,
          members: new Set(),
          created_at: new Date().toISOString(),
        });
        this.channelNames.set(name, channelId);
        this.sendJson(res, 200, { ok: true, channel: { channel_id: channelId, name, type } });
      });
      return;
    }

    this.sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }

  startIdleSweep() {
    if (this.sweepTimer || this.idleTimeoutMs <= 0) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      if (!this.wsServer) return;
      this.wsServer.clients.forEach((ws) => {
        const client = ws._ufooClient;
        if (!client) return;
        if (now - client.lastSeen >= this.idleTimeoutMs) {
          this.sendError(ws, "Disconnected due to inactivity", true, "IDLE_TIMEOUT");
        }
      });
    }, this.sweepIntervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  stopIdleSweep() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  handleConnection(ws) {
    const client = {
      ws,
      authed: false,
      subscriberId: null,
      nickname: null,
      channels: new Set(),
      helloReceived: false,
      lastSeen: Date.now(),
    };

    ws._ufooClient = client;

    ws.on("message", (data) => {
      client.lastSeen = Date.now();
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
    const world = info.world || "default";

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

    if (this.isNicknameTaken(nickname, world)) {
      this.sendError(client.ws, `Nickname "${nickname}" already exists`, true, "NICKNAME_TAKEN");
      return;
    }

    client.helloReceived = true;
    client.subscriberId = subscriberId;
    client.nickname = nickname;
    client.channelType = channelType;
    client.world = world;
    client.rooms = new Set();

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

  isNicknameTaken(nickname, world) {
    if (this.nicknameScope === "global") {
      return this.clientsByNickname.has(nickname);
    }
    for (const client of this.clientsByNickname.values()) {
      if (client.nickname === nickname && client.world === world) return true;
    }
    return false;
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

    if (!message.token && !message.token_hash) {
      this.sendError(client.ws, "Missing token", false, "AUTH_TOKEN_MISSING");
      return;
    }

    const tokenToCheck = message.token_hash || message.token;
    if (!this.allowAnyToken && !this.allowedTokens.has(tokenToCheck)) {
      this.sendError(client.ws, "Invalid token", true, "AUTH_TOKEN_INVALID");
      return;
    }

    client.authed = true;
    this.send(client.ws, { type: "auth_ok", ok: true });
  }

  handleJoin(client, message) {
    if (!this.requireAuth(client)) return;
    const channel = message.channel;
    const room = message.room;

    if (room) {
      this.handleRoomJoin(client, message);
      return;
    }

    if (!channel) {
      this.sendError(client.ws, "Missing channel", false, "CHANNEL_MISSING");
      return;
    }

    const channelInfo = this.channels.get(channel);
    if (!channelInfo) {
      this.sendError(client.ws, "Channel not found", false, "CHANNEL_NOT_FOUND");
      return;
    }

    channelInfo.members.add(client);
    client.channels.add(channel);
    this.send(client.ws, { type: "join_ack", ok: true, channel });
  }

  handleLeave(client, message) {
    if (!this.requireAuth(client)) return;
    const channel = message.channel;
    const room = message.room;

    if (room) {
      this.handleRoomLeave(client, message);
      return;
    }

    if (!channel) {
      this.sendError(client.ws, "Missing channel", false, "CHANNEL_MISSING");
      return;
    }

    const channelInfo = this.channels.get(channel);
    if (channelInfo) {
      channelInfo.members.delete(client);
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
      if (payload.payload && payload.payload.kind === "wake") {
        this.send(target.ws, { type: "wake", from: client.subscriberId });
      }
      return;
    }

    if (payload.room) {
      if (!client.rooms.has(payload.room)) {
        this.sendError(client.ws, "Join room first", false, "NOT_IN_ROOM");
        return;
      }
      const room = this.rooms.get(payload.room);
      if (!room) {
        this.sendError(client.ws, "Room not found", false, "ROOM_NOT_FOUND");
        return;
      }
      room.members.forEach((member) => {
        if (member !== client) {
          this.send(member.ws, payload);
          if (payload.payload && payload.payload.kind === "wake") {
            this.send(member.ws, { type: "wake", from: client.subscriberId });
          }
        }
      });
      return;
    }

    if (payload.channel) {
      if (!client.channels.has(payload.channel)) {
        this.sendError(client.ws, "Join channel first", false, "NOT_IN_CHANNEL");
        return;
      }
      const channel = this.channels.get(payload.channel);
      const members = channel ? channel.members : null;
      if (!members || members.size === 0) return;
      members.forEach((member) => {
        if (member !== client) {
          this.send(member.ws, payload);
          if (payload.payload && payload.payload.kind === "wake") {
            this.send(member.ws, { type: "wake", from: client.subscriberId });
          }
        }
      });
      return;
    }

    this.sendError(client.ws, "Missing routing target", false, "ROUTE_MISSING");
  }

  handleRoomJoin(client, message) {
    const roomId = String(message.room || "").trim();
    if (!roomId) {
      this.sendError(client.ws, "Missing room", false, "ROOM_MISSING");
      return;
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      this.sendError(client.ws, "Room not found", false, "ROOM_NOT_FOUND");
      return;
    }
    if (room.type === "private") {
      const password = String(message.password || "");
      const hashed = this.hashPassword(password);
      const expected = this.roomPasswords.get(roomId);
      if (!expected || expected !== hashed) {
        this.sendError(client.ws, "Invalid room password", false, "ROOM_PASSWORD_INVALID");
        return;
      }
    }

    if (client.rooms.size >= 1 && !client.rooms.has(roomId)) {
      this.sendError(client.ws, "Already in another room", false, "ROOM_ALREADY_JOINED");
      return;
    }

    room.members.add(client);
    client.rooms.add(roomId);
    this.send(client.ws, { type: "join_ack", ok: true, room: roomId });
  }

  handleRoomLeave(client, message) {
    const roomId = String(message.room || "").trim();
    if (!roomId) {
      this.sendError(client.ws, "Missing room", false, "ROOM_MISSING");
      return;
    }
    const room = this.rooms.get(roomId);
    if (room) {
      room.members.delete(client);
    }
    client.rooms.delete(roomId);
    this.send(client.ws, { type: "leave_ack", ok: true, room: roomId });
  }

  cleanupClient(client) {
    if (client.subscriberId) {
      this.clientsById.delete(client.subscriberId);
    }
    if (client.nickname) {
      this.clientsByNickname.delete(client.nickname);
    }

    client.channels.forEach((channel) => {
      const channelInfo = this.channels.get(channel);
      if (channelInfo) {
        channelInfo.members.delete(client);
      }
    });
    client.channels.clear();

    if (client.rooms) {
      client.rooms.forEach((roomId) => {
        const room = this.rooms.get(roomId);
        if (room) {
          room.members.delete(client);
        }
      });
      client.rooms.clear();
    }
  }
}

module.exports = OnlineServer;

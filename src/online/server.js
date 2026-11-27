const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const EventEmitter = require("events");
const WebSocket = require("ws");
const { generateToken, hashToken } = require("./tokens");
const {
  validatePublicKeyJwk,
  sanitizePublicKeyJwk,
  generatePairCode,
  hashPairCodeSync,
} = require("./remoteCrypto");

/**
 * ufoo-online (Phase 1)
 *
 * Minimal WebSocket relay implementing hello/auth + join/leave + event routing.
 * Intended WebSocket path: /ufoo/online.
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

    // Step 1: --insecure guard
    this.insecure = !!options.insecure;
    if (this.allowedTokens === null && !this.insecure) {
      throw new Error(
        "No tokens configured. Use --token-file to provide tokens, or --insecure to allow any token (dev only)."
      );
    }
    this.allowAnyToken = this.allowedTokens === null && this.insecure;

    this.version = options.version || "0.1.0";
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 10000;
    this.sweepTimer = null;

    this.rooms = new Map();
    this.roomPasswords = new Map();
    this.channelMessageHistory = new Map();
    this.roomMessageHistory = new Map();
    this.channelHistoryLimit = options.channelHistoryLimit ?? 200;
    this.eventSeq = 0;

    // Step 2 + 3: Payload limits
    this.maxHttpBodyBytes = options.maxHttpBodyBytes ?? 65536; // 64 KB
    this.maxWsPayloadBytes = options.maxWsPayloadBytes ?? 1048576; // 1 MB

    // Step 5: Rate limiting config
    this.rateLimitWindow = options.rateLimitWindow ?? 10000; // 10s
    this.rateLimitMax = options.rateLimitMax ?? 60;

    // Security: connection limits
    this.maxConnections = options.maxConnections ?? 1024;
    this.maxConnectionsPerIp = options.maxConnectionsPerIp ?? 64;
    this.connectionsByIp = new Map();

    // Security: room/channel caps
    this.maxRooms = options.maxRooms ?? 10000;
    this.maxChannels = options.maxChannels ?? 10000;

    // Security: input limits
    this.maxIdLength = options.maxIdLength ?? 128;

    // Security: room password brute-force protection
    this.maxRoomAuthFailures = options.maxRoomAuthFailures ?? 5;
    this.roomAuthLockoutMs = options.roomAuthLockoutMs ?? 60000;
    this.roomAuthFailures = new Map(); // clientKey -> { count, lockedUntil }

    // Security: pre-auth connection deadline (shorter than idle timeout)
    this.authDeadlineMs = options.authDeadlineMs ?? 10000;

    // Step 7: TLS support
    this.tlsCert = options.tlsCert || null;
    this.tlsKey = options.tlsKey || null;

    // Phase 5: Device registry, one-time pairing, P2P signaling, and E2EE relay
    this.devices = new Map(); // device_id -> device record
    this.pairingCodes = new Map(); // code_hash -> pairing slot
    this.pendingClaims = new Map(); // claim_id -> pending claim awaiting host approval
    this.pairAuthFailures = new Map(); // ip -> { count, lockedUntil }
    this.maxPairAuthFailures = options.maxPairAuthFailures ?? 10;
    this.pairAuthLockoutMs = options.pairAuthLockoutMs ?? 60000;
    this.maxRelayFrameBytes = options.maxRelayFrameBytes ?? 512 * 1024; // 512 KB
    this.maxPairTtlMs = options.maxPairTtlMs ?? 15 * 60 * 1000; // 15 min cap
    this.pairClaimTimeoutMs = options.pairClaimTimeoutMs ?? 15000;
    this.deviceHeartbeatIntervalMs = options.deviceHeartbeatIntervalMs ?? 15000;
    this.relayRateLimitMax = options.relayRateLimitMax ?? Math.max(this.rateLimitMax * 5, 300);

    // Optional static Web/Mobile PWA hosting for non-/ufoo/online routes
    this.webAppDir = options.webAppDir ? path.resolve(options.webAppDir) : null;
  }

  static mimeTypeForExt(ext) {
    switch (String(ext || "").toLowerCase()) {
      case ".html":
        return "text/html; charset=utf-8";
      case ".js":
      case ".mjs":
        return "application/javascript; charset=utf-8";
      case ".css":
        return "text/css; charset=utf-8";
      case ".json":
        return "application/json; charset=utf-8";
      case ".webmanifest":
        return "application/manifest+json; charset=utf-8";
      case ".svg":
        return "image/svg+xml";
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".webp":
        return "image/webp";
      case ".ico":
        return "image/x-icon";
      case ".woff":
        return "font/woff";
      case ".woff2":
        return "font/woff2";
      case ".wasm":
        return "application/wasm";
      case ".txt":
        return "text/plain; charset=utf-8";
      default:
        return "application/octet-stream";
    }
  }

  serveStaticWebApp(req, res, pathname, search = "") {
    if (!this.webAppDir) return false;
    let rootReal;
    try {
      rootReal = fs.realpathSync(this.webAppDir);
    } catch {
      return false;
    }

    if (pathname === "/") {
      const location = `/remote/${search || ""}`;
      res.writeHead(302, this.corsHeaders({ Location: location, "Cache-Control": "no-cache" }));
      res.end();
      return true;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathname || "/");
    } catch {
      res.writeHead(400, this.corsHeaders({ "Content-Type": "text/plain" }));
      res.end("Bad Request\n");
      return true;
    }

    if (decodedPath.includes("\0")) {
      res.writeHead(400, this.corsHeaders({ "Content-Type": "text/plain" }));
      res.end("Bad Request\n");
      return true;
    }

    const relPath = decodedPath.replace(/^\/+/, "");
    const rawCandidate = relPath ? path.resolve(rootReal, relPath) : path.join(rootReal, "index.html");
    const relFromRoot = path.relative(rootReal, rawCandidate);
    if (relFromRoot.startsWith("..") || path.isAbsolute(relFromRoot)) {
      res.writeHead(403, this.corsHeaders({ "Content-Type": "text/plain" }));
      res.end("Forbidden\n");
      return true;
    }

    let targetPath = rawCandidate;
    let stat = null;
    try {
      stat = fs.statSync(targetPath);
      if (stat.isDirectory()) {
        targetPath = path.join(targetPath, "index.html");
        stat = fs.statSync(targetPath);
      }
    } catch {
      stat = null;
    }

    if (!stat || !stat.isFile()) {
      const hasFileExt = path.extname(relPath) !== "";
      if (hasFileExt) {
        res.writeHead(404, this.corsHeaders({ "Content-Type": "text/plain" }));
        res.end("Not Found\n");
        return true;
      }
      targetPath = path.join(rootReal, "index.html");
      try {
        stat = fs.statSync(targetPath);
      } catch {
        return false;
      }
      if (!stat.isFile()) return false;
    }

    let targetReal;
    try {
      targetReal = fs.realpathSync(targetPath);
    } catch {
      res.writeHead(404, this.corsHeaders({ "Content-Type": "text/plain" }));
      res.end("Not Found\n");
      return true;
    }

    const realRel = path.relative(rootReal, targetReal);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
      res.writeHead(403, this.corsHeaders({ "Content-Type": "text/plain" }));
      res.end("Forbidden\n");
      return true;
    }

    const ext = path.extname(targetReal);
    const isImmutableAsset = realRel.startsWith(`assets${path.sep}`);
    const cacheControl = isImmutableAsset
      ? "public, max-age=31536000, immutable"
      : "no-cache";

    const headers = this.corsHeaders({
      "Content-Type": OnlineServer.mimeTypeForExt(ext),
      "Content-Length": String(stat.size),
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    });

    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(targetReal);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, this.corsHeaders({ "Content-Type": "text/plain" }));
      }
      res.end();
    });
    stream.pipe(res);
    return true;
  }

  parseRequestUrl(rawUrl) {
    try {
      return new URL(rawUrl || "/", "http://localhost");
    } catch {
      return null;
    }
  }

  corsHeaders(extra = {}) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      ...extra,
    };
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

    // Security: warn when binding non-localhost without TLS
    const isLocal = ["127.0.0.1", "localhost", "::1"].includes(this.host);
    if (!isLocal && !this.tlsCert) {
      const msg = `[SECURITY WARNING] Server binding to ${this.host} without TLS. Tokens will be sent in plaintext. Use --tls-cert/--tls-key for production.`;
      process.stderr.write(msg + "\n");
      this.emit("warning", msg);
    }

    const requestHandler = (req, res) => {
      const parsedUrl = this.parseRequestUrl(req.url);
      if (!parsedUrl) {
        res.writeHead(404, this.corsHeaders());
        res.end();
        return;
      }

      const pathname = parsedUrl.pathname || "/";
      const publicMessagesMatch = pathname.match(/^\/ufoo\/online\/public\/channels\/([^/]+)\/messages$/);
      const privateMessagesMatch = pathname.match(/^\/ufoo\/online\/channels\/([^/]+)\/messages$/);
      const roomMessagesMatch = pathname.match(/^\/ufoo\/online\/rooms\/([^/]+)\/messages$/);

      if (req.method === "OPTIONS") {
        res.writeHead(204, this.corsHeaders());
        res.end();
        return;
      }

      if (publicMessagesMatch) {
        const channelRef = decodeURIComponent(publicMessagesMatch[1] || "");
        this.handleChannelMessagesRequest(req, res, channelRef, parsedUrl);
        return;
      }

      if (privateMessagesMatch) {
        const channelRef = decodeURIComponent(privateMessagesMatch[1] || "");
        if (!this.authenticateHttp(req, res)) return;
        this.handleChannelMessagesRequest(req, res, channelRef, parsedUrl);
        return;
      }

      if (pathname === "/ufoo/online/public/channels") {
        this.handlePublicChannelsRequest(req, res, parsedUrl);
        return;
      }

      if (pathname === "/ufoo/online/public/rooms") {
        this.handlePublicRoomsRequest(req, res, parsedUrl);
        return;
      }

      if (roomMessagesMatch) {
        const roomId = decodeURIComponent(roomMessagesMatch[1] || "");
        this.handleRoomMessagesRequest(req, res, roomId, parsedUrl);
        return;
      }

      // DELETE /ufoo/online/rooms/:id
      const roomDeleteMatch = pathname.match(/^\/ufoo\/online\/rooms\/([^/]+)$/);
      if (roomDeleteMatch && req.method === "DELETE") {
        if (!this.authenticateHttp(req, res)) return;
        this.handleRoomDelete(req, res, decodeURIComponent(roomDeleteMatch[1]));
        return;
      }

      if (pathname.startsWith("/ufoo/online/rooms")) {
        // Step 4: HTTP auth
        if (!this.authenticateHttp(req, res)) return;
        this.handleRoomsRequest(req, res);
        return;
      }

      if (pathname === "/ufoo/online/health") {
        res.writeHead(200, this.corsHeaders({ "Content-Type": "text/plain" }));
        res.end("ufoo-online: running\n");
        return;
      }

      if (pathname.startsWith("/ufoo/online/channels")) {
        // Step 4: HTTP auth
        if (!this.authenticateHttp(req, res)) return;
        this.handleChannelsRequest(req, res);
        return;
      }

      if (
        this.webAppDir
        && (req.method === "GET" || req.method === "HEAD")
        && !pathname.startsWith("/ufoo/online")
      ) {
        if (this.serveStaticWebApp(req, res, pathname, parsedUrl.search || "")) {
          return;
        }
      }

      res.writeHead(200, this.corsHeaders({ "Content-Type": "text/plain" }));
      res.end("ufoo-online: running\n");
    };

    // Step 7: TLS support
    if (this.tlsCert && this.tlsKey) {
      this.server = https.createServer(
        {
          cert: fs.readFileSync(this.tlsCert),
          key: fs.readFileSync(this.tlsKey),
        },
        requestHandler
      );
    } else {
      this.server = http.createServer(requestHandler);
    }

    // Step 2: WS maxPayload
    this.wsServer = new WebSocket.Server({ noServer: true, maxPayload: this.maxWsPayloadBytes });
    this.wsServer.on("connection", (ws) => this.handleConnection(ws));

    this.server.on("upgrade", (req, socket, head) => {
      if (!req.url || !req.url.startsWith("/ufoo/online")) {
        socket.destroy();
        return;
      }

      // Security: enforce connection limits before upgrade
      const totalConnections = this.wsServer ? this.wsServer.clients.size : 0;
      if (totalConnections >= this.maxConnections) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }

      const ip = req.socket.remoteAddress || "unknown";
      const ipCount = this.connectionsByIp.get(ip) || 0;
      if (ipCount >= this.maxConnectionsPerIp) {
        socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(req, socket, head, (ws) => {
        ws._remoteIp = ip;
        this.connectionsByIp.set(ip, ipCount + 1);
        this.wsServer.emit("connection", ws, req);
      });
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

    for (const claim of this.pendingClaims.values()) {
      if (claim.timer) clearTimeout(claim.timer);
    }
    this.pendingClaims.clear();

    if (wsServer) {
      wsServer.clients.forEach((client) => client.terminate());
      wsServer.close();
    }

    if (!server) return Promise.resolve();

    return new Promise((resolve) => {
      server.close(() => resolve());
      // Node < 19 keeps idle keep-alive sockets open until keepAliveTimeout
      // (5s), which stalls close(). Drop them so shutdown is immediate.
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    });
  }

  // Step 4: HTTP bearer token authentication
  authenticateHttp(req, res) {
    if (this.allowAnyToken) return true;

    const auth = req.headers.authorization || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      this.sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return false;
    }
    const token = match[1];
    if (!this.allowedTokens || !this.allowedTokens.has(token)) {
      this.sendJson(res, 401, { ok: false, error: "Unauthorized" });
      return false;
    }
    return true;
  }

  // Step 3: readBody with size limit
  readBody(req) {
    const limit = this.maxHttpBodyBytes;
    return new Promise((resolve, reject) => {
      let body = "";
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > limit) {
          req.destroy();
          reject(new Error("Payload too large"));
          return;
        }
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
      req.on("error", (err) => reject(err));
    });
  }

  sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, this.corsHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify(payload));
  }

  // Step 6: scrypt password hashing (replaces SHA256)
  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(String(password || ""), salt, 32);
    return `${salt}:${derived.toString("hex")}`;
  }

  verifyPassword(password, stored) {
    if (!stored || !stored.includes(":")) return false;
    const [salt, hash] = stored.split(":");
    if (!salt || !hash) return false;
    const derived = crypto.scryptSync(String(password || ""), salt, 32);
    const expected = Buffer.from(hash, "hex");
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }

  listRooms() {
    return Array.from(this.rooms.entries()).map(([roomId, room]) => ({
      room_id: roomId,
      name: room.name || "",
      type: room.type,
      members: room.members.size,
      created_at: room.created_at,
      created_by: room.created_by || "",
      password_required: room.type === "private",
    }));
  }

  listChannels() {
    return Array.from(this.channels.entries()).map(([channelId, channel]) => {
      const history = this.channelMessageHistory.get(channelId) || [];
      const last = history.length > 0 ? history[history.length - 1] : null;
      return {
        channel_id: channelId,
        name: channel.name || "",
        type: channel.type || "public",
        members: channel.members.size,
        created_at: channel.created_at,
        created_by: channel.created_by || "",
        message_count: history.length,
        last_message_at: channel.last_message_at || (last ? last.ts : null),
      };
    });
  }

  listPublicRooms(type = "") {
    return this.listRooms()
      .filter((room) => !type || room.type === type)
      .map((room) => ({
        room_id: room.room_id,
        name: room.name || "",
        type: room.type,
        created_at: room.created_at,
        created_by: room.created_by || "",
        password_required: room.password_required !== false,
      }));
  }

  listChannelMessages(channelRef, limit = 80) {
    const resolved = this.resolveChannel(channelRef);
    if (!resolved) return null;
    const history = this.channelMessageHistory.get(resolved.channelId) || [];
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : 80;
    const start = Math.max(0, history.length - safeLimit);
    return {
      channel_id: resolved.channelId,
      name: resolved.channel.name || "",
      type: resolved.channel.type || "public",
      messages: history.slice(start),
    };
  }

  handlePublicRoomsRequest(req, res, parsedUrl) {
    if (req.method !== "GET") {
      this.sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const type = String(parsedUrl.searchParams.get("type") || "").trim();
    this.sendJson(res, 200, { ok: true, rooms: this.listPublicRooms(type) });
  }

  handlePublicChannelsRequest(req, res, parsedUrl) {
    if (req.method !== "GET") {
      this.sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const type = String(parsedUrl.searchParams.get("type") || "").trim();
    const channels = this.listChannels().filter((channel) => !type || channel.type === type);
    this.sendJson(res, 200, { ok: true, channels });
  }

  handleChannelMessagesRequest(req, res, channelRef, parsedUrl) {
    if (req.method !== "GET") {
      this.sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const limitRaw = Number.parseInt(String(parsedUrl.searchParams.get("limit") || "80"), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 80;
    const channelData = this.listChannelMessages(channelRef, limit);
    if (!channelData) {
      this.sendJson(res, 404, { ok: false, error: "Channel not found" });
      return;
    }
    this.sendJson(res, 200, {
      ok: true,
      channel: {
        channel_id: channelData.channel_id,
        name: channelData.name,
        type: channelData.type,
      },
      messages: channelData.messages,
    });
  }

  handleRoomMessagesRequest(req, res, roomId, parsedUrl) {
    if (req.method !== "GET") {
      this.sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const room = this.rooms.get(roomId);
    if (!room) {
      this.sendJson(res, 404, { ok: false, error: "Room not found" });
      return;
    }
    // Private rooms require password via query param
    if (room.type === "private") {
      const password = String(parsedUrl.searchParams.get("password") || "");
      const stored = this.roomPasswords.get(roomId);
      if (!stored || !this.verifyPassword(password, stored)) {
        this.sendJson(res, 403, { ok: false, error: "Invalid room password" });
        return;
      }
    }
    const limitRaw = Number.parseInt(String(parsedUrl.searchParams.get("limit") || "80"), 10);
    const limit = Number.isFinite(limitRaw) ? limitRaw : 80;
    const roomData = this.listRoomMessages(roomId, limit);
    if (!roomData) {
      this.sendJson(res, 404, { ok: false, error: "Room not found" });
      return;
    }
    this.sendJson(res, 200, {
      ok: true,
      room: { room_id: roomData.room_id, name: roomData.name, type: roomData.type },
      messages: roomData.messages,
    });
  }

  recordChannelMessage(channelId, channel, client, eventPayload) {
    const rawText = eventPayload?.payload?.message;
    let text = "";
    if (typeof rawText === "string") text = rawText;
    else if (rawText !== null && rawText !== undefined) text = JSON.stringify(rawText);
    if (!text) return;

    const history = this.channelMessageHistory.get(channelId) || [];
    const ts = eventPayload.ts || new Date().toISOString();
    const entry = {
      event_id: `event_${String(++this.eventSeq).padStart(8, "0")}`,
      ts,
      channel_id: channelId,
      channel_name: channel?.name || channelId,
      from: client.subscriberId || "",
      nickname: client.nickname || "",
      text,
    };
    history.push(entry);
    if (history.length > this.channelHistoryLimit) {
      history.splice(0, history.length - this.channelHistoryLimit);
    }
    this.channelMessageHistory.set(channelId, history);
    if (channel) {
      channel.last_message_at = ts;
    }
  }

  recordRoomMessage(roomId, room, client, eventPayload) {
    const rawText = eventPayload?.payload?.message;
    let text = "";
    if (typeof rawText === "string") text = rawText;
    else if (rawText !== null && rawText !== undefined) text = JSON.stringify(rawText);
    if (!text) return;

    const history = this.roomMessageHistory.get(roomId) || [];
    const ts = eventPayload.ts || new Date().toISOString();
    const entry = {
      event_id: `event_${String(++this.eventSeq).padStart(8, "0")}`,
      ts,
      room_id: roomId,
      room_name: room?.name || roomId,
      from: client.subscriberId || "",
      nickname: client.nickname || "",
      text,
    };
    history.push(entry);
    if (history.length > this.channelHistoryLimit) {
      history.splice(0, history.length - this.channelHistoryLimit);
    }
    this.roomMessageHistory.set(roomId, history);
  }

  listRoomMessages(roomId, limit = 80) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const history = this.roomMessageHistory.get(roomId) || [];
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : 80;
    const start = Math.max(0, history.length - safeLimit);
    return {
      room_id: roomId,
      name: room.name || "",
      type: room.type,
      messages: history.slice(start),
    };
  }

  handleRoomsRequest(req, res) {
    if (req.method === "GET") {
      this.sendJson(res, 200, { ok: true, rooms: this.listRooms() });
      return;
    }

    if (req.method === "POST") {
      this.readBody(req)
        .then((body) => {
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
          const createdBy = String(payload.created_by || payload.creator || "").trim();
          if (!["public", "private"].includes(type)) {
            this.sendJson(res, 400, { ok: false, error: "Invalid room type" });
            return;
          }
          if (name) {
            const nameErr = this.validateIdentifier(name, "name");
            if (nameErr) { this.sendJson(res, 400, { ok: false, error: nameErr }); return; }
          }
          if (createdBy) {
            const creatorErr = this.validateIdentifier(createdBy, "created_by");
            if (creatorErr) { this.sendJson(res, 400, { ok: false, error: creatorErr }); return; }
          }
          if (this.rooms.size >= this.maxRooms) {
            this.sendJson(res, 429, { ok: false, error: "Room limit reached" });
            return;
          }
          let roomId = "";
          let attempts = 0;
          do {
            roomId = `room_${crypto.randomInt(1000000).toString().padStart(6, "0")}`;
            if (++attempts > 100) {
              this.sendJson(res, 503, { ok: false, error: "Unable to generate room ID" });
              return;
            }
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
            observers: new Set(),
            created_at: new Date().toISOString(),
            created_by: createdBy,
          });
          this.sendJson(res, 200, {
            ok: true,
            room: { room_id: roomId, name, type, created_by: createdBy, password_required: type === "private" },
          });
        })
        .catch(() => {
          // Step 3: 413 on payload too large
          this.sendJson(res, 413, { ok: false, error: "Payload too large" });
        });
      return;
    }

    this.sendJson(res, 405, { ok: false, error: "Method not allowed" });
  }

  handleRoomDelete(req, res, roomId) {
    const room = this.rooms.get(roomId);
    if (!room) {
      this.sendJson(res, 404, { ok: false, error: "Room not found" });
      return;
    }
    // Disconnect all members and observers
    const kick = (client) => {
      client.rooms.delete(roomId);
      this.sendError(client.ws, "Room deleted", true, "ROOM_DELETED");
    };
    room.members.forEach(kick);
    if (room.observers) room.observers.forEach(kick);
    this.rooms.delete(roomId);
    this.roomPasswords.delete(roomId);
    this.roomMessageHistory.delete(roomId);
    this.sendJson(res, 200, { ok: true, deleted: roomId });
  }

  handleChannelsRequest(req, res) {
    if (req.method === "GET") {
      this.sendJson(res, 200, { ok: true, channels: this.listChannels() });
      return;
    }

    if (req.method === "POST") {
      this.readBody(req)
        .then((body) => {
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
          const createdBy = String(payload.created_by || payload.creator || "").trim();
          if (!name) {
            this.sendJson(res, 400, { ok: false, error: "Invalid channel name" });
            return;
          }
          const chNameErr = this.validateIdentifier(name, "name");
          if (chNameErr) { this.sendJson(res, 400, { ok: false, error: chNameErr }); return; }
          if (createdBy) {
            const creatorErr = this.validateIdentifier(createdBy, "created_by");
            if (creatorErr) { this.sendJson(res, 400, { ok: false, error: creatorErr }); return; }
          }
          if (!["world", "public"].includes(type)) {
            this.sendJson(res, 400, { ok: false, error: "Invalid channel type" });
            return;
          }
          if (this.channelNames.has(name)) {
            this.sendJson(res, 409, { ok: false, error: "Channel name already exists" });
            return;
          }
          if (this.channels.size >= this.maxChannels) {
            this.sendJson(res, 429, { ok: false, error: "Channel limit reached" });
            return;
          }
          let channelId = "";
          let chAttempts = 0;
          do {
            channelId = `channel_${crypto.randomInt(1000000).toString().padStart(6, "0")}`;
            if (++chAttempts > 100) {
              this.sendJson(res, 503, { ok: false, error: "Unable to generate channel ID" });
              return;
            }
          } while (this.channels.has(channelId));
          this.channels.set(channelId, {
            name,
            type,
            members: new Set(),
            observers: new Set(),
            created_at: new Date().toISOString(),
            created_by: createdBy,
          });
          this.channelNames.set(name, channelId);
          this.sendJson(res, 200, { ok: true, channel: { channel_id: channelId, name, type, created_by: createdBy } });
        })
        .catch(() => {
          // Step 3: 413 on payload too large
          this.sendJson(res, 413, { ok: false, error: "Payload too large" });
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
        // Security: disconnect pre-auth connections faster than idle timeout
        if (!client.authed && now - client.connectedAt >= this.authDeadlineMs) {
          this.sendError(ws, "Auth deadline exceeded", true, "AUTH_DEADLINE");
          return;
        }
        if (now - client.lastSeen >= this.idleTimeoutMs) {
          this.sendError(ws, "Disconnected due to inactivity", true, "IDLE_TIMEOUT");
        }
      });

      // Security: prune expired roomAuthFailures entries
      for (const [key, info] of this.roomAuthFailures) {
        if (info.lockedUntil > 0 && info.lockedUntil <= now) {
          this.roomAuthFailures.delete(key);
        }
      }

      // Phase 5: prune expired pairing codes and pairing auth failure windows
      for (const [codeHash, slot] of this.pairingCodes) {
        if (slot.expires_at <= now || (slot.claimed && now - slot.claimed_at > 60000)) {
          this.pairingCodes.delete(codeHash);
        }
      }
      for (const [key, info] of this.pairAuthFailures) {
        if (info.lockedUntil > 0 && info.lockedUntil <= now) {
          this.pairAuthFailures.delete(key);
        }
      }
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
      role: "agent", // "agent" or "observer"
      channels: new Set(),
      helloReceived: false,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      // Step 5: Rate limiting state
      messageCount: 0,
      rateLimitWindowStart: Date.now(),
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

  // Step 5: Rate limiting check
  checkRateLimit(client) {
    const now = Date.now();
    if (now - client.rateLimitWindowStart >= this.rateLimitWindow) {
      // Reset window
      client.messageCount = 0;
      client.rateLimitWindowStart = now;
    }
    client.messageCount++;
    const limit =
      client.authed && (client.role === "device" || client.role === "remote_client")
        ? this.relayRateLimitMax
        : this.rateLimitMax;
    if (client.messageCount > limit) {
      this.sendError(client.ws, "Rate limit exceeded", true, "RATE_LIMITED");
      return false;
    }
    return true;
  }

  handleMessage(client, data) {
    // Step 5: Rate limit check at entry
    if (!this.checkRateLimit(client)) return;

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
      // Phase 5: Device registry, pairing, P2P signaling & zero-knowledge E2EE relay
      case "device.register":
        this.handleDeviceRegister(client, message);
        return;
      case "device.heartbeat":
        this.handleDeviceHeartbeat(client, message);
        return;
      case "device.status":
        this.handleDeviceStatus(client, message);
        return;
      case "pair.create":
        this.handlePairCreate(client, message);
        return;
      case "pair.claim":
        this.handlePairClaim(client, message);
        return;
      case "pair.approve":
        this.handlePairApprove(client, message);
        return;
      case "pair.reject":
        this.handlePairReject(client, message);
        return;
      case "pair.revoke":
        this.handlePairRevoke(client, message);
        return;
      case "remote.auth":
        this.handleRemoteAuth(client, message);
        return;
      case "signal.offer":
      case "signal.answer":
      case "signal.ice":
      case "signal.probe":
        this.handleSignal(client, message);
        return;
      case "relay.frame":
        this.handleRelayFrame(client, message);
        return;
      default:
        this.sendError(client.ws, "Unknown message type", false, "UNKNOWN_TYPE");
    }
  }

  validateIdentifier(value, label) {
    if (typeof value !== "string" || !value) return `Missing ${label}`;
    if (value.length > this.maxIdLength) return `${label} too long (max ${this.maxIdLength})`;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(value)) return `${label} contains invalid characters`;
    return null;
  }

  handleHello(client, message) {
    if (client.helloReceived) {
      this.sendError(client.ws, "Hello already received", false, "HELLO_DUPLICATE");
      return;
    }

    const info = message.client || {};
    const subscriberId = info.subscriber_id;
    const nickname = info.nickname;
    const world = info.world || "default";

    if (!subscriberId || !nickname) {
      this.sendError(client.ws, "Missing subscriber_id or nickname", false, "HELLO_INVALID");
      return;
    }

    // Security: sanitize subscriber_id and nickname
    const idErr = this.validateIdentifier(subscriberId, "subscriber_id");
    if (idErr) { this.sendError(client.ws, idErr, true, "HELLO_INVALID"); return; }
    const nickErr = this.validateIdentifier(nickname, "nickname");
    if (nickErr) { this.sendError(client.ws, nickErr, true, "HELLO_INVALID"); return; }

    client.helloReceived = true;
    // Security: store pending identity — do NOT register in global maps until auth succeeds
    client.pendingSubscriberId = subscriberId;
    client.pendingNickname = nickname;
    client.pendingWorld = world;
    client.rooms = new Set();

    // Observer role: set from capabilities
    const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
    if (caps.includes("observer")) {
      client.role = "observer";
    }

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

    // Security: register identity AFTER auth succeeds (prevents nickname squatting)
    const subscriberId = client.pendingSubscriberId;
    const nickname = client.pendingNickname;
    const world = client.pendingWorld;

    if (this.clientsById.has(subscriberId)) {
      this.sendError(client.ws, "Subscriber already connected", true, "SUBSCRIBER_EXISTS");
      return;
    }

    if (this.isNicknameTaken(nickname, world)) {
      this.sendError(client.ws, "Nickname already exists", true, "NICKNAME_TAKEN");
      return;
    }

    client.subscriberId = subscriberId;
    client.nickname = nickname;
    client.world = world;
    this.clientsById.set(subscriberId, client);
    this.clientsByNickname.set(nickname, client);

    client.authed = true;
    this.send(client.ws, { type: "auth_ok", ok: true });
  }

  resolveChannel(channelRef) {
    if (!channelRef) return null;
    const direct = this.channels.get(channelRef);
    if (direct) {
      return { channelId: channelRef, channel: direct };
    }
    const mappedId = this.channelNames.get(channelRef);
    if (!mappedId) return null;
    const mapped = this.channels.get(mappedId);
    if (!mapped) return null;
    return { channelId: mappedId, channel: mapped };
  }

  getOrCreateJoinChannel(channelRef) {
    const existing = this.resolveChannel(channelRef);
    if (existing) return existing;

    const channelErr = this.validateIdentifier(channelRef, "channel");
    if (channelErr) {
      return { error: channelErr, code: "CHANNEL_INVALID" };
    }
    if (this.channels.size >= this.maxChannels) {
      return { error: "Channel limit reached", code: "CHANNEL_LIMIT" };
    }

    const channel = {
      name: channelRef,
      type: "public",
      members: new Set(),
      observers: new Set(),
      created_at: new Date().toISOString(),
      created_by: "",
    };
    this.channels.set(channelRef, channel);
    this.channelNames.set(channelRef, channelRef);
    return { channelId: channelRef, channel };
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

    const resolved = this.getOrCreateJoinChannel(channel);
    if (!resolved || resolved.error) {
      this.sendError(
        client.ws,
        resolved?.error || "Channel not found",
        false,
        resolved?.code || "CHANNEL_NOT_FOUND",
      );
      return;
    }
    const channelId = resolved.channelId;
    const channelInfo = resolved.channel;

    if (client.role === "observer") {
      if (!channelInfo.observers) channelInfo.observers = new Set();
      channelInfo.observers.add(client);
    } else {
      channelInfo.members.add(client);
    }
    client.channels.add(channelId);
    this.send(client.ws, { type: "join_ack", ok: true, channel: channelId });
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

    const resolved = this.resolveChannel(channel);
    const channelId = resolved?.channelId || channel;
    const channelInfo = resolved?.channel || null;
    if (channelInfo) {
      channelInfo.members.delete(client);
      if (channelInfo.observers) channelInfo.observers.delete(client);
    }
    client.channels.delete(channelId);
    this.send(client.ws, { type: "leave_ack", ok: true, channel: channelId });
  }

  handleEvent(client, message) {
    if (!this.requireAuth(client)) return;
    if (client.role === "observer") {
      this.sendError(client.ws, "Observers are read-only", false, "EVENT_OBSERVER_READONLY");
      return;
    }
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

    // Security: whitelist forwarded fields instead of spreading entire message
    const payload = {
      type: message.type,
      from: client.subscriberId,
      ts: message.ts || new Date().toISOString(),
      payload: message.payload,
    };
    if (message.to) payload.to = message.to;
    if (message.id) payload.id = message.id;
    if (message.channel) payload.channel = message.channel;
    if (message.room) payload.room = message.room;

    const kind = payload.payload.kind;

    // Resolve allowed kinds based on routing target
    const resolveAllowed = () => {
      if (payload.room) {
        const room = this.rooms.get(payload.room);
        if (room && room.type === "private") return new Set(["message", "decisions.sync", "bus.sync", "wake"]);
        return new Set(["message", "wake"]);
      }
      if (payload.channel) return new Set(["message"]);
      return new Set();
    };

    const allowed = resolveAllowed();
    if (!allowed.has(kind)) {
      this.sendError(client.ws, "Event kind not allowed for this target", false, "EVENT_KIND_FORBIDDEN");
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
      const broadcastRoom = (recipient) => {
        if (recipient !== client) {
          this.send(recipient.ws, payload);
          if (payload.payload && payload.payload.kind === "wake") {
            this.send(recipient.ws, { type: "wake", from: client.subscriberId });
          }
        }
      };
      room.members.forEach(broadcastRoom);
      if (room.observers) room.observers.forEach(broadcastRoom);
      if (kind === "message") {
        this.recordRoomMessage(payload.room, room, client, payload);
      }
      return;
    }

    if (payload.channel) {
      const resolved = this.resolveChannel(payload.channel);
      if (!resolved) {
        this.sendError(client.ws, "Channel not found", false, "CHANNEL_NOT_FOUND");
        return;
      }
      const channelId = resolved.channelId;
      const channel = resolved.channel;

      if (!client.channels.has(channelId)) {
        this.sendError(client.ws, "Join channel first", false, "NOT_IN_CHANNEL");
        return;
      }
      payload.channel = channelId;
      if (kind === "message") {
        this.recordChannelMessage(channelId, channel, client, payload);
      }
      const broadcastChannel = (recipient) => {
        if (recipient !== client) {
          this.send(recipient.ws, payload);
          if (payload.payload && payload.payload.kind === "wake") {
            this.send(recipient.ws, { type: "wake", from: client.subscriberId });
          }
        }
      };
      if (channel.members) channel.members.forEach(broadcastChannel);
      if (channel.observers) channel.observers.forEach(broadcastChannel);
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
      // Security: brute-force protection
      const clientKey = client.subscriberId || (client.ws._remoteIp || "unknown");
      const failInfo = this.roomAuthFailures.get(clientKey);
      if (failInfo && failInfo.lockedUntil > Date.now()) {
        this.sendError(client.ws, "Too many failed attempts, try again later", false, "ROOM_AUTH_LOCKED");
        return;
      }

      const password = String(message.password || "");
      const stored = this.roomPasswords.get(roomId);
      // Step 6: scrypt verification
      if (!stored || !this.verifyPassword(password, stored)) {
        const info = failInfo || { count: 0, lockedUntil: 0 };
        info.count++;
        if (info.count >= this.maxRoomAuthFailures) {
          info.lockedUntil = Date.now() + this.roomAuthLockoutMs;
          info.count = 0;
        }
        this.roomAuthFailures.set(clientKey, info);
        this.sendError(client.ws, "Invalid room password", false, "ROOM_PASSWORD_INVALID");
        return;
      }
      // Reset on success
      this.roomAuthFailures.delete(clientKey);
    }

    if (client.rooms.size >= 1 && !client.rooms.has(roomId)) {
      this.sendError(client.ws, "Already in another room", false, "ROOM_ALREADY_JOINED");
      return;
    }

    if (client.role === "observer") {
      if (!room.observers) room.observers = new Set();
      room.observers.add(client);
    } else {
      room.members.add(client);
    }
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
      if (room.observers) room.observers.delete(client);
    }
    client.rooms.delete(roomId);
    this.send(client.ws, { type: "leave_ack", ok: true, room: roomId });
  }

  // --- Phase 5: Device Registry, One-Time Pairing, P2P Signaling & E2EE Relay ---

  sanitizeCandidates(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw.slice(0, 16)) {
      if (!item || typeof item !== "object") continue;
      const address = String(item.address || item.host || "").trim().slice(0, 128);
      if (!address) continue;
      const kind = String(item.kind || "lan").trim().slice(0, 32);
      const port = Number.isFinite(Number(item.port)) ? Number(item.port) : undefined;
      out.push(port !== undefined ? { kind, address, port } : { kind, address });
    }
    return out;
  }

  verifyTokenHashTimingSafe(expectedHash, rawToken) {
    if (!expectedHash || !rawToken) return false;
    const actualHash = hashToken(String(rawToken));
    const a = Buffer.from(String(expectedHash), "utf8");
    const b = Buffer.from(actualHash, "utf8");
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  checkPairBruteForce(client) {
    const key = client.ws._remoteIp || "unknown";
    const info = this.pairAuthFailures.get(key);
    if (info && info.lockedUntil > Date.now()) {
      this.sendError(client.ws, "Too many failed pairing/auth attempts, try again later", true, "PAIR_AUTH_LOCKED");
      return false;
    }
    return true;
  }

  recordPairFailure(client) {
    const key = client.ws._remoteIp || "unknown";
    const info = this.pairAuthFailures.get(key) || { count: 0, lockedUntil: 0 };
    info.count += 1;
    if (info.count >= this.maxPairAuthFailures) {
      info.lockedUntil = Date.now() + this.pairAuthLockoutMs;
      info.count = 0;
    }
    this.pairAuthFailures.set(key, info);
  }

  clearPairFailure(client) {
    const key = client.ws._remoteIp || "unknown";
    this.pairAuthFailures.delete(key);
  }

  addActiveRemoteClient(device, clientId, remoteClient) {
    let set = device.activeRemoteClients.get(clientId);
    if (!set) {
      set = new Set();
      device.activeRemoteClients.set(clientId, set);
    }
    set.add(remoteClient);
  }

  handleDeviceRegister(client, message) {
    const deviceId = String(message.device_id || "").trim();
    const idErr = this.validateIdentifier(deviceId, "device_id");
    if (idErr) {
      this.sendError(client.ws, idErr, true, "DEVICE_INVALID");
      return;
    }
    if (!validatePublicKeyJwk(message.public_key)) {
      this.sendError(client.ws, "Valid ECDH P-256 public_key is required", true, "DEVICE_KEY_INVALID");
      return;
    }

    if (!client.authed && !this.allowAnyToken) {
      const tokenToCheck = message.token_hash || message.token;
      if (!tokenToCheck || !this.allowedTokens.has(tokenToCheck)) {
        this.sendError(client.ws, "Invalid token", true, "AUTH_TOKEN_INVALID");
        return;
      }
    }

    const deviceName = String(message.device_name || deviceId).trim().slice(0, this.maxIdLength);
    const cleanPubKey = sanitizePublicKeyJwk(message.public_key);
    const candidates = this.sanitizeCandidates(message.candidates);
    const now = Date.now();

    let device = this.devices.get(deviceId);
    if (device && device.ws && device.ws !== client.ws) {
      this.sendError(device.ws, "Device registered from another connection", true, "DEVICE_REPLACED");
    }

    if (!device) {
      device = {
        device_id: deviceId,
        device_name: deviceName,
        public_key: cleanPubKey,
        candidates,
        ws: client.ws,
        client,
        online: true,
        registered_at: new Date(now).toISOString(),
        last_seen: now,
        pairedClients: new Map(),
        activeRemoteClients: new Map(),
      };
      this.devices.set(deviceId, device);
    } else {
      device.device_name = deviceName;
      device.public_key = cleanPubKey;
      device.candidates = candidates;
      device.ws = client.ws;
      device.client = client;
      device.online = true;
      device.last_seen = now;
    }

    if (Array.isArray(message.paired_clients)) {
      const allowedIds = new Set();
      for (const entry of message.paired_clients) {
        if (!entry || typeof entry !== "object") continue;
        const cid = String(entry.client_id || "").trim();
        const th = String(entry.token_hash || "").trim();
        if (!cid || !th || this.validateIdentifier(cid, "client_id")) continue;
        allowedIds.add(cid);
        const existingPair = device.pairedClients.get(cid);
        device.pairedClients.set(cid, {
          client_id: cid,
          label: String(entry.label || existingPair?.label || "Remote Client").slice(0, 64),
          client_public_key: validatePublicKeyJwk(entry.client_public_key)
            ? sanitizePublicKeyJwk(entry.client_public_key)
            : (existingPair?.client_public_key || null),
          token_hash: th,
          paired_at: entry.paired_at || existingPair?.paired_at || new Date(now).toISOString(),
          last_seen: existingPair?.last_seen || new Date(now).toISOString(),
          revoked: false,
        });
      }
      // Disconnect any active remote clients that the host no longer trusts
      for (const [cid, pair] of device.pairedClients.entries()) {
        if (!allowedIds.has(cid)) {
          pair.revoked = true;
          const activeSet = device.activeRemoteClients.get(cid);
          if (activeSet) {
            for (const remote of activeSet) {
              this.sendError(remote.ws, "Remote client access revoked", true, "CLIENT_REVOKED");
            }
            device.activeRemoteClients.delete(cid);
          }
        }
      }
    }

    client.authed = true;
    client.role = "device";
    client.deviceId = deviceId;

    this.send(client.ws, {
      type: "device.registered",
      ok: true,
      device_id: deviceId,
      device_name: device.device_name,
      server_time: new Date(now).toISOString(),
      heartbeat_interval_ms: this.deviceHeartbeatIntervalMs,
    });
  }

  handleDeviceHeartbeat(client, message) {
    if (!client.authed || client.role !== "device" || !client.deviceId) {
      this.sendError(client.ws, "Device registration required", false, "DEVICE_REQUIRED");
      return;
    }
    if (message.device_id && String(message.device_id) !== client.deviceId) {
      this.sendError(client.ws, "Device ID mismatch", false, "DEVICE_MISMATCH");
      return;
    }
    const device = this.devices.get(client.deviceId);
    if (!device || device.ws !== client.ws) {
      this.sendError(client.ws, "Device session not active", true, "DEVICE_INACTIVE");
      return;
    }
    device.last_seen = Date.now();
    device.online = true;
    if (Array.isArray(message.candidates)) {
      device.candidates = this.sanitizeCandidates(message.candidates);
    }
    this.send(client.ws, {
      type: "device.heartbeat_ack",
      ok: true,
      device_id: device.device_id,
      ts: new Date(device.last_seen).toISOString(),
    });
  }

  handleDeviceStatus(client, message) {
    if (!this.requireAuth(client)) return;
    const deviceId = String(message.device_id || (client.role === "device" ? client.deviceId : client.remoteDeviceId) || "").trim();
    if (!deviceId) {
      this.sendError(client.ws, "Missing device_id", false, "DEVICE_MISSING");
      return;
    }
    const device = this.devices.get(deviceId);
    const isOwner = client.role === "device" && client.deviceId === deviceId;
    const isPaired = Boolean(
      client.role === "remote_client"
      && client.remoteDeviceId === deviceId
      && device
      && device.pairedClients.get(client.remoteClientId)
      && !device.pairedClients.get(client.remoteClientId).revoked
    );

    const payload = {
      type: "device.status",
      ok: true,
      device_id: deviceId,
      online: Boolean(device && device.online),
      device_name: device ? device.device_name : "",
      last_seen: device ? new Date(device.last_seen).toISOString() : null,
    };
    if (device && (isOwner || isPaired)) {
      payload.candidates = device.candidates;
      payload.active_clients = device.activeRemoteClients.size;
    }
    this.send(client.ws, payload);
  }

  handlePairCreate(client, message) {
    if (!client.authed || client.role !== "device" || !client.deviceId) {
      this.sendError(client.ws, "Device registration required", false, "DEVICE_REQUIRED");
      return;
    }
    const device = this.devices.get(client.deviceId);
    if (!device || device.ws !== client.ws) {
      this.sendError(client.ws, "Device session not active", true, "DEVICE_INACTIVE");
      return;
    }

    let codeHash = "";
    let generatedCode = "";
    if (typeof message.code_hash === "string" && /^[a-f0-9]{64}$/i.test(message.code_hash.trim())) {
      codeHash = message.code_hash.trim().toLowerCase();
    } else if (typeof message.code === "string" && message.code.trim()) {
      codeHash = hashPairCodeSync(message.code);
    } else {
      generatedCode = generatePairCode(8);
      codeHash = hashPairCodeSync(generatedCode);
    }

    if (!codeHash) {
      this.sendError(client.ws, "Invalid pairing code", false, "PAIR_CODE_INVALID");
      return;
    }

    const rawTtl = Number(message.ttl_ms ?? message.expires_in_ms ?? 300000);
    const ttlMs = Number.isFinite(rawTtl)
      ? Math.max(50, Math.min(rawTtl, this.maxPairTtlMs))
      : 300000;
    const now = Date.now();
    const pairId = String(message.pair_id || `pair_${crypto.randomBytes(8).toString("hex")}`).slice(0, this.maxIdLength);

    this.pairingCodes.set(codeHash, {
      pair_id: pairId,
      code_hash: codeHash,
      device_id: device.device_id,
      device_name: device.device_name,
      host_public_key: device.public_key,
      created_at: now,
      expires_at: now + ttlMs,
      claimed: false,
      claimed_at: 0,
    });

    const response = {
      type: "pair.created",
      ok: true,
      pair_id: pairId,
      device_id: device.device_id,
      expires_at: new Date(now + ttlMs).toISOString(),
    };
    if (generatedCode) response.pair_code = generatedCode;
    this.send(client.ws, response);
  }

  handlePairClaim(client, message) {
    if (!this.checkPairBruteForce(client)) return;

    const clientId = String(message.client_id || "").trim();
    const idErr = this.validateIdentifier(clientId, "client_id");
    if (idErr) {
      this.sendError(client.ws, idErr, false, "PAIR_CLAIM_INVALID");
      return;
    }
    if (!validatePublicKeyJwk(message.client_public_key)) {
      this.sendError(client.ws, "Valid ECDH P-256 client_public_key is required", false, "PAIR_CLAIM_INVALID");
      return;
    }

    let codeHash = "";
    if (typeof message.code_hash === "string" && /^[a-f0-9]{64}$/i.test(message.code_hash.trim())) {
      codeHash = message.code_hash.trim().toLowerCase();
    } else if (typeof message.code === "string" && message.code.trim()) {
      codeHash = hashPairCodeSync(message.code);
    }

    const slot = codeHash ? this.pairingCodes.get(codeHash) : null;
    if (!slot) {
      this.recordPairFailure(client);
      this.sendError(client.ws, "Invalid pairing code", false, "PAIR_CODE_INVALID");
      return;
    }
    if (message.device_id && String(message.device_id).trim() !== slot.device_id) {
      this.recordPairFailure(client);
      this.sendError(client.ws, "Pairing code does not match device", false, "PAIR_CODE_INVALID");
      return;
    }
    if (Date.now() > slot.expires_at) {
      this.pairingCodes.delete(codeHash);
      this.recordPairFailure(client);
      this.sendError(client.ws, "Pairing code expired", false, "PAIR_CODE_EXPIRED");
      return;
    }
    if (slot.claimed) {
      this.recordPairFailure(client);
      this.sendError(client.ws, "Pairing code already used", false, "PAIR_CODE_USED");
      return;
    }

    const device = this.devices.get(slot.device_id);
    if (!device || !device.online || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
      this.sendError(client.ws, "Host device is offline", false, "DEVICE_OFFLINE");
      return;
    }

    // One-time atomic consumption
    slot.claimed = true;
    slot.claimed_at = Date.now();

    const claimId = `claim_${crypto.randomBytes(12).toString("hex")}`;
    const label = String(message.label || "Remote Client").trim().slice(0, 64);
    const cleanClientPub = sanitizePublicKeyJwk(message.client_public_key);
    const clientNonce = String(message.client_nonce || "").slice(0, 128);
    const claimProof = String(message.claim_proof || "").slice(0, 256);

    const timer = setTimeout(() => {
      const pending = this.pendingClaims.get(claimId);
      if (!pending) return;
      this.pendingClaims.delete(claimId);
      this.sendError(pending.remoteClient.ws, "Host did not respond to pairing request", false, "PAIR_TIMEOUT");
    }, this.pairClaimTimeoutMs);
    if (timer.unref) timer.unref();

    this.pendingClaims.set(claimId, {
      claim_id: claimId,
      pair_id: slot.pair_id,
      code_hash: codeHash,
      device_id: device.device_id,
      client_id: clientId,
      label,
      client_public_key: cleanClientPub,
      client_nonce: clientNonce,
      claim_proof: claimProof,
      remoteClient: client,
      timer,
    });
    client.pendingClaimId = claimId;

    this.send(device.ws, {
      type: "pair.claim.request",
      claim_id: claimId,
      pair_id: slot.pair_id,
      device_id: device.device_id,
      client_id: clientId,
      label,
      client_public_key: cleanClientPub,
      client_nonce: clientNonce,
      claim_proof: claimProof,
    });
  }

  handlePairApprove(client, message) {
    if (!client.authed || client.role !== "device" || !client.deviceId) {
      this.sendError(client.ws, "Device registration required", false, "DEVICE_REQUIRED");
      return;
    }
    const claimId = String(message.claim_id || "").trim();
    const claim = this.pendingClaims.get(claimId);
    if (!claim || claim.device_id !== client.deviceId) {
      this.sendError(client.ws, "Pending pairing claim not found", false, "CLAIM_NOT_FOUND");
      return;
    }
    const device = this.devices.get(client.deviceId);
    if (!device || device.ws !== client.ws) {
      this.sendError(client.ws, "Device session not active", true, "DEVICE_INACTIVE");
      return;
    }

    if (claim.timer) clearTimeout(claim.timer);
    this.pendingClaims.delete(claimId);
    claim.remoteClient.pendingClaimId = null;

    const remoteToken = generateToken(32);
    const tokenHash = hashToken(remoteToken);
    const pairedAt = new Date().toISOString();

    device.pairedClients.set(claim.client_id, {
      client_id: claim.client_id,
      label: claim.label,
      client_public_key: claim.client_public_key,
      token_hash: tokenHash,
      paired_at: pairedAt,
      last_seen: pairedAt,
      revoked: false,
    });

    const remoteClient = claim.remoteClient;
    remoteClient.authed = true;
    remoteClient.role = "remote_client";
    remoteClient.remoteDeviceId = device.device_id;
    remoteClient.remoteClientId = claim.client_id;
    this.addActiveRemoteClient(device, claim.client_id, remoteClient);
    this.clearPairFailure(remoteClient);

    const hostPubKey = validatePublicKeyJwk(message.host_public_key)
      ? sanitizePublicKeyJwk(message.host_public_key)
      : device.public_key;

    this.send(client.ws, {
      type: "pair.approved_ack",
      ok: true,
      claim_id: claimId,
      client_id: claim.client_id,
      label: claim.label,
      token_hash: tokenHash,
      paired_at: pairedAt,
    });

    this.send(remoteClient.ws, {
      type: "pair.claimed",
      ok: true,
      device_id: device.device_id,
      device_name: String(message.device_name || device.device_name),
      client_id: claim.client_id,
      host_public_key: hostPubKey,
      host_nonce: String(message.host_nonce || ""),
      host_proof: String(message.host_proof || ""),
      remote_token: remoteToken,
      candidates: device.candidates,
    });
  }

  handlePairReject(client, message) {
    if (!client.authed || client.role !== "device" || !client.deviceId) {
      this.sendError(client.ws, "Device registration required", false, "DEVICE_REQUIRED");
      return;
    }
    const claimId = String(message.claim_id || "").trim();
    const claim = this.pendingClaims.get(claimId);
    if (!claim || claim.device_id !== client.deviceId) {
      this.sendError(client.ws, "Pending pairing claim not found", false, "CLAIM_NOT_FOUND");
      return;
    }
    if (claim.timer) clearTimeout(claim.timer);
    this.pendingClaims.delete(claimId);
    claim.remoteClient.pendingClaimId = null;

    this.recordPairFailure(claim.remoteClient);
    this.sendError(
      claim.remoteClient.ws,
      String(message.reason || "Pairing rejected by host"),
      false,
      "PAIR_REJECTED"
    );
    this.send(client.ws, {
      type: "pair.rejected_ack",
      ok: true,
      claim_id: claimId,
    });
  }

  handlePairRevoke(client, message) {
    if (!client.authed || client.role !== "device" || !client.deviceId) {
      this.sendError(client.ws, "Device registration required", false, "DEVICE_REQUIRED");
      return;
    }
    const device = this.devices.get(client.deviceId);
    if (!device || device.ws !== client.ws) {
      this.sendError(client.ws, "Device session not active", true, "DEVICE_INACTIVE");
      return;
    }
    const targetClientId = String(message.client_id || "").trim();
    if (!targetClientId) {
      this.sendError(client.ws, "Missing client_id", false, "CLIENT_ID_MISSING");
      return;
    }

    const existing = device.pairedClients.get(targetClientId);
    if (existing) {
      existing.revoked = true;
      existing.revoked_at = new Date().toISOString();
    } else {
      device.pairedClients.set(targetClientId, {
        client_id: targetClientId,
        revoked: true,
        revoked_at: new Date().toISOString(),
        token_hash: "",
      });
    }

    const activeSet = device.activeRemoteClients.get(targetClientId);
    if (activeSet) {
      for (const remote of activeSet) {
        this.sendError(remote.ws, "Remote client access revoked", true, "CLIENT_REVOKED");
      }
      device.activeRemoteClients.delete(targetClientId);
    }

    this.send(client.ws, {
      type: "pair.revoked",
      ok: true,
      client_id: targetClientId,
    });
  }

  handleRemoteAuth(client, message) {
    if (!this.checkPairBruteForce(client)) return;

    const deviceId = String(message.device_id || "").trim();
    const clientId = String(message.client_id || "").trim();
    const remoteToken = String(message.remote_token || "").trim();
    if (!deviceId || !clientId || !remoteToken) {
      this.recordPairFailure(client);
      this.sendError(client.ws, "Missing device_id, client_id, or remote_token", true, "REMOTE_AUTH_INVALID");
      return;
    }

    const device = this.devices.get(deviceId);
    if (!device) {
      this.sendError(client.ws, "Host device is offline", true, "DEVICE_OFFLINE");
      return;
    }

    const pair = device.pairedClients.get(clientId);
    if (!pair || pair.revoked) {
      this.recordPairFailure(client);
      this.sendError(client.ws, "Remote client is not paired or has been revoked", true, "CLIENT_REVOKED");
      return;
    }

    if (!this.verifyTokenHashTimingSafe(pair.token_hash, remoteToken)) {
      this.recordPairFailure(client);
      this.sendError(client.ws, "Invalid remote access token", true, "REMOTE_AUTH_INVALID");
      return;
    }

    if (!device.online || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
      this.sendError(client.ws, "Host device is offline", true, "DEVICE_OFFLINE");
      return;
    }

    pair.last_seen = new Date().toISOString();
    client.authed = true;
    client.role = "remote_client";
    client.remoteDeviceId = deviceId;
    client.remoteClientId = clientId;
    this.addActiveRemoteClient(device, clientId, client);
    this.clearPairFailure(client);

    this.send(client.ws, {
      type: "remote.auth_ok",
      ok: true,
      device_id: device.device_id,
      device_name: device.device_name,
      client_id: clientId,
      online: true,
      host_public_key: device.public_key,
      candidates: device.candidates,
    });

    this.send(device.ws, {
      type: "remote.peer_online",
      device_id: device.device_id,
      client_id: clientId,
      label: pair.label,
    });
  }

  handleSignal(client, message) {
    if (!this.requireAuth(client)) return;

    if (client.role === "remote_client") {
      const deviceId = client.remoteDeviceId;
      if (message.device_id && String(message.device_id) !== deviceId) {
        this.sendError(client.ws, "Not paired with target device", false, "PEER_NOT_PAIRED");
        return;
      }
      const device = this.devices.get(deviceId);
      const pair = device ? device.pairedClients.get(client.remoteClientId) : null;
      if (!pair || pair.revoked) {
        this.sendError(client.ws, "Remote client access revoked", true, "CLIENT_REVOKED");
        return;
      }
      if (!device || !device.online || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
        this.sendError(client.ws, "Host device is offline", false, "DEVICE_OFFLINE");
        return;
      }
      const forwarded = {
        type: message.type,
        device_id: deviceId,
        from_client_id: client.remoteClientId,
      };
      if (message.signal_id !== undefined) forwarded.signal_id = String(message.signal_id).slice(0, 128);
      if (message.sdp !== undefined) forwarded.sdp = message.sdp;
      if (message.candidate !== undefined) forwarded.candidate = message.candidate;
      if (message.probe !== undefined) forwarded.probe = message.probe;
      if (message.payload !== undefined) forwarded.payload = message.payload;
      this.send(device.ws, forwarded);
      return;
    }

    if (client.role === "device") {
      const device = this.devices.get(client.deviceId);
      if (!device || device.ws !== client.ws) {
        this.sendError(client.ws, "Device session not active", true, "DEVICE_INACTIVE");
        return;
      }
      const targetClientId = String(message.target_client_id || "").trim();
      if (!targetClientId) {
        this.sendError(client.ws, "Missing target_client_id", false, "TARGET_MISSING");
        return;
      }
      const pair = device.pairedClients.get(targetClientId);
      if (!pair || pair.revoked) {
        this.sendError(client.ws, "Target client is not paired", false, "PEER_NOT_PAIRED");
        return;
      }
      const recipients = device.activeRemoteClients.get(targetClientId);
      if (!recipients || recipients.size === 0) {
        this.sendError(client.ws, "Remote client is offline", false, "PEER_OFFLINE");
        return;
      }
      const forwarded = {
        type: message.type,
        device_id: device.device_id,
        target_client_id: targetClientId,
      };
      if (message.signal_id !== undefined) forwarded.signal_id = String(message.signal_id).slice(0, 128);
      if (message.sdp !== undefined) forwarded.sdp = message.sdp;
      if (message.candidate !== undefined) forwarded.candidate = message.candidate;
      if (message.probe !== undefined) forwarded.probe = message.probe;
      if (message.payload !== undefined) forwarded.payload = message.payload;
      for (const remote of recipients) {
        this.send(remote.ws, forwarded);
      }
      return;
    }

    this.sendError(client.ws, "Signaling requires paired device or remote client", false, "PEER_NOT_PAIRED");
  }

  handleRelayFrame(client, message) {
    if (!this.requireAuth(client)) return;

    if (message.frame === undefined || message.frame === null) {
      this.sendError(client.ws, "Missing opaque frame payload", false, "RELAY_FRAME_INVALID");
      return;
    }
    const frameBytes = Buffer.byteLength(JSON.stringify(message.frame), "utf8");
    if (frameBytes > this.maxRelayFrameBytes) {
      this.sendError(client.ws, "Relay frame exceeds size limit", false, "RELAY_FRAME_TOO_LARGE");
      return;
    }

    // Zero-Knowledge invariant: never inspect or decrypt `message.frame`; route only between verified paired peers.
    const ts = new Date().toISOString();

    if (client.role === "remote_client") {
      const deviceId = client.remoteDeviceId;
      if (message.device_id && String(message.device_id) !== deviceId) {
        this.sendError(client.ws, "Not paired with target device", false, "PEER_NOT_PAIRED");
        return;
      }
      const device = this.devices.get(deviceId);
      const pair = device ? device.pairedClients.get(client.remoteClientId) : null;
      if (!pair || pair.revoked) {
        this.sendError(client.ws, "Remote client access revoked", true, "CLIENT_REVOKED");
        return;
      }
      if (!device || !device.online || !device.ws || device.ws.readyState !== WebSocket.OPEN) {
        this.sendError(client.ws, "Host device is offline", false, "DEVICE_OFFLINE");
        return;
      }
      pair.last_seen = ts;
      this.send(device.ws, {
        type: "relay.frame",
        device_id: deviceId,
        from_client_id: client.remoteClientId,
        frame: message.frame,
        ts,
      });
      return;
    }

    if (client.role === "device") {
      const device = this.devices.get(client.deviceId);
      if (!device || device.ws !== client.ws) {
        this.sendError(client.ws, "Device session not active", true, "DEVICE_INACTIVE");
        return;
      }
      const targetClientId = String(message.target_client_id || "").trim();
      if (!targetClientId) {
        this.sendError(client.ws, "Missing target_client_id", false, "TARGET_MISSING");
        return;
      }
      const pair = device.pairedClients.get(targetClientId);
      if (!pair || pair.revoked) {
        this.sendError(client.ws, "Target client is not paired", false, "PEER_NOT_PAIRED");
        return;
      }
      const recipients = device.activeRemoteClients.get(targetClientId);
      if (!recipients || recipients.size === 0) {
        this.sendError(client.ws, "Remote client is offline", false, "PEER_OFFLINE");
        return;
      }
      for (const remote of recipients) {
        this.send(remote.ws, {
          type: "relay.frame",
          device_id: device.device_id,
          target_client_id: targetClientId,
          frame: message.frame,
          ts,
        });
      }
      return;
    }

    this.sendError(client.ws, "Relay requires paired device or remote client", false, "PEER_NOT_PAIRED");
  }

  cleanupClient(client) {
    // Phase 5: clean up pending pairing claim if client disconnected mid-claim
    if (client.pendingClaimId) {
      const pending = this.pendingClaims.get(client.pendingClaimId);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingClaims.delete(client.pendingClaimId);
      }
      client.pendingClaimId = null;
    }

    // Phase 5: clean up device or remote client state
    if (client.role === "device" && client.deviceId) {
      const device = this.devices.get(client.deviceId);
      if (device && device.ws === client.ws) {
        device.online = false;
        device.ws = null;
        device.client = null;
        for (const remoteSet of device.activeRemoteClients.values()) {
          for (const remote of remoteSet) {
            this.send(remote.ws, { type: "device.offline", device_id: device.device_id });
          }
        }
        for (const [claimId, claim] of this.pendingClaims.entries()) {
          if (claim.device_id === device.device_id) {
            if (claim.timer) clearTimeout(claim.timer);
            this.pendingClaims.delete(claimId);
            this.sendError(claim.remoteClient.ws, "Host device went offline", false, "DEVICE_OFFLINE");
          }
        }
      }
    } else if (client.role === "remote_client" && client.remoteDeviceId && client.remoteClientId) {
      const device = this.devices.get(client.remoteDeviceId);
      if (device) {
        const set = device.activeRemoteClients.get(client.remoteClientId);
        if (set) {
          set.delete(client);
          if (set.size === 0) {
            device.activeRemoteClients.delete(client.remoteClientId);
            if (device.online && device.ws) {
              this.send(device.ws, {
                type: "remote.peer_offline",
                device_id: device.device_id,
                client_id: client.remoteClientId,
              });
            }
          }
        }
      }
    }

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
        if (channelInfo.observers) channelInfo.observers.delete(client);
      }
    });
    client.channels.clear();

    if (client.rooms) {
      client.rooms.forEach((roomId) => {
        const room = this.rooms.get(roomId);
        if (room) {
          room.members.delete(client);
          if (room.observers) room.observers.delete(client);
        }
      });
      client.rooms.clear();
    }

    // Security: decrement per-IP connection count
    const ip = client.ws._remoteIp;
    if (ip && this.connectionsByIp.has(ip)) {
      const count = this.connectionsByIp.get(ip) - 1;
      if (count <= 0) this.connectionsByIp.delete(ip);
      else this.connectionsByIp.set(ip, count);
    }
  }
}

module.exports = OnlineServer;

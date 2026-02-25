const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const OnlineClient = require("./client");
const {
  generateToken,
  getToken,
  getTokenByNickname,
  setToken,
  defaultTokensPath,
} = require("./tokens");

// --- State persistence (for bus/decisions sync) ---

function defaultState() {
  return {
    last_seq: 0,
    synced_decisions: {},
    synced_order: [],
    last_decision_by_nick: {},
  };
}

function normalizeState(state) {
  const merged = { ...defaultState(), ...(state || {}) };
  if (!merged.synced_decisions) merged.synced_decisions = {};
  if (!Array.isArray(merged.synced_order)) merged.synced_order = [];
  if (!merged.last_decision_by_nick) merged.last_decision_by_nick = {};
  return merged;
}

function readState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch {
    return normalizeState(null);
  }
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function markSyncedDecision(state, id) {
  if (!id) return;
  if (state.synced_decisions[id]) return;
  state.synced_decisions[id] = Date.now();
  state.synced_order.push(id);
  if (state.synced_order.length > 500) {
    const remove = state.synced_order.splice(0, state.synced_order.length - 500);
    remove.forEach((rid) => {
      delete state.synced_decisions[rid];
    });
  }
}

function parseDecisionIdFromFile(fileName) {
  if (!fileName) return { id: "" };
  const base = fileName.endsWith(".md") ? fileName.slice(0, -3) : fileName;
  const parts = base.split("-");
  if (parts.length < 3) {
    return { id: base, filename: fileName };
  }
  const num = parseInt(parts[0], 10);
  const nickname = parts[1];
  return {
    id: base,
    filename: fileName,
    num: Number.isFinite(num) ? num : null,
    nickname,
  };
}

// --- Token auto-resolve ---

function resolveToken(opts) {
  if (opts.token) return { token: opts.token, tokenHash: "" };
  if (opts.tokenHash) return { token: "", tokenHash: opts.tokenHash };

  const file = opts.tokenFile || defaultTokensPath();
  if (opts.subscriberId) {
    const existing = getToken(file, opts.subscriberId);
    if (existing) {
      if (existing.token_hash) return { token: "", tokenHash: existing.token_hash };
      if (existing.token) return { token: existing.token, tokenHash: "" };
    }
  }
  if (opts.nickname) {
    const byNick = getTokenByNickname(file, opts.nickname);
    if (byNick) {
      if (byNick.token_hash) return { token: "", tokenHash: byNick.token_hash };
      if (byNick.token) return { token: byNick.token, tokenHash: "" };
    }
  }

  const newToken = generateToken();
  return { token: newToken, tokenHash: "", generated: true };
}

function autoSubscriberId(nickname) {
  const hex = crypto.randomBytes(4).toString("hex");
  return `${nickname || "agent"}:${hex}`;
}

// --- Inbox / Outbox paths ---

function onlineDir() {
  return path.join(
    process.env.HOME || process.env.USERPROFILE,
    ".ufoo",
    "online"
  );
}

function inboxDir() {
  return path.join(onlineDir(), "inbox");
}

function outboxFilePath(nickname) {
  const dir = path.join(onlineDir(), "outbox");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${nickname}.jsonl`);
}

function messageSource(msg) {
  if (msg.room) return "room";
  return "channel";
}

function normalizeOnlineSender(from = "") {
  const text = String(from || "").trim();
  if (!text) return "remote";
  return text;
}

function appendToInbox(nickname, msg) {
  const dir = inboxDir();
  fs.mkdirSync(dir, { recursive: true });
  const entry = {
    ...msg,
    _source: messageSource(msg),
    _receivedAt: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(dir, `${nickname}.jsonl`), JSON.stringify(entry) + "\n");
}

// --- Helpers ---

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class OnlineConnect {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.nickname = options.nickname || "";
    this.subscriberId = options.subscriberId || autoSubscriberId(this.nickname);
    this.url = options.url || "wss://online.ufoo.dev/ufoo/online";
    this.world = options.world || "default";
    this.agentType = options.agentType || "ufoo";
    this.tokenFile = options.tokenFile || "";
    this.pollIntervalMs = options.pollIntervalMs || 1500;
    this.pingMs = options.pingMs || 0;
    this.allowInsecureWs = options.allowInsecureWs || false;

    // Remote trust gating for private rooms
    this.trustRemote = options.trustRemote || false;
    if (Array.isArray(options.allowFrom)) {
      this.allowFrom = new Set(options.allowFrom);
    } else if (typeof options.allowFrom === "string" && options.allowFrom) {
      this.allowFrom = new Set([options.allowFrom]);
    } else {
      this.allowFrom = new Set();
    }

    // Join targets
    this.channel = options.channel || "";
    this.room = options.room || "";
    this.roomPassword = options.roomPassword || "";

    // Token auto-resolve
    const resolved = resolveToken({
      token: options.token || "",
      tokenHash: options.tokenHash || "",
      tokenFile: this.tokenFile,
      subscriberId: this.subscriberId,
      nickname: this.nickname,
    });
    this.token = resolved.token;
    this.tokenHash = resolved.tokenHash;

    // Private room mode enables bus/decisions sync
    this.privateMode = !!this.room;
    this.syncEnabled = this.privateMode && (this.trustRemote || this.allowFrom.size > 0);

    // State for bus/decisions sync (only used in private mode)
    this.stateFile = path.join(this.projectRoot, ".ufoo", "online", "bridge-state.json");
    this.state = this.privateMode ? readState(this.stateFile) : defaultState();

    this.eventBus = null;
    this.pollRunId = 0;
  }

  makeClient() {
    return new OnlineClient({
      url: this.url,
      subscriberId: this.subscriberId,
      nickname: this.nickname,
      world: this.world,
      agentType: this.agentType,
      token: this.token,
      tokenHash: this.tokenHash,
      tokenFile: this.tokenFile,
      allowInsecureWs: this.allowInsecureWs,
      capabilities: this.syncEnabled ? ["bus", "context"] : [],
    });
  }

  async start() {
    if (!this.nickname) throw new Error("--nickname is required");

    // Init local bus only when sync is enabled
    if (this.syncEnabled) {
      const EventBus = require("../bus");
      this.eventBus = new EventBus(this.projectRoot);
      await this.eventBus.ensureJoined();
    }

    // Reconnect loop
    for (let attempt = 0; ; attempt++) {
      try {
        await this.runOnce(attempt);
      } catch (err) {
        console.error(JSON.stringify({
          type: "connect_error",
          message: err?.message || String(err),
        }));
      }
      const delay = Math.min(8000, 500 * Math.pow(2, attempt));
      console.error(JSON.stringify({ type: "reconnect_wait", ms: delay }));
      await sleep(delay);
    }
  }

  async runOnce() {
    const client = this.makeClient();
    let closed = false;

    client.on("message", (msg) => {
      // stdout JSON output
      console.log(JSON.stringify(msg));
      // inbox persistence
      if (msg && msg.type === "event") {
        appendToInbox(this.nickname, msg);
      }
    });

    client.on("error", (err) => {
      console.error(JSON.stringify({
        type: "client_error",
        message: err?.message || String(err),
      }));
    });

    client.on("close", () => {
      console.error(JSON.stringify({ type: "client_close" }));
    });
    const closePromise = new Promise((resolve) => {
      client.once("close", () => {
        closed = true;
        resolve();
      });
    });

    await client.connect();
    console.log("CONNECTED");

    // Persist token on successful connect
    const file = this.tokenFile || defaultTokensPath();
    if (this.token) {
      setToken(file, this.subscriberId, this.token, this.url, { nickname: this.nickname });
    }

    // Join channel or room
    if (this.channel) client.join(this.channel);
    if (this.room) client.joinRoom(this.room, this.roomPassword);

    // Keepalive ping
    let pingTimer = null;
    if (this.pingMs > 0) {
      pingTimer = setInterval(() => client.send({ type: "ping" }), this.pingMs);
    }

    // Message handler for sync-enabled mode (bus/decisions/wake sync)
    if (this.syncEnabled) {
      client.on("message", (msg) => this.handleOnlineMessage(client, msg));
      // Wake handler
      client.on("wake", (msg) => this.handleWake(msg));
    }

    // Keep process alive
    const keepAliveTimer = setInterval(() => {}, 10000);

    // Start poll loop (outbox always, bus/decisions in private mode)
    const runId = ++this.pollRunId;
    const shouldRun = () => !closed && this.pollRunId === runId;
    const pollPromise = this.pollLoop(client, shouldRun);

    // Wait for disconnect
    await closePromise;
    await pollPromise;

    if (pingTimer) clearInterval(pingTimer);
    clearInterval(keepAliveTimer);
  }

  // --- Message handling ---

  handleOnlineMessage(client, msg) {
    if (!msg || msg.type !== "event") return;
    if (!msg.payload || typeof msg.payload.kind !== "string") return;
    if (msg.payload.origin && msg.payload.origin === this.subscriberId) return;

    if (msg.payload.kind === "message") {
      if (!this.isRemoteTrusted(msg)) return;
      if (!this.eventBus) return;
      const from = msg.from || "remote";
      const text = msg.payload.message || "";
      const sender = normalizeOnlineSender(from);
      const decorated = `[ufoo-online] ${sender}: ${String(text || "").trim()}`;
      try {
        this.eventBus.send("*", decorated, "remote:online");
      } catch {
        // ignore
      }
      return;
    }

    if (msg.payload.kind === "decisions.sync") {
      if (!this.isRemoteTrusted(msg)) return;
      this.applyDecisionFromRemote(msg);
    }
  }

  handleWake(msg) {
    if (!this.eventBus) return;
    if (!this.isRemoteTrusted({ from: msg.from || "" })) return;
    const from = msg.from || "";
    try {
      // Trigger local bus wake for this agent's subscriber
      this.eventBus.wake(this.nickname, { reason: `online:${from}` }).catch(() => {});
    } catch {
      // ignore
    }
  }

  isRemoteTrusted(msg) {
    if (this.trustRemote) return true;
    if (!this.allowFrom || this.allowFrom.size === 0) return false;
    const from = msg?.from || "";
    return this.allowFrom.has(from);
  }

  sendEventSafe(client, payload) {
    try {
      return client.sendEvent(payload) === true;
    } catch {
      return false;
    }
  }

  // --- Poll loop: outbox + (private mode: bus/decisions) → online ---

  async pollLoop(client, shouldRun = () => true) {
    while (shouldRun()) {
      try {
        const outboxOk = this.drainOutbox(client);
        if (!outboxOk) {
          try { client.close(); } catch { /* ignore */ }
          return;
        }
        if (this.syncEnabled) {
          const syncBusOk = this.syncLocalToOnline(client);
          if (!syncBusOk) {
            try { client.close(); } catch { /* ignore */ }
            return;
          }
          const syncDecisionsOk = this.syncDecisionsToOnline(client);
          if (!syncDecisionsOk) {
            try { client.close(); } catch { /* ignore */ }
            return;
          }
        }
      } catch {
        // ignore
      }
      if (!shouldRun()) return;
      await sleep(this.pollIntervalMs);
    }
  }

  drainOutbox(client) {
    const file = outboxFilePath(this.nickname);
    const dir = path.dirname(file);
    const base = path.basename(file);
    const drainSuffix = ".drain";
    const drainFiles = [];

    // Drain any leftover temp files (e.g., from a previous crash)
    try {
      const existing = fs.readdirSync(dir)
        .filter((name) => name.startsWith(`${base}.`) && name.endsWith(drainSuffix));
      existing.forEach((name) => drainFiles.push(path.join(dir, name)));
    } catch {
      // ignore
    }

    if (fs.existsSync(file)) {
      const tmp = path.join(dir, `${base}.${process.pid}.${Date.now()}${drainSuffix}`);
      try {
        fs.renameSync(file, tmp);
        drainFiles.push(tmp);
      } catch (err) {
        if (err && (err.code === "ENOENT" || err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES")) {
          // Try again on next poll; avoid truncation-based races.
        } else {
          throw err;
        }
      }
    }

    let sendOk = true;
    for (const drainFile of drainFiles) {
      let raw = "";
      try {
        raw = fs.readFileSync(drainFile, "utf8");
      } catch {
        continue;
      }
      raw = raw.trim();
      if (!raw) {
        try { fs.unlinkSync(drainFile); } catch { /* ignore */ }
        continue;
      }

      if (!sendOk) {
        try {
          fs.appendFileSync(file, `${raw}\n`, "utf8");
        } catch {
          // ignore requeue failures
        }
        try { fs.unlinkSync(drainFile); } catch { /* ignore */ }
        continue;
      }

      const lines = raw.split(/\r?\n/).filter(Boolean);
      const retryLines = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const text = msg.text || msg.message || "";
        if (!text) continue;

        // Determine routing: explicit target in msg, or fall back to connect defaults
        const route = {};
        if (msg.channel) route.channel = msg.channel;
        else if (msg.room) route.room = msg.room;
        else if (this.room) route.room = this.room;
        else if (this.channel) route.channel = this.channel;
        else continue; // nowhere to send

        const sent = this.sendEventSafe(client, {
          ...route,
          payload: { kind: "message", message: text, origin: this.subscriberId },
        });
        if (!sent) {
          sendOk = false;
          retryLines.push(line);
          for (let j = i + 1; j < lines.length; j += 1) {
            retryLines.push(lines[j]);
          }
          break;
        }
      }

      if (retryLines.length > 0) {
        try {
          fs.appendFileSync(file, `${retryLines.join("\n")}\n`, "utf8");
        } catch {
          // ignore requeue failures
        }
      }
      try { fs.unlinkSync(drainFile); } catch { /* ignore */ }
    }
    return sendOk;
  }

  eventRoute() {
    if (this.room) return { room: this.room };
    if (this.channel) return { channel: this.channel };
    return {};
  }

  syncLocalToOnline(client) {
    const eventsDir = path.join(this.projectRoot, ".ufoo", "bus", "events");
    if (!fs.existsSync(eventsDir)) return true;
    const files = fs.readdirSync(eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    let lastSeq = this.state.last_seq || 0;
    let sendFailed = false;

    for (const file of files) {
      const filePath = path.join(eventsDir, file);
      const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let event = null;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!event || !event.seq || event.seq <= lastSeq) continue;
        if (event.event !== "message") continue;
        if (event.publisher === "remote:online") {
          lastSeq = Math.max(lastSeq, event.seq);
          continue;
        }

        const sent = this.sendEventSafe(client, {
          ...this.eventRoute(),
          payload: {
            kind: "message",
            message: event.data?.message || "",
            origin: this.subscriberId,
            target: event.target || "*",
          },
        });
        if (!sent) {
          sendFailed = true;
          break;
        }

        lastSeq = Math.max(lastSeq, event.seq);
      }
      if (sendFailed) break;
    }

    if (lastSeq !== this.state.last_seq) {
      this.state.last_seq = lastSeq;
      writeState(this.stateFile, this.state);
    }
    return !sendFailed;
  }

  syncDecisionsToOnline(client) {
    const decisionsDir = path.join(this.projectRoot, ".ufoo", "context", "decisions");
    if (!fs.existsSync(decisionsDir)) return true;

    const files = fs.readdirSync(decisionsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    let changed = false;
    let sendFailed = false;

    for (const file of files) {
      const parsed = parseDecisionIdFromFile(file);
      if (!parsed.id) continue;

      const nickname = parsed.nickname || "";
      const num = parsed.num || 0;
      const lastNum = this.state.last_decision_by_nick[nickname] || 0;

      if (this.state.synced_decisions[parsed.id]) continue;
      if (nickname && num && num <= lastNum) continue;

      const filePath = path.join(decisionsDir, file);
      const content = fs.readFileSync(filePath, "utf8");

      const sent = this.sendEventSafe(client, {
        ...this.eventRoute(),
        payload: {
          kind: "decisions.sync",
          origin: this.subscriberId,
          decision: {
            id: parsed.id,
            filename: file,
            nickname,
            num,
            content,
          },
        },
      });
      if (!sent) {
        sendFailed = true;
        break;
      }

      markSyncedDecision(this.state, parsed.id);
      if (nickname && num) {
        this.state.last_decision_by_nick[nickname] = Math.max(lastNum, num);
      }
      changed = true;
    }

    if (changed) {
      writeState(this.stateFile, this.state);
    }
    return !sendFailed;
  }

  applyDecisionFromRemote(msg) {
    if (!this.isRemoteTrusted(msg)) return;
    const decision = msg.payload?.decision || {};
    const origin = msg.payload?.origin || "";
    if (origin && origin === this.subscriberId) return;

    const id = decision.id || decision.decision_id || "";
    if (!id) return;

    const rawFilename = decision.filename || decision.file || `${id}.md`;
    const content = decision.content || "";
    if (!content) return;

    const parsed = parseDecisionIdFromFile(rawFilename);
    const nickname = decision.nickname || parsed.nickname || "";
    const num = decision.num || parsed.num || 0;

    const decisionsDir = path.join(this.projectRoot, ".ufoo", "context", "decisions");
    fs.mkdirSync(decisionsDir, { recursive: true });

    // Step 8: Path traversal defense (3 layers)
    // Layer 1: strip directory components
    let safeFilename = path.basename(rawFilename);
    // Layer 2: whitelist allowed characters
    if (!/^[\w\-.]+$/.test(safeFilename)) return;
    // Ensure .md extension
    if (!safeFilename.endsWith(".md")) safeFilename = `${safeFilename}.md`;
    // Layer 3: verify resolved path stays within decisionsDir
    const targetPath = path.resolve(decisionsDir, safeFilename);
    if (!targetPath.startsWith(decisionsDir + path.sep) && targetPath !== decisionsDir) return;

    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, content, "utf8");
    }

    markSyncedDecision(this.state, id);
    if (nickname && num) {
      const lastNum = this.state.last_decision_by_nick[nickname] || 0;
      this.state.last_decision_by_nick[nickname] = Math.max(lastNum, num);
    }

    try {
      const DecisionsManager = require("../context/decisions");
      const manager = new DecisionsManager(this.projectRoot);
      manager.writeIndex();
    } catch {
      // ignore
    }

    writeState(this.stateFile, this.state);
  }
}

module.exports = OnlineConnect;

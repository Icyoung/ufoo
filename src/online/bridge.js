const fs = require("fs");
const path = require("path");
const EventBus = require("../bus");
const OnlineClient = require("./client");
const DecisionsManager = require("../context/decisions");

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

class OnlineBridge {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.channel = options.channel || "";
    this.channelType = options.channelType || "private";
    this.world = options.world || "default";
    this.subscriberId = options.subscriberId || "";
    this.nickname = options.nickname || "";
    this.agentType = options.agentType || "ufoo";
    this.url = options.url || "ws://127.0.0.1:8787/ufoo/online";
    this.token = options.token || "";
    this.tokenHash = options.tokenHash || "";
    this.tokenFile = options.tokenFile || "";
    this.pollIntervalMs = options.pollIntervalMs || 1500;

    this.eventBus = new EventBus(this.projectRoot);
    this.client = new OnlineClient({
      url: this.url,
      subscriberId: this.subscriberId,
      nickname: this.nickname,
      channelType: this.channelType,
      world: this.world,
      agentType: this.agentType,
      token: this.token,
      tokenHash: this.tokenHash,
      tokenFile: this.tokenFile,
      capabilities: ["bus", "context"],
    });

    this.stateFile = path.join(this.projectRoot, ".ufoo", "online", "bridge-state.json");
    this.state = readState(this.stateFile);
    this.running = false;
  }

  async start() {
    if (!this.channel) throw new Error("bridge requires --channel");
    if (!this.subscriberId || !this.nickname) {
      throw new Error("bridge requires --subscriber and --nickname");
    }

    await this.eventBus.ensureJoined();

    await this.client.connect();
    this.client.join(this.channel);

    this.client.on("message", (msg) => this.handleOnlineMessage(msg));

    this.running = true;
    await this.pollLoop();
  }

  stop() {
    this.running = false;
    try {
      this.client.close();
    } catch {
      // ignore
    }
  }

  handleOnlineMessage(msg) {
    if (!msg || msg.type !== "event") return;
    if (!msg.payload || typeof msg.payload.kind !== "string") return;
    if (msg.payload.origin && msg.payload.origin === this.subscriberId) return;

    if (msg.payload.kind === "message") {
      const from = msg.from || "remote";
      const text = msg.payload.message || "";
      const decorated = `[${from}] ${text}`.trim();

      try {
        this.eventBus.send("*", decorated, "remote:online");
      } catch {
        // ignore
      }
      return;
    }

    if (msg.payload.kind === "decisions.sync") {
      this.applyDecisionFromRemote(msg);
    }
  }

  async pollLoop() {
    while (this.running) {
      try {
        await this.syncLocalToOnline();
        await this.syncDecisionsToOnline();
      } catch {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async syncLocalToOnline() {
    const eventsDir = path.join(this.projectRoot, ".ufoo", "bus", "events");
    if (!fs.existsSync(eventsDir)) return;
    const files = fs.readdirSync(eventsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    let lastSeq = this.state.last_seq || 0;

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

        const payload = {
          kind: "message",
          message: event.data?.message || "",
          origin: this.subscriberId,
          target: event.target || "*",
        };

        this.client.sendEvent({
          channel: this.channel,
          payload,
        });

        lastSeq = Math.max(lastSeq, event.seq);
      }
    }

    if (lastSeq !== this.state.last_seq) {
      this.state.last_seq = lastSeq;
      writeState(this.stateFile, this.state);
    }
  }

  async syncDecisionsToOnline() {
    const decisionsDir = path.join(this.projectRoot, ".ufoo", "context", "decisions");
    if (!fs.existsSync(decisionsDir)) return;

    const files = fs.readdirSync(decisionsDir)
      .filter((f) => f.endsWith(".md"))
      .sort();

    let changed = false;

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

      const payload = {
        kind: "decisions.sync",
        origin: this.subscriberId,
        decision: {
          id: parsed.id,
          filename: file,
          nickname,
          num,
          content,
        },
      };

      this.client.sendEvent({
        channel: this.channel,
        payload,
      });

      markSyncedDecision(this.state, parsed.id);
      if (nickname && num) {
        this.state.last_decision_by_nick[nickname] = Math.max(lastNum, num);
      }
      changed = true;
    }

    if (changed) {
      writeState(this.stateFile, this.state);
    }
  }

  applyDecisionFromRemote(msg) {
    const decision = msg.payload?.decision || {};
    const origin = msg.payload?.origin || "";
    if (origin && origin === this.subscriberId) return;

    const id = decision.id || decision.decision_id || "";
    if (!id) return;

    const filename = decision.filename || decision.file || `${id}.md`;
    const content = decision.content || "";
    if (!content) return;

    const parsed = parseDecisionIdFromFile(filename);
    const nickname = decision.nickname || parsed.nickname || "";
    const num = decision.num || parsed.num || 0;

    const decisionsDir = path.join(this.projectRoot, ".ufoo", "context", "decisions");
    fs.mkdirSync(decisionsDir, { recursive: true });

    const targetFile = filename.endsWith(".md") ? filename : `${filename}.md`;
    const targetPath = path.join(decisionsDir, targetFile);

    if (!fs.existsSync(targetPath)) {
      fs.writeFileSync(targetPath, content, "utf8");
    }

    markSyncedDecision(this.state, id);
    if (nickname && num) {
      const lastNum = this.state.last_decision_by_nick[nickname] || 0;
      this.state.last_decision_by_nick[nickname] = Math.max(lastNum, num);
    }

    try {
      const manager = new DecisionsManager(this.projectRoot);
      manager.writeIndex();
    } catch {
      // ignore
    }

    writeState(this.stateFile, this.state);
  }
}

module.exports = OnlineBridge;

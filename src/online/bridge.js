const fs = require("fs");
const path = require("path");
const EventBus = require("../bus");
const OnlineClient = require("./client");

function readState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return { last_seq: 0 };
  }
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
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
      capabilities: ["bus"],
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
    if (!msg.payload || msg.payload.kind !== "message") return;
    if (msg.payload.origin && msg.payload.origin === this.subscriberId) return;

    const from = msg.from || "remote";
    const text = msg.payload.message || "";
    const decorated = `[${from}] ${text}`.trim();

    try {
      this.eventBus.send("*", decorated, "remote:online");
    } catch {
      // ignore
    }
  }

  async pollLoop() {
    while (this.running) {
      try {
        await this.syncLocalToOnline();
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
}

module.exports = OnlineBridge;

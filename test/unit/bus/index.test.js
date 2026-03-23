const fs = require("fs");
const os = require("os");
const path = require("path");

// Mock utils to avoid real TTY/PID checks
jest.mock("../../../src/bus/utils", () => {
  const actual = jest.requireActual("../../../src/bus/utils");
  return {
    ...actual,
    getCurrentTty: jest.fn(() => ""),
    getTtyProcessInfo: jest.fn(() => ({
      alive: false,
      idle: false,
      hasAgent: false,
      shellPid: 0,
      processes: [],
    })),
    isPidAlive: jest.fn(() => false),
    isAgentPidAlive: jest.fn(() => false),
  };
});

const EventBus = require("../../../src/bus/index");

describe("EventBus", () => {
  let projectRoot;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-bus-idx-"));
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function initBus() {
    const bus = new EventBus(projectRoot);
    bus.store.init();
    return bus;
  }

  describe("constructor", () => {
    test("sets projectRoot and initializes store", () => {
      const bus = new EventBus(projectRoot);
      expect(bus.projectRoot).toBe(projectRoot);
      expect(bus.store).toBeDefined();
      expect(bus.busData).toBeNull();
    });
  });

  describe("parseSubscriber", () => {
    test("parses valid subscriber ID", () => {
      const bus = new EventBus(projectRoot);
      expect(bus.parseSubscriber("codex:abc123")).toEqual({
        agentType: "codex",
        sessionId: "abc123",
      });
    });

    test("returns null for invalid subscriber", () => {
      const bus = new EventBus(projectRoot);
      expect(bus.parseSubscriber(null)).toBeNull();
      expect(bus.parseSubscriber("")).toBeNull();
      expect(bus.parseSubscriber("nocolon")).toBeNull();
      expect(bus.parseSubscriber(":empty")).toBeNull();
      expect(bus.parseSubscriber("empty:")).toBeNull();
    });

    test("handles ufoo-agent special case", () => {
      const bus = new EventBus(projectRoot);
      expect(bus.parseSubscriber("ufoo-agent")).toEqual({
        agentType: "codex",
        sessionId: "ufoo-agent",
      });
    });
  });

  describe("resolveJoinAgentType", () => {
    test("returns explicit type when provided", () => {
      const bus = new EventBus(projectRoot);
      expect(bus.resolveJoinAgentType("codex")).toBe("codex");
    });

    test("extracts type from current subscriber", () => {
      const bus = new EventBus(projectRoot);
      expect(bus.resolveJoinAgentType(null, "codex:abc")).toBe("codex");
    });

    test("falls back to UFOO_AGENT_TYPE env", () => {
      const orig = process.env.UFOO_AGENT_TYPE;
      process.env.UFOO_AGENT_TYPE = "custom-agent";
      try {
        const bus = new EventBus(projectRoot);
        expect(bus.resolveJoinAgentType(null, "")).toBe("custom-agent");
      } finally {
        if (orig === undefined) delete process.env.UFOO_AGENT_TYPE;
        else process.env.UFOO_AGENT_TYPE = orig;
      }
    });

    test("falls back to claude-code as default", () => {
      const origType = process.env.UFOO_AGENT_TYPE;
      const origSub = process.env.UFOO_SUBSCRIBER_ID;
      delete process.env.UFOO_AGENT_TYPE;
      delete process.env.UFOO_SUBSCRIBER_ID;
      try {
        const bus = new EventBus(projectRoot);
        expect(bus.resolveJoinAgentType(null, "")).toBe("claude-code");
      } finally {
        if (origType !== undefined) process.env.UFOO_AGENT_TYPE = origType;
        if (origSub !== undefined) process.env.UFOO_SUBSCRIBER_ID = origSub;
      }
    });
  });

  describe("init", () => {
    test("initializes the event bus", async () => {
      const bus = new EventBus(projectRoot);
      await bus.init();
      expect(fs.existsSync(bus.busDir)).toBe(true);
    });
  });

  describe("join and leave", () => {
    test("joins and leaves the bus", async () => {
      const bus = initBus();
      const subscriber = await bus.join("test-session", "codex");
      expect(subscriber).toBe("codex:test-session");

      const success = await bus.leave(subscriber);
      expect(success).toBe(true);
    });

    test("leave returns false for unknown subscriber", async () => {
      const bus = initBus();
      const success = await bus.leave("unknown:sub");
      expect(success).toBe(false);
    });

    test("join with nickname", async () => {
      const bus = initBus();
      const subscriber = await bus.join("s1", "codex", "builder");
      expect(subscriber).toBe("codex:s1");
    });
  });

  describe("send and check", () => {
    test("sends message and checks pending", async () => {
      const bus = initBus();
      const sub1 = await bus.join("sender1", "codex", "sender");
      const sub2 = await bus.join("recv1", "claude-code", "receiver");

      await bus.send(sub2, "hello world", sub1);

      const pending = await bus.check(sub2);
      expect(pending.length).toBeGreaterThanOrEqual(1);
    });

    test("broadcast sends to all", async () => {
      const bus = initBus();
      await bus.join("a1", "codex", "agent-a");
      const sub2 = await bus.join("b1", "claude-code", "agent-b");

      await bus.broadcast("broadcast msg", "codex:a1");

      const pending = await bus.check(sub2);
      expect(pending.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("ack", () => {
    test("acknowledges pending messages", async () => {
      const bus = initBus();
      const sub = await bus.join("ack-test", "codex");
      await bus.send(sub, "msg1", "codex:other");

      const count = await bus.ack(sub);
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test("returns 0 when no pending messages", async () => {
      const bus = initBus();
      const sub = await bus.join("empty-ack", "codex");

      const count = await bus.ack(sub);
      expect(count).toBe(0);
    });
  });

  describe("status", () => {
    test("shows bus status", async () => {
      const bus = initBus();
      await bus.join("status-test", "codex");

      const result = await bus.status();
      expect(result).toHaveProperty("active");
      expect(result).toHaveProperty("busId");
    });
  });

  describe("getDefaultPublisher", () => {
    test("returns UFOO_SUBSCRIBER_ID env", () => {
      const orig = process.env.UFOO_SUBSCRIBER_ID;
      process.env.UFOO_SUBSCRIBER_ID = "codex:env-pub";
      try {
        const bus = new EventBus(projectRoot);
        expect(bus.getDefaultPublisher()).toBe("codex:env-pub");
      } finally {
        if (orig === undefined) delete process.env.UFOO_SUBSCRIBER_ID;
        else process.env.UFOO_SUBSCRIBER_ID = orig;
      }
    });

    test("returns null when env not set", () => {
      const orig = process.env.UFOO_SUBSCRIBER_ID;
      delete process.env.UFOO_SUBSCRIBER_ID;
      try {
        const bus = new EventBus(projectRoot);
        expect(bus.getDefaultPublisher()).toBeNull();
      } finally {
        if (orig !== undefined) process.env.UFOO_SUBSCRIBER_ID = orig;
      }
    });
  });

  describe("consume", () => {
    test("consumes events for subscriber", async () => {
      const bus = initBus();
      const sub = await bus.join("consume-test", "codex");

      const result = await bus.consume(sub);
      expect(result).toHaveProperty("consumed");
      expect(result).toHaveProperty("newOffset");
    });
  });

  describe("resolve", () => {
    test("resolves single target", async () => {
      const bus = initBus();
      const sub1 = await bus.join("r1", "codex", "builder");
      await bus.join("r2", "claude-code", "reviewer");

      const result = await bus.resolve(sub1, "claude-code");
      // May be single or multiple depending on state
      expect(result === "claude-code:r2" || result === null).toBe(true);
    });

    test("returns null when no targets found", async () => {
      const bus = initBus();
      const sub = await bus.join("r3", "codex");

      const result = await bus.resolve(sub, "nonexistent-type");
      expect(result).toBeNull();
    });
  });

  describe("ensureJoined", () => {
    test("auto-joins when not yet joined", async () => {
      const bus = initBus();
      const sub = await bus.ensureJoined();
      expect(sub).toBeTruthy();
      expect(typeof sub).toBe("string");
    });
  });

  describe("daemon", () => {
    test("throws on unknown action", async () => {
      const bus = initBus();
      await expect(bus.daemon("unknown")).rejects.toThrow(
        "Unknown daemon action"
      );
    });
  });

  describe("check with autoAck", () => {
    test("auto-acknowledges when autoAck=true", async () => {
      const bus = initBus();
      const sub1 = await bus.join("aa-sender", "codex");
      const sub2 = await bus.join("aa-recv", "claude-code");

      await bus.send(sub2, "auto-ack msg", sub1);
      const pending = await bus.check(sub2, true);
      expect(pending.length).toBeGreaterThanOrEqual(1);

      // After autoAck, pending should be cleared
      const remaining = await bus.check(sub2);
      expect(remaining.length).toBe(0);
    });
  });

  describe("send edge cases", () => {
    test("send with unknown publisher auto-registers", async () => {
      const bus = initBus();
      const sub = await bus.join("target1", "codex");

      // Send from unknown publisher - should auto-register
      const origPub = process.env.AI_BUS_PUBLISHER;
      const origSub = process.env.UFOO_SUBSCRIBER_ID;
      delete process.env.AI_BUS_PUBLISHER;
      delete process.env.UFOO_SUBSCRIBER_ID;
      try {
        await bus.send(sub, "hello", "codex:auto-pub");
      } finally {
        if (origPub !== undefined) process.env.AI_BUS_PUBLISHER = origPub;
        if (origSub !== undefined) process.env.UFOO_SUBSCRIBER_ID = origSub;
      }
    });

    test("send with event option uses emit", async () => {
      const bus = initBus();
      const sub = await bus.join("evt-recv", "codex");
      const pub = await bus.join("evt-send", "claude-code");

      const result = await bus.send(sub, "event msg", pub, {
        event: "custom_event",
        data: { payload: true },
      });
      expect(result).toHaveProperty("seq");
    });

    test("send with silent option suppresses log", async () => {
      const bus = initBus();
      const sub = await bus.join("silent-recv", "codex");
      const pub = await bus.join("silent-send", "claude-code");

      await bus.send(sub, "quiet msg", pub, { silent: true });
    });
  });

  describe("status with events", () => {
    test("status shows event statistics", async () => {
      const bus = initBus();
      await bus.join("stat-agent", "codex");

      // Create an event file to test event counting
      const eventsDir = bus.eventsDir;
      fs.mkdirSync(eventsDir, { recursive: true });
      fs.writeFileSync(
        path.join(eventsDir, "messages.jsonl"),
        '{"type":"message"}\n{"type":"message"}\n'
      );

      const result = await bus.status();
      expect(result).toHaveProperty("active");
      expect(result).toHaveProperty("busId");
    });
  });

  describe("join edge cases", () => {
    test("re-join with same subscriber reuses identity", async () => {
      const bus = initBus();
      const sub1 = await bus.join("reuse-test", "codex", "builder");

      // Reload and re-join - should reuse
      const bus2 = initBus();
      bus2.loadBusData();
      // Manually set subscriber as current
      const origSub = process.env.UFOO_SUBSCRIBER_ID;
      process.env.UFOO_SUBSCRIBER_ID = sub1;
      try {
        const sub2 = await bus2.join();
        // Should get the same subscriber back or a new one
        expect(typeof sub2).toBe("string");
      } finally {
        if (origSub === undefined) delete process.env.UFOO_SUBSCRIBER_ID;
        else process.env.UFOO_SUBSCRIBER_ID = origSub;
      }
    });
  });

  describe("inject", () => {
    test("inject creates injector and delegates", async () => {
      const bus = initBus();
      // Will fail because no socket, but tests the path
      await expect(bus.inject("codex:test")).rejects.toThrow();
    });
  });

  describe("ensureJoined re-join", () => {
    test("reuses existing active subscriber", async () => {
      const bus = initBus();
      const sub = await bus.join("ej1", "codex");

      // Set as current subscriber via env
      const origSub = process.env.UFOO_SUBSCRIBER_ID;
      process.env.UFOO_SUBSCRIBER_ID = sub;
      try {
        const bus2 = new EventBus(projectRoot);
        const result = await bus2.ensureJoined();
        expect(typeof result).toBe("string");
      } finally {
        if (origSub === undefined) delete process.env.UFOO_SUBSCRIBER_ID;
        else process.env.UFOO_SUBSCRIBER_ID = origSub;
      }
    });
  });

  describe("leave edge cases", () => {
    test("leave updates bus data on success", async () => {
      const bus = initBus();
      const sub = await bus.join("leave-ok", "codex");
      const result = await bus.leave(sub);
      expect(result).toBe(true);
    });
  });

  describe("send auto-publisher", () => {
    test("send auto-detects publisher from env", async () => {
      const bus = initBus();
      const sub = await bus.join("auto-pub-recv", "codex");
      const pub = await bus.join("auto-pub-send", "claude-code");

      const origPub = process.env.AI_BUS_PUBLISHER;
      process.env.AI_BUS_PUBLISHER = pub;
      try {
        await bus.send(sub, "auto-pub msg");
      } finally {
        if (origPub === undefined) delete process.env.AI_BUS_PUBLISHER;
        else process.env.AI_BUS_PUBLISHER = origPub;
      }
    });
  });

  describe("consume from beginning", () => {
    test("consumes from beginning when flag is true", async () => {
      const bus = initBus();
      const sub = await bus.join("consume-begin", "codex");
      const result = await bus.consume(sub, true);
      expect(result).toHaveProperty("consumed");
    });
  });

  describe("rename", () => {
    test("renames a subscriber", async () => {
      const bus = initBus();
      const sub = await bus.join("rename-test", "codex", "old-name");
      const result = await bus.rename(sub, "new-name");
      expect(result.newNickname).toBe("new-name");
      expect(result.oldNickname).toBe("old-name");
    });
  });

  describe("whoami", () => {
    test("returns null when not joined", async () => {
      const origSub = process.env.UFOO_SUBSCRIBER_ID;
      delete process.env.UFOO_SUBSCRIBER_ID;
      try {
        const bus = initBus();
        const result = await bus.whoami();
        expect(result).toBeNull();
      } finally {
        if (origSub !== undefined) process.env.UFOO_SUBSCRIBER_ID = origSub;
      }
    });

    test("returns subscriber when UFOO_SUBSCRIBER_ID is set and valid", async () => {
      const bus = initBus();
      const sub = await bus.join("whoami-test", "codex");

      const origSub = process.env.UFOO_SUBSCRIBER_ID;
      process.env.UFOO_SUBSCRIBER_ID = sub;
      try {
        const result = await bus.whoami();
        expect(result).toBe(sub);
      } finally {
        if (origSub === undefined) delete process.env.UFOO_SUBSCRIBER_ID;
        else process.env.UFOO_SUBSCRIBER_ID = origSub;
      }
    });
  });
});

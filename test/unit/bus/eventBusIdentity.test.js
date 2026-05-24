const fs = require("fs");
const EventBus = require("../../../src/coordination/bus");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

describe("EventBus identity behavior", () => {
  const testProjectRoot = "/tmp/ufoo-eventbus-identity-test";
  let consoleLogSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  let originalSubscriber;
  let originalAgentType;

  function readAgents(projectRoot) {
    const file = getUfooPaths(projectRoot).agentsFile;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  beforeEach(() => {
    if (fs.existsSync(testProjectRoot)) {
      fs.rmSync(testProjectRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testProjectRoot, { recursive: true });

    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    originalSubscriber = process.env.UFOO_SUBSCRIBER_ID;
    originalAgentType = process.env.UFOO_AGENT_TYPE;
    delete process.env.UFOO_SUBSCRIBER_ID;
    delete process.env.UFOO_AGENT_TYPE;
  });

  afterEach(() => {
    if (fs.existsSync(testProjectRoot)) {
      fs.rmSync(testProjectRoot, { recursive: true, force: true });
    }

    if (typeof originalSubscriber === "string") {
      process.env.UFOO_SUBSCRIBER_ID = originalSubscriber;
    } else {
      delete process.env.UFOO_SUBSCRIBER_ID;
    }
    if (typeof originalAgentType === "string") {
      process.env.UFOO_AGENT_TYPE = originalAgentType;
    } else {
      delete process.env.UFOO_AGENT_TYPE;
    }

    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test("join without args should reuse existing active subscriber", async () => {
    const bus = new EventBus(testProjectRoot);
    await bus.init();

    process.env.UFOO_SUBSCRIBER_ID = "codex:abc123";
    await bus.join("abc123", "codex", "codex-1");

    const result = await bus.join();
    const data = readAgents(testProjectRoot);

    expect(result).toBe("codex:abc123");
    expect(Object.keys(data.agents)).toEqual(["codex:abc123"]);
    expect(data.agents["codex:abc123"].agent_type).toBe("codex");
  });

  test("join without args should re-register current subscriber when metadata is missing", async () => {
    const bus = new EventBus(testProjectRoot);
    await bus.init();

    process.env.UFOO_SUBSCRIBER_ID = "codex:reuse001";
    const result = await bus.join();
    const data = readAgents(testProjectRoot);

    expect(result).toBe("codex:reuse001");
    expect(data.agents["codex:reuse001"]).toBeDefined();
    expect(data.agents["codex:reuse001"].agent_type).toBe("codex");
  });

  test("ensureJoined should keep current subscriber identity when metadata is missing", async () => {
    const bus = new EventBus(testProjectRoot);
    await bus.init();

    process.env.UFOO_SUBSCRIBER_ID = "codex:keep777";
    const result = await bus.ensureJoined();
    const data = readAgents(testProjectRoot);

    expect(result).toBe("codex:keep777");
    expect(data.agents["codex:keep777"]).toBeDefined();
    expect(data.agents["codex:keep777"].agent_type).toBe("codex");
  });
});

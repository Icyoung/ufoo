const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/bus/utils", () => {
  const actual = jest.requireActual("../../../src/bus/utils");
  return {
    ...actual,
    getTtyProcessInfo: jest.fn((ttyPath) => {
      if (ttyPath === "/dev/ttys001") {
        return {
          alive: true,
          idle: false,
          hasAgent: true,
          shellPid: 1234,
          processes: [],
        };
      }
      return {
        alive: false,
        idle: false,
        hasAgent: false,
        shellPid: 0,
        processes: [],
      };
    }),
  };
});

const { BusStore } = require("../../../src/bus/store");
const { getUfooPaths } = require("../../../src/ufoo/paths");

describe("BusStore load recovery", () => {
  let projectRoot;
  let paths;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-store-test-"));
    paths = getUfooPaths(projectRoot);
    fs.mkdirSync(paths.busDir, { recursive: true });
    fs.mkdirSync(paths.agentDir, { recursive: true });
    fs.mkdirSync(paths.busQueuesDir, { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: "2026-02-12T00:00:00.000Z",
      agents: {
        "ufoo-agent": {
          agent_type: "codex",
          nickname: "ufoo-agent",
          status: "active",
        },
      },
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("does not recover ordinary agent entries from queue folders", () => {
    const codexQueue = path.join(paths.busQueuesDir, "codex_abc123");
    fs.mkdirSync(codexQueue, { recursive: true });
    fs.writeFileSync(path.join(codexQueue, "tty"), "/dev/ttys001");

    const claudeQueue = path.join(paths.busQueuesDir, "claude-code_def456");
    fs.mkdirSync(claudeQueue, { recursive: true });

    const store = new BusStore(projectRoot);
    const data = store.load();

    expect(data.agents["codex:abc123"]).toBeUndefined();
    expect(data.agents["claude-code:def456"]).toBeUndefined();
  });

  test("recovers reserved ufoo-agent entry and deactivates stale aliases", () => {
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
      schema_version: 1,
      created_at: "2026-02-12T00:00:00.000Z",
      agents: {
        "ufoo-agent:old1": {
          agent_type: "ufoo-agent",
          nickname: "ufoo-agent-1",
          status: "active",
          pid: 123,
        },
      },
    }, null, 2));

    const controllerQueue = path.join(paths.busQueuesDir, "ufoo-agent");
    fs.mkdirSync(controllerQueue, { recursive: true });

    const store = new BusStore(projectRoot);
    const data = store.load();

    expect(data.agents["ufoo-agent"]).toMatchObject({
      agent_type: "ufoo-agent",
      nickname: "ufoo-agent",
      status: "active",
    });
    expect(data.agents["ufoo-agent:old1"]).toMatchObject({
      status: "inactive",
    });
  });
});

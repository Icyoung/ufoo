const fs = require("fs");
const path = require("path");
jest.mock("child_process", () => ({
  spawn: jest.fn(() => {
    const { EventEmitter } = require("events");
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    process.nextTick(() => proc.emit("close", 0));
    return proc;
  }),
}));

const { spawn } = require("child_process");
const { resumeAgents } = require("../../../src/daemon/ops");
const { getUfooPaths } = require("../../../src/ufoo/paths");

describe("daemon resumeAgents", () => {
  const projectRoot = "/tmp/ufoo-daemon-resume-test";

  function writeConfig(config) {
    const configPath = path.join(projectRoot, ".ufoo", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  function writeAgents(agents) {
    const paths = getUfooPaths(projectRoot);
    fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
      created_at: new Date().toISOString(),
      agents,
      schema_version: 1,
    }, null, 2));
  }

  beforeEach(() => {
    if (fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(projectRoot, { recursive: true });
    spawn.mockClear();
  });

  afterEach(() => {
    if (fs.existsSync(projectRoot)) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("resumes recoverable target in tmux mode without mode reference errors", async () => {
    writeConfig({ launchMode: "tmux" });
    writeAgents({
      "codex:a1": {
        agent_type: "codex",
        nickname: "codex-4",
        status: "inactive",
        provider_session_id: "sess-1",
      },
    });

    const result = await resumeAgents(projectRoot, "codex-4");

    expect(result.ok).toBe(true);
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0]).toMatchObject({
      id: "codex:a1",
      nickname: "codex-4",
      agent: "codex",
      sessionId: "sess-1",
      reused: false,
    });
    expect(spawn).toHaveBeenCalledWith("tmux", expect.any(Array));
  });

  test("preserves stored nickname while resuming recoverable agent", async () => {
    writeConfig({ launchMode: "tmux" });
    writeAgents({
      "claude-code:b1": {
        agent_type: "claude-code",
        nickname: "neptune-reviewer",
        status: "inactive",
        provider_session_id: "sess-r1",
      },
    });

    const result = await resumeAgents(projectRoot, "neptune-reviewer");
    const agents = JSON.parse(fs.readFileSync(getUfooPaths(projectRoot).agentsFile, "utf8"));

    expect(result.ok).toBe(true);
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0]).toMatchObject({
      id: "claude-code:b1",
      nickname: "neptune-reviewer",
      reused: false,
    });
    expect(agents.agents["claude-code:b1"].nickname).toBe("neptune-reviewer");
  });
});

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
const { resumeAgents, getRecoverableAgents } = require("../../../src/runtime/daemon/ops");
const { getUfooPaths } = require("../../../src/coordination/state/paths");

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

  test("resumes recoverable target in internal mode with a fresh headless runner", async () => {
    writeConfig({ launchMode: "internal" });
    writeAgents({
      "codex:old1": {
        agent_type: "codex",
        nickname: "codex-1",
        status: "inactive",
        launch_mode: "internal",
        provider_session_id: "sess-i1",
      },
    });

    const result = await resumeAgents(projectRoot, "codex-1");
    const agents = JSON.parse(fs.readFileSync(getUfooPaths(projectRoot).agentsFile, "utf8"));

    expect(result.ok).toBe(true);
    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0]).toMatchObject({
      previous_id: "codex:old1",
      nickname: "codex-1",
      agent: "codex",
      sessionId: "sess-i1",
      reused: false,
    });
    expect(result.resumed[0].id).toMatch(/^codex:/);
    expect(result.resumed[0].id).not.toBe("codex:old1");
    expect(agents.agents["codex:old1"]).toBeUndefined();
    expect(agents.agents[result.resumed[0].id]).toMatchObject({
      nickname: "codex-1",
      provider_session_id: "sess-i1",
      launch_mode: "internal",
    });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [
        path.resolve(__dirname, "../../../bin/ufoo.js"),
        "agent-runner",
        "codex",
        "resume",
        "sess-i1",
      ],
      expect.objectContaining({
        cwd: projectRoot,
        env: expect.objectContaining({
          UFOO_NICKNAME: "codex-1",
          UFOO_SKIP_SESSION_RESOLVE: "1",
          UFOO_PROVIDER_SESSION_ID: "sess-i1",
          UFOO_LAUNCH_MODE: "internal",
        }),
      })
    );
  });

  test.each(["ucode"])("restores %s sessions with canonical ucode identity even when configuration is auto", async (type) => {
    writeConfig({ launchMode: "auto" });
    writeAgents({ [`${type}:old`]: {
      agent_type: type, nickname: "coder", status: "inactive", launch_mode: "internal", provider_session_id: "ucode-existing-session",
    } });
    const result = await resumeAgents(projectRoot, `${type}:old`, null, { internalOnly: true });
    expect(result.resumed).toHaveLength(1);
    const restored = result.resumed[0];
    expect(restored).toMatchObject({ previous_id: `${type}:old`, agent: "ucode", sessionId: "ucode-existing-session" });
    expect(restored.id).toMatch(/^ucode:[0-9a-f]{8}$/);
    expect(spawn).toHaveBeenCalledWith(process.execPath,
      [path.resolve(__dirname, "../../../bin/ufoo.js"), "agent-runner", "ucode", "--session-id", "ucode-existing-session"],
      expect.objectContaining({ env: expect.objectContaining({ UFOO_PROVIDER_SESSION_ID: "ucode-existing-session", UFOO_LAUNCH_MODE: "internal" }) }));
    const saved = JSON.parse(fs.readFileSync(getUfooPaths(projectRoot).agentsFile, "utf8"));
    expect(saved.agents[restored.id].agent_type).toBe("ucode");
  });

  test.each(["ufoo-code", "ufoo", "kimi", "agy", "grok"])("internal recovery refuses retired or unsupported type %s", async (type) => {
    writeConfig({ launchMode: "auto" });
    writeAgents({ [`${type}:old`]: { agent_type: type, status: "inactive", launch_mode: "internal", provider_session_id: "old-session" } });
    const result = await resumeAgents(projectRoot, `${type}:old`, null, { internalOnly: true });
    expect(result.resumed).toHaveLength(0);
    expect(spawn).not.toHaveBeenCalled();
  });

  test("group recovery uses persisted membership, restores only that group and updates member identities", async () => {
    writeConfig({ launchMode: "auto" });
    const inactive = { status: "inactive", launch_mode: "internal" };
    writeAgents({
      "ucode:solo": { ...inactive, agent_type: "ucode", nickname: "solo", provider_session_id: "solo-session" },
      "ucode:coder": { ...inactive, agent_type: "ucode", nickname: "coder", provider_session_id: "coder-session" },
      "codex:review": { ...inactive, agent_type: "codex", nickname: "review", provider_session_id: "review-session" },
      "claude-code:live": { agent_type: "claude-code", nickname: "live", status: "active", launch_mode: "internal", provider_session_id: "live-session" },
      "codex:outside": { ...inactive, agent_type: "codex", nickname: "outside", launch_mode: "terminal", provider_session_id: "outside-session" },
    });
    const file = path.join(getUfooPaths(projectRoot).groupsDir, "dev-team.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ group_id: "dev-team", template_alias: "dev-basic", status: "stopped", members: [
      { id: "coder", subscriber_id: "ucode:coder", bootstrapped_subscriber_id: "ucode:coder", status: "stopped" },
      { id: "review", subscriber_id: "codex:review", status: "stopped" },
      { id: "live", subscriber_id: "claude-code:live", status: "active" },
    ] }));
    const list = getRecoverableAgents(projectRoot, "", { internalOnly: true });
    expect(list.recoverable.map((item) => item.id)).toEqual(["ucode:solo", "ucode:coder", "codex:review"]);
    expect(list.groups).toHaveLength(1);
    expect(list.groups[0].members.map((item) => item.id)).toEqual(["ucode:coder", "codex:review"]);
    const result = await resumeAgents(projectRoot, "group:dev-team", null, { internalOnly: true });
    expect(result.resumed).toHaveLength(2);
    expect(result.resumed.map((item) => item.group_id)).toEqual(["dev-team", "dev-team"]);
    expect(result.skipped).toContainEqual({ id: "claude-code:live", reason: "already active" });
    const group = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(group.status).toBe("active");
    expect(group.members.slice(0, 2).map((item) => item.subscriber_id)).toEqual(result.resumed.map((item) => item.id));
    expect(group.members[0].bootstrapped_subscriber_id).toBe(result.resumed[0].id);
    const saved = JSON.parse(fs.readFileSync(getUfooPaths(projectRoot).agentsFile, "utf8"));
    expect(saved.agents["ucode:solo"].status).toBe("inactive");
    expect(saved.agents["codex:outside"].status).toBe("inactive");
    expect(saved.agents[result.resumed[0].id]).toMatchObject({ agent_type: "ucode", group_id: "dev-team", group_member_id: "coder" });
    const again = await resumeAgents(projectRoot, "group:dev-team", null, { internalOnly: true });
    expect(again.resumed).toEqual([]);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

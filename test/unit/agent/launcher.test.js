const fs = require("fs");
const os = require("os");
const path = require("path");

const AgentLauncher = require("../../../src/agent/launcher");

// --- _sanitizeNickname ---

describe("_sanitizeNickname", () => {
  const sanitize = AgentLauncher._sanitizeNickname;

  it("passes clean nicknames through", () => {
    expect(sanitize("builder")).toBe("builder");
    expect(sanitize("qa-driver")).toBe("qa-driver");
    expect(sanitize("agent_01")).toBe("agent_01");
  });

  it("strips backticks", () => {
    expect(sanitize("`whoami`")).toBe("whoami");
  });

  it("strips $() subshell syntax", () => {
    expect(sanitize("$(rm -rf /)")).toBe("rm-rf");
    expect(sanitize("$(curl evil.com)")).toBe("curlevilcom");
  });

  it("strips quotes and spaces", () => {
    expect(sanitize('" hello world "')).toBe("helloworld");
    expect(sanitize("it's")).toBe("its");
  });

  it("strips control characters", () => {
    expect(sanitize("nick\x00name")).toBe("nickname");
    expect(sanitize("nick\x1bname")).toBe("nickname");
    expect(sanitize("nick\x7fname")).toBe("nickname");
  });

  it("returns empty string for fully-malicious input", () => {
    expect(sanitize("$()`'\"\\ ")).toBe("");
  });

  it("preserves only allowed chars from mixed input", () => {
    expect(sanitize("my agent!@#$%^&*()")).toBe("myagent");
    expect(sanitize("pipe|semi;amp&")).toBe("pipesemiamp");
    expect(sanitize("new\nline\rtab\there")).toBe("newlinetabhere");
  });
});

// --- _findPreviousSession with tty_shell_pid guard ---

describe("_findPreviousSession tty_shell_pid guard", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-test-"));
    const agentDir = path.join(tmpDir, ".ufoo", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAgents(agents) {
    const agentsFile = path.join(tmpDir, ".ufoo", "agent", "all-agents.json");
    fs.writeFileSync(agentsFile, JSON.stringify({ agents }));
  }

  it("skips session when tty_shell_pid is dead (tty recycled)", () => {
    writeAgents({
      "claude-code:old123": {
        agent_type: "claude-code",
        tty: "/dev/ttys999",
        pid: null,
        tty_shell_pid: 999999999, // non-existent PID
        nickname: "builder",
      },
    });

    const result = AgentLauncher._findPreviousSession(
      tmpDir,
      "claude-code",
      "/dev/ttys999",
      null,
    );
    expect(result).toBeNull();
  });

  it("reuses session when tty_shell_pid is alive", () => {
    writeAgents({
      "claude-code:alive456": {
        agent_type: "claude-code",
        tty: "/dev/ttys999",
        pid: null,
        tty_shell_pid: process.pid, // current process — alive
        nickname: "builder",
      },
    });

    const result = AgentLauncher._findPreviousSession(
      tmpDir,
      "claude-code",
      "/dev/ttys999",
      null,
    );
    expect(result).toEqual({
      sessionId: "alive456",
      subscriberId: "claude-code:alive456",
      nickname: "builder",
      providerSessionId: "",
    });
  });

  it("reuses session when tty_shell_pid is absent (legacy entry)", () => {
    writeAgents({
      "claude-code:legacy789": {
        agent_type: "claude-code",
        tty: "/dev/ttys999",
        pid: null,
        nickname: "old-agent",
      },
    });

    const result = AgentLauncher._findPreviousSession(
      tmpDir,
      "claude-code",
      "/dev/ttys999",
      null,
    );
    expect(result).toEqual({
      sessionId: "legacy789",
      subscriberId: "claude-code:legacy789",
      nickname: "old-agent",
      providerSessionId: "",
    });
  });
});

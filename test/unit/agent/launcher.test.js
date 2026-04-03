const fs = require("fs");
const os = require("os");
const path = require("path");
const EventEmitter = require("events");

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

describe("_notifyDaemonAgentReady", () => {
  const net = require("net");
  const originalCreateConnection = net.createConnection;

  afterEach(() => {
    net.createConnection = originalCreateConnection;
    delete process.env.UFOO_DEBUG;
  });

  it("writes agent_ready payload when pid is valid", async () => {
    const client = new EventEmitter();
    client.write = jest.fn();
    client.end = jest.fn();
    net.createConnection = jest.fn((_sockPath, onConnect) => {
      if (typeof onConnect === "function") process.nextTick(onConnect);
      return client;
    });

    const ok = await AgentLauncher._notifyDaemonAgentReady(
      "/tmp/ufoo-daemon.sock",
      "claude-code:test123",
      4321,
    );

    expect(ok).toBe(true);
    expect(net.createConnection).toHaveBeenCalledWith("/tmp/ufoo-daemon.sock", expect.any(Function));
    expect(client.write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(client.write.mock.calls[0][0])).toEqual({
      type: "agent_ready",
      subscriberId: "claude-code:test123",
      agentPid: 4321,
    });
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  it("skips daemon notification for invalid pid", async () => {
    const netSpy = jest.spyOn(require("net"), "createConnection");

    const ok = await AgentLauncher._notifyDaemonAgentReady(
      "/tmp/ufoo-daemon.sock",
      "claude-code:test123",
      0,
    );

    expect(ok).toBe(false);
    expect(netSpy).not.toHaveBeenCalled();
    netSpy.mockRestore();
  });
});

describe("_injectPtyCommand", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("submits startup bootstrap directly for claude", async () => {
    const wrapper = {
      write: jest.fn(),
      logger: { write: jest.fn() },
    };

    const promise = AgentLauncher._injectPtyCommand(wrapper, "claude-code", "bootstrap text", "startup-bootstrap");
    jest.runAllTimers();
    await promise;

    expect(wrapper.write).toHaveBeenNthCalledWith(1, "bootstrap text");
    expect(wrapper.write).toHaveBeenNthCalledWith(2, "\r");
    expect(wrapper.logger.write).toHaveBeenCalledWith(expect.stringContaining("\"source\":\"startup-bootstrap\""));
  });

  it("uses escape-then-enter submission for codex", async () => {
    const wrapper = {
      write: jest.fn(),
      logger: { write: jest.fn() },
    };

    const promise = AgentLauncher._injectPtyCommand(wrapper, "codex", "bootstrap text");
    jest.advanceTimersByTime(200);
    await Promise.resolve();
    jest.advanceTimersByTime(100);
    await promise;

    expect(wrapper.write).toHaveBeenNthCalledWith(1, "bootstrap text");
    expect(wrapper.write).toHaveBeenNthCalledWith(2, "\u001b");
    expect(wrapper.write).toHaveBeenNthCalledWith(3, "\r");
  });
});

describe("_spawnDirect host notification", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.UFOO_HOST_SESSION_ID;
  });

  it("notifies daemon when host launches without PTY", async () => {
    const child = new EventEmitter();
    child.pid = 2468;
    child.on = child.on.bind(child);
    const client = new EventEmitter();
    client.write = jest.fn();
    client.end = jest.fn();
    const spawnMock = jest.fn(() => child);
    const createConnectionMock = jest.fn((_sockPath, onConnect) => {
      if (typeof onConnect === "function") process.nextTick(onConnect);
      return client;
    });
    let TestAgentLauncher;

    jest.isolateModules(() => {
      jest.doMock("child_process", () => ({
        spawn: spawnMock,
        spawnSync: jest.fn(),
      }));
      jest.doMock("net", () => ({
        createConnection: createConnectionMock,
      }));
      TestAgentLauncher = require("../../../src/agent/launcher");
    });

    process.env.UFOO_HOST_SESSION_ID = "HS-1";
    const launcher = new TestAgentLauncher("codex", "ucodex");
    launcher.cwd = "/tmp/ufoo-host-project";
    launcher._spawnDirect(["--help"], "codex:test123");

    await new Promise((resolve) => setImmediate(resolve));

    expect(spawnMock).toHaveBeenCalledWith("ucodex", ["--help"], expect.objectContaining({
      cwd: "/tmp/ufoo-host-project",
      stdio: "inherit",
    }));
    expect(createConnectionMock).toHaveBeenCalledWith(
      expect.stringContaining(path.join(".ufoo", "run", "ufoo.sock")),
      expect.any(Function),
    );
    expect(JSON.parse(client.write.mock.calls[0][0])).toEqual({
      type: "agent_ready",
      subscriberId: "codex:test123",
      agentPid: 2468,
    });
  });
});

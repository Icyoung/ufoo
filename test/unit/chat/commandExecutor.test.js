const os = require("os");
const { createCommandExecutor } = require("../../../src/chat/commandExecutor");

function createHarness(overrides = {}) {
  const logs = [];
  const logMessage = jest.fn((type, text) => {
    logs.push({ type, text });
  });

  const context = {
    doctor: jest.fn().mockResolvedValue(undefined),
    listDecisions: jest.fn().mockResolvedValue(undefined),
    status: jest.fn().mockResolvedValue(undefined),
  };

  const bus = {
    rename: jest.fn().mockResolvedValue(undefined),
    ensureBus: jest.fn(),
    loadBusData: jest.fn(),
    busData: { agents: {} },
  };

  const skills = {
    list: jest.fn(() => []),
    install: jest.fn().mockResolvedValue(undefined),
  };

  const doctor = {
    run: jest.fn(() => true),
  };

  const defaults = {
    projectRoot: "/tmp/ufoo",
    parseCommand: jest.fn(() => null),
    escapeBlessed: jest.fn((value) => `ESC(${value})`),
    logMessage,
    renderScreen: jest.fn(),
    getActiveAgents: jest.fn(() => []),
    getActiveAgentMetaMap: jest.fn(() => new Map()),
    getAgentLabel: jest.fn((id) => id),
    isDaemonRunning: jest.fn(() => false),
    startDaemon: jest.fn(),
    stopDaemon: jest.fn(),
    restartDaemon: jest.fn().mockResolvedValue(undefined),
    send: jest.fn(),
    requestStatus: jest.fn(),
    createBus: jest.fn(() => bus),
    createInit: jest.fn(() => ({ init: jest.fn().mockResolvedValue(undefined) })),
    createDoctor: jest.fn(() => doctor),
    createContext: jest.fn(() => context),
    createSkills: jest.fn(() => skills),
    activateAgent: jest.fn().mockResolvedValue(undefined),
    loadConfig: jest.fn(() => ({})),
    saveConfig: jest.fn(),
    loadUcodeConfig: jest.fn(() => ({
      ucodeProvider: "",
      ucodeModel: "",
      ucodeBaseUrl: "",
      ucodeApiKey: "",
    })),
    saveUcodeConfig: jest.fn(),
    createCronTask: jest.fn((payload) => ({ id: "c1", ...payload, label: "codex:1:run:10s", summary: "c1 codex:1:run:10s" })),
    listCronTasks: jest.fn(() => []),
    stopCronTask: jest.fn(() => false),
    runGroupCore: jest.fn().mockResolvedValue(undefined),
    listProjects: jest.fn(() => []),
    getCurrentProject: jest.fn(() => ({ project_root: "/tmp/ufoo", project_name: "ufoo" })),
    switchProject: jest.fn(async () => ({ ok: true, project_root: "/tmp/other" })),
    resolveTerminalApp: jest.fn(() => ""),
    sleep: jest.fn(() => Promise.resolve()),
    schedule: jest.fn((fn) => fn()),
  };

  const options = { ...defaults, ...overrides };
  const executor = createCommandExecutor(options);
  return { executor, options, logs, bus, context, skills, doctor };
}

describe("chat commandExecutor", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.UFOO_HOST_INJECT_SOCK;
    delete process.env.HORIZON_INJECT_SOCK;
    delete process.env.UFOO_HOST_DAEMON_SOCK;
    delete process.env.UFOO_HOST_NAME;
    delete process.env.UFOO_HOST_SESSION_ID;
    delete process.env.HORIZON_SESSION_ID;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("requires projectRoot", () => {
    expect(() => createCommandExecutor({ projectRoot: "" })).toThrow(/requires projectRoot/);
  });

  test("executeCommand returns false when parser does not match", async () => {
    const { executor } = createHarness();
    await expect(executor.executeCommand("hello")).resolves.toBe(false);
  });

  test("executeCommand logs unknown command", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "nope", args: [] })),
    });

    await expect(executor.executeCommand("/nope")).resolves.toBe(true);
    expect(logs.some((entry) => entry.text.includes("Unknown command: /nope"))).toBe(true);
  });

  test("handleStatusCommand logs active agents and daemon status", async () => {
    const { executor, options, logs } = createHarness({
      getActiveAgents: jest.fn(() => ["codex:1"]),
      getActiveAgentMetaMap: jest.fn(() => new Map([["codex:1", { launch_mode: "internal" }]])),
      getAgentLabel: jest.fn(() => "alpha"),
      isDaemonRunning: jest.fn(() => true),
    });

    await executor.handleStatusCommand();

    expect(options.getAgentLabel).toHaveBeenCalledWith("codex:1");
    expect(logs.some((entry) => entry.text.includes("1 active agent"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("alpha") && entry.text.includes("internal"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("Daemon is running"))).toBe(true);
  });

  test("handleDaemonCommand start path invokes start and checks status", async () => {
    const isDaemonRunning = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const { executor, options, logs } = createHarness({ isDaemonRunning });

    await executor.handleDaemonCommand(["start"]);

    expect(options.startDaemon).toHaveBeenCalledWith("/tmp/ufoo");
    expect(options.sleep).toHaveBeenCalledWith(1000);
    expect(logs.some((entry) => entry.text.includes("Daemon started"))).toBe(true);
  });

  test("handleBusCommand send validates args and sends message", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleBusCommand(["send", "only-target"]);
    expect(logs.some((entry) => entry.text.includes("Usage: /bus send"))).toBe(true);

    await executor.handleBusCommand(["send", "codex:1", "hello", "world"]);
    expect(options.send).toHaveBeenCalledWith({
      type: "bus_send",
      target: "codex:1",
      message: "hello world",
      injection_mode: "immediate",
      source: "chat-command",
    });
  });

  test("handleBusCommand send supports queued flag", async () => {
    const { executor, options } = createHarness();

    await executor.handleBusCommand(["send", "--queued", "codex:1", "follow", "up"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "bus_send",
      target: "codex:1",
      message: "follow up",
      injection_mode: "queued",
      source: "chat-command",
    });
  });

  test("handleBusCommand send keeps flag-like tokens inside message body", async () => {
    const { executor, options } = createHarness();

    await executor.handleBusCommand(["send", "codex:1", "please", "run", "--queued", "tests"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "bus_send",
      target: "codex:1",
      message: "please run --queued tests",
      injection_mode: "immediate",
      source: "chat-command",
    });
  });

  test("handleBusCommand activate delegates to activateAgent", async () => {
    const { executor, options } = createHarness();
    await executor.handleBusCommand(["activate", "codex:1"]);
    expect(options.activateAgent).toHaveBeenCalledWith("codex:1");
  });

  test("handleCtxCommand routes to decisions", async () => {
    const { executor, context, options } = createHarness();

    await executor.handleCtxCommand(["decisions"]);

    expect(context.listDecisions).toHaveBeenCalled();
    expect(context.doctor).not.toHaveBeenCalled();
    expect(options.renderScreen).toHaveBeenCalled();
  });

  test("handleLaunchCommand parses nickname/count and schedules refresh", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleLaunchCommand(["codex", "nickname=neo", "count=1"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "codex",
      count: 1,
      nickname: "neo",
      prompt_profile: "",
      launch_scope: "inplace",
    });
    expect(options.schedule).toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("Launching codex"))).toBe(false);
  });

  test("handleLaunchCommand reports send failure without scheduling refresh", async () => {
    const { executor, options, logs } = createHarness({
      send: jest.fn(() => {
        throw new Error("socket closed");
      }),
    });

    await executor.handleLaunchCommand(["codex"]);

    expect(options.schedule).not.toHaveBeenCalled();
    expect(options.requestStatus).not.toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("Launch failed: ESC(socket closed)"))).toBe(true);
  });

  test("handleLaunchCommand rejects nickname with count > 1", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleLaunchCommand(["codex", "nickname=neo", "count=2"]);

    expect(options.send).not.toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("nickname requires count=1"))).toBe(true);
  });

  test("handleLaunchCommand accepts ucode alias and sends ufoo launch", async () => {
    const { executor, options } = createHarness();

    await executor.handleLaunchCommand(["ucode", "nickname=core"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "ufoo",
      count: 1,
      nickname: "core",
      prompt_profile: "",
      launch_scope: "inplace",
    });
  });

  test("handleLaunchCommand supports separate window scope", async () => {
    const { executor, options } = createHarness();

    await executor.handleLaunchCommand(["codex", "scope=window"]);
    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "codex",
      count: 1,
      nickname: "",
      prompt_profile: "",
      launch_scope: "window",
    });

    options.send.mockClear();
    await executor.handleLaunchCommand(["codex", "window"]);
    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "codex",
      count: 1,
      nickname: "",
      prompt_profile: "",
      launch_scope: "window",
    });
  });

  test("handleLaunchCommand forwards terminal app preference when available", async () => {
    const { executor, options } = createHarness({
      resolveTerminalApp: jest.fn(() => "terminal"),
    });

    await executor.handleLaunchCommand(["claude"]);
    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "claude",
      count: 1,
      nickname: "",
      prompt_profile: "",
      launch_scope: "inplace",
      terminal_app: "terminal",
    });
  });

  test("handleLaunchCommand forwards host launch context from environment", async () => {
    const originalDaemonSock = process.env.UFOO_HOST_DAEMON_SOCK;
    const originalSessionId = process.env.UFOO_HOST_SESSION_ID;
    const originalInjectSock = process.env.UFOO_HOST_INJECT_SOCK;
    const originalHostName = process.env.UFOO_HOST_NAME;
    process.env.UFOO_HOST_DAEMON_SOCK = "/tmp/horizon-daemon.sock";
    process.env.UFOO_HOST_SESSION_ID = "HS-SRC";
    process.env.UFOO_HOST_INJECT_SOCK = "/tmp/horizon-current.sock";
    process.env.UFOO_HOST_NAME = "horizon";

    try {
      const { executor, options } = createHarness();

      await executor.handleLaunchCommand(["codex"]);
      expect(options.send).toHaveBeenCalledWith({
        type: "launch_agent",
        agent: "codex",
        count: 1,
        nickname: "",
        prompt_profile: "",
        launch_scope: "inplace",
        host_inject_sock: "/tmp/horizon-current.sock",
        host_daemon_sock: "/tmp/horizon-daemon.sock",
        host_name: "horizon",
        host_session_id: "HS-SRC",
      });
    } finally {
      if (originalDaemonSock === undefined) delete process.env.UFOO_HOST_DAEMON_SOCK;
      else process.env.UFOO_HOST_DAEMON_SOCK = originalDaemonSock;
      if (originalSessionId === undefined) delete process.env.UFOO_HOST_SESSION_ID;
      else process.env.UFOO_HOST_SESSION_ID = originalSessionId;
      if (originalInjectSock === undefined) delete process.env.UFOO_HOST_INJECT_SOCK;
      else process.env.UFOO_HOST_INJECT_SOCK = originalInjectSock;
      if (originalHostName === undefined) delete process.env.UFOO_HOST_NAME;
      else process.env.UFOO_HOST_NAME = originalHostName;
    }
  });

  test("handleLaunchCommand rejects invalid scope", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleLaunchCommand(["codex", "scope=weird"]);
    expect(options.send).not.toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("scope must be inplace|window"))).toBe(true);
  });

  test("handleLaunchCommand rejects ufoo alias input", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleLaunchCommand(["ufoo", "nickname=core2"]);

    expect(options.send).not.toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("Unknown agent type. Use: claude, codex, or ucode"))).toBe(true);
  });

  test("handleLaunchCommand forwards prompt profile", async () => {
    const { executor, options } = createHarness();

    await executor.handleLaunchCommand(["codex", "nickname=neo", "profile=design-critic"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "codex",
      count: 1,
      nickname: "neo",
      prompt_profile: "design-critic",
      launch_scope: "inplace",
    });
  });

  test("handleLaunchCommand rejects profile with count > 1", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleLaunchCommand(["codex", "profile=design-critic", "count=2"]);

    expect(options.send).not.toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("profile requires count=1"))).toBe(true);
  });

  test("handleRoleCommand sends assign_role request", async () => {
    const { executor, options } = createHarness();

    await executor.handleRoleCommand(["designer", "design-critic"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "assign_role",
      target: "designer",
      prompt_profile: "design-critic",
    });
    expect(options.schedule).toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
  });

  test("handleRoleCommand accepts explicit assign subcommand", async () => {
    const { executor, options } = createHarness();

    await executor.handleRoleCommand(["assign", "designer", "design-critic"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "assign_role",
      target: "designer",
      prompt_profile: "design-critic",
    });
  });

  test("handleRoleCommand list shows available prompt profiles", async () => {
    const { executor, logs } = createHarness();

    await executor.handleRoleCommand(["list"]);

    const header = logs.find((entry) => entry.text.includes("Available prompt profiles"));
    expect(header).toBeTruthy();
    const ids = logs.filter((entry) => entry.text.includes("implementation-lead"));
    expect(ids.length).toBeGreaterThan(0);
  });

  test("handleRoleCommand ls is alias for list", async () => {
    const { executor, logs } = createHarness();

    await executor.handleRoleCommand(["ls"]);

    const header = logs.find((entry) => entry.text.includes("Available prompt profiles"));
    expect(header).toBeTruthy();
  });

  test("handleRoleCommand shows usage when no args", async () => {
    const { executor, logs } = createHarness();

    await executor.handleRoleCommand([]);

    const usage = logs.find((entry) => entry.text.includes("Usage:"));
    expect(usage).toBeTruthy();
    const listHint = logs.find((entry) => entry.text.includes("/role list"));
    expect(listHint).toBeTruthy();
  });

  test("handleSoloCommand list shows available roles", async () => {
    const { executor, logs } = createHarness();

    await executor.handleSoloCommand(["list"]);

    const header = logs.find((entry) => entry.text.includes("Available solo roles"));
    expect(header).toBeTruthy();
    expect(logs.some((entry) => entry.text.includes("implementation-lead"))).toBe(true);
  });

  test("handleSoloCommand run sends launch_agent with prompt profile", async () => {
    const { executor, options } = createHarness({
      loadConfig: jest.fn(() => ({ agentProvider: "claude-cli" })),
    });

    await executor.handleSoloCommand(["run", "design-critic", "nickname=designer"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "claude",
      count: 1,
      nickname: "designer",
      prompt_profile: "design-critic",
      launch_scope: "inplace",
    });
    expect(options.schedule).toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
  });

  test("handleSoloCommand run accepts explicit agent override", async () => {
    const { executor, options } = createHarness({
      loadConfig: jest.fn(() => ({ agentProvider: "claude-cli" })),
    });

    await executor.handleSoloCommand(["run", "design-critic", "agent=ucode", "scope=window"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "ufoo",
      count: 1,
      nickname: "",
      prompt_profile: "design-critic",
      launch_scope: "window",
    });
  });

  test("handleResumeCommand supports list subcommand", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleResumeCommand(["list", "codex-3"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "list_recoverable_agents",
      target: "codex-3",
    });
    expect(options.schedule).toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("Listing recoverable agents (codex-3)"))).toBe(true);
  });

  test("handleCronCommand creates cron task with interval/targets/prompt", async () => {
    const { executor, options, logs } = createHarness({
      createCronTask: jest.fn((payload) => ({ id: "c7", ...payload })),
    });

    await executor.handleCronCommand([
      "start",
      "every=10s",
      "target=codex:1,claude:2",
      "prompt=run smoke",
    ]);

    expect(options.createCronTask).toHaveBeenCalledWith({
      intervalMs: 10000,
      targets: ["codex:1", "claude:2"],
      prompt: "run smoke",
    });
    expect(logs.some((entry) => entry.text.includes("Cron started c7: every 10s"))).toBe(true);
  });

  test("handleCronCommand list and stop", async () => {
    const { executor, options, logs } = createHarness({
      listCronTasks: jest.fn(() => [
        { id: "c1", summary: "c1@10s->codex:1: run smoke" },
      ]),
      stopCronTask: jest.fn((id) => id === "c1"),
    });

    await executor.handleCronCommand(["list"]);
    await executor.handleCronCommand(["stop", "c1"]);

    expect(options.listCronTasks).toHaveBeenCalled();
    expect(options.stopCronTask).toHaveBeenCalledWith("c1");
    expect(logs.some((entry) => entry.text.includes("c1@10s->codex:1: run smoke"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("Stopped cron task c1"))).toBe(true);
  });

  test("executeCommand routes /cron", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({
        command: "cron",
        args: ["start", "every=5s", "target=codex:1", "prompt=ping"],
      })),
      createCronTask: jest.fn(() => ({ id: "c9", intervalMs: 5000, targets: ["codex:1"], prompt: "ping" })),
    });

    await expect(executor.executeCommand("/cron start every=5s target=codex:1 prompt=ping")).resolves.toBe(true);
    expect(options.createCronTask).toHaveBeenCalled();
  });

  test("handleCronCommand sends one-time request to daemon cron controller", async () => {
    const requestCron = jest.fn();
    const { executor, options } = createHarness({
      requestCron,
    });

    await executor.handleCronCommand([
      "start",
      "at=2030-02-23 22:15",
      "target=codex:1",
      "prompt=run once",
    ]);

    expect(requestCron).toHaveBeenCalledWith({
      operation: "start",
      once_at_ms: Date.parse("2030-02-23T22:15:00"),
      targets: ["codex:1"],
      prompt: "run once",
    });
    expect(options.schedule).toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
  });

  test("handleCronCommand forwards explicit title", async () => {
    const requestCron = jest.fn();
    const { executor } = createHarness({
      requestCron,
    });

    await executor.handleCronCommand([
      "start",
      "every=30m",
      "target=codex:1",
      "title=Nightly Smoke",
      "prompt=run nightly smoke suite",
    ]);

    expect(requestCron).toHaveBeenCalledWith({
      operation: "start",
      interval_ms: 1800000,
      targets: ["codex:1"],
      title: "Nightly Smoke",
      prompt: "run nightly smoke suite",
    });
  });

  test("handleGroupCommand run sends launch_group request", async () => {
    const previousEnv = {
      UFOO_HOST_INJECT_SOCK: process.env.UFOO_HOST_INJECT_SOCK,
      UFOO_HOST_DAEMON_SOCK: process.env.UFOO_HOST_DAEMON_SOCK,
      UFOO_HOST_NAME: process.env.UFOO_HOST_NAME,
      UFOO_HOST_SESSION_ID: process.env.UFOO_HOST_SESSION_ID,
    };
    process.env.UFOO_HOST_INJECT_SOCK = "/tmp/host-inject.sock";
    process.env.UFOO_HOST_DAEMON_SOCK = "/tmp/host-daemon.sock";
    process.env.UFOO_HOST_NAME = "horizon";
    process.env.UFOO_HOST_SESSION_ID = "HS123";
    try {
      const { executor, options } = createHarness();

      await executor.handleGroupCommand(["run", "dev-basic", "instance=team-a", "dry_run=true"]);

      expect(options.send).toHaveBeenCalledWith({
        type: "launch_group",
        alias: "dev-basic",
        instance: "team-a",
        dry_run: true,
        host_inject_sock: "/tmp/host-inject.sock",
        host_daemon_sock: "/tmp/host-daemon.sock",
        host_name: "horizon",
        host_session_id: "HS123",
      });
      expect(options.schedule).toHaveBeenCalled();
      expect(options.requestStatus).toHaveBeenCalled();
    } finally {
      process.env.UFOO_HOST_INJECT_SOCK = previousEnv.UFOO_HOST_INJECT_SOCK;
      process.env.UFOO_HOST_DAEMON_SOCK = previousEnv.UFOO_HOST_DAEMON_SOCK;
      process.env.UFOO_HOST_NAME = previousEnv.UFOO_HOST_NAME;
      process.env.UFOO_HOST_SESSION_ID = previousEnv.UFOO_HOST_SESSION_ID;
    }
  });

  test("handleGroupCommand status/stop/validate/diagram send daemon requests", async () => {
    const { executor, options } = createHarness();

    await executor.handleGroupCommand(["status", "dev-basic-abc"]);
    await executor.handleGroupCommand(["stop", "dev-basic-abc"]);
    await executor.handleGroupCommand(["template", "validate", "dev-basic"]);
    await executor.handleGroupCommand(["diagram", "dev-basic", "format=mermaid"]);

    expect(options.send).toHaveBeenNthCalledWith(1, {
      type: "group_status",
      group_id: "dev-basic-abc",
    });
    expect(options.send).toHaveBeenNthCalledWith(2, {
      type: "stop_group",
      group_id: "dev-basic-abc",
    });
    expect(options.send).toHaveBeenNthCalledWith(3, {
      type: "group_template_validate",
      target: "dev-basic",
      alias: "dev-basic",
      path: "dev-basic",
    });
    expect(options.send).toHaveBeenNthCalledWith(4, {
      type: "group_diagram",
      alias: "dev-basic",
      group_id: "dev-basic",
      format: "mermaid",
    });
  });

  test("handleGroupCommand diagram defaults to current runtime group", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleGroupCommand(["diagram"]);

    expect(logs.length).toBe(0);
    expect(options.send).toHaveBeenCalledWith({
      type: "group_diagram",
      alias: "current",
      group_id: "current",
      format: "ascii",
    });
  });

  test("handleGroupCommand uses group core helper for template listing", async () => {
    const runGroupCore = jest.fn(async (_sub, _args, runtime) => {
      runtime.write("line one");
      runtime.write("line two");
    });
    const { executor, options, logs } = createHarness({ runGroupCore });

    await executor.handleGroupCommand(["templates"]);

    expect(options.runGroupCore).toHaveBeenCalledWith(
      "templates",
      ["list"],
      expect.objectContaining({
        cwd: "/tmp/ufoo",
        write: expect.any(Function),
      })
    );
    expect(logs.some((entry) => entry.text.includes("ESC(line one)"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("ESC(line two)"))).toBe(true);
  });

  test("executeCommand routes /group", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "group", args: ["status", "g1"] })),
    });

    await expect(executor.executeCommand("/group status g1")).resolves.toBe(true);
    expect(options.send).toHaveBeenCalledWith({
      type: "group_status",
      group_id: "g1",
    });
  });

  test("handleProjectCommand list/current/switch", async () => {
    const { executor, options, logs } = createHarness({
      listProjects: jest.fn(() => [
        { project_root: "/tmp/ufoo", project_name: "ufoo", status: "running" },
        { project_root: "/tmp/other", project_name: "other", status: "stale" },
      ]),
      getCurrentProject: jest.fn(() => ({ project_root: "/tmp/ufoo", project_name: "ufoo" })),
      switchProject: jest.fn(async () => ({ ok: true, project_root: "/tmp/other" })),
    });

    await executor.handleProjectCommand(["list"]);
    await executor.handleProjectCommand(["current"]);
    await executor.handleProjectCommand(["switch", "2"]);

    expect(options.listProjects).toHaveBeenCalled();
    expect(options.getCurrentProject).toHaveBeenCalled();
    expect(options.switchProject).toHaveBeenCalledWith({ target: "2" });
    expect(logs.some((entry) => entry.text.includes("Projects:"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("Current:"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("Switched project:"))).toBe(true);
  });

  test("handleProjectCommand list hides global controller row in global mode", async () => {
    const home = os.homedir();
    const { executor, logs } = createHarness({
      globalMode: true,
      listProjects: jest.fn(() => [
        { project_root: home, project_name: "home", status: "running" },
        { project_root: "/tmp/other", project_name: "other", status: "running" },
      ]),
      getCurrentProject: jest.fn(() => ({ project_root: home, project_name: "global-controller" })),
    });

    await executor.handleProjectCommand(["list"]);

    expect(logs.some((entry) => entry.text.includes("/tmp/other"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes(home))).toBe(false);
  });

  test("handleProjectCommand current reports global controller in global mode", async () => {
    const { executor, logs } = createHarness({
      globalMode: true,
      getCurrentProject: jest.fn(() => ({ project_root: os.homedir(), project_name: "global-controller" })),
    });

    await executor.handleProjectCommand(["current"]);

    expect(logs.some((entry) => entry.text.includes("global controller"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes(".ufoo"))).toBe(true);
  });

  test("handleProjectCommand switch joins spaced path arguments", async () => {
    const { executor, options } = createHarness();

    await executor.handleProjectCommand(["switch", "/tmp/with", "space"]);

    expect(options.switchProject).toHaveBeenCalledWith({ target: "/tmp/with space" });
  });

  test("handleOpenCommand requires global mode", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleOpenCommand(["/tmp/project"]);

    expect(options.switchProject).not.toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("/open is only available in global mode"))).toBe(true);
  });

  test("handleOpenCommand opens target path in global mode", async () => {
    const { executor, options, logs } = createHarness({
      globalMode: true,
      switchProject: jest.fn(async () => ({ ok: true, project_root: "/tmp/project with space" })),
    });

    await executor.handleOpenCommand(["/tmp/project", "with", "space"]);

    expect(options.switchProject).toHaveBeenCalledWith({ target: "/tmp/project with space" });
    expect(logs.some((entry) => entry.text.includes("Opened project:"))).toBe(true);
  });

  test("executeCommand routes /project", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "project", args: ["switch", "1"] })),
      switchProject: jest.fn(async () => ({ ok: true, project_root: "/tmp/new" })),
    });

    await expect(executor.executeCommand("/project switch 1")).resolves.toBe(true);
    expect(options.switchProject).toHaveBeenCalledWith({ target: "1" });
  });

  test("executeCommand routes /open", async () => {
    const { executor, options } = createHarness({
      globalMode: true,
      parseCommand: jest.fn(() => ({ command: "open", args: ["/tmp/project"] })),
      switchProject: jest.fn(async () => ({ ok: true, project_root: "/tmp/project" })),
    });

    await expect(executor.executeCommand("/open /tmp/project")).resolves.toBe(true);
    expect(options.switchProject).toHaveBeenCalledWith({ target: "/tmp/project" });
  });

  test("handleDoctorCommand escapes thrown errors", async () => {
    const { executor, options, logs } = createHarness({
      createDoctor: jest.fn(() => ({ run: jest.fn(() => { throw new Error("boom"); }) })),
    });

    await executor.handleDoctorCommand();

    expect(options.escapeBlessed).toHaveBeenCalledWith("boom");
    expect(logs.some((entry) => entry.text.includes("Doctor check failed: ESC(boom)"))).toBe(true);
  });

  test("handleUcodeConfigCommand show prints masked values", async () => {
    const { executor, options, logs } = createHarness({
      loadUcodeConfig: jest.fn(() => ({
        ucodeProvider: "anthropic",
        ucodeModel: "claude-opus-4-6",
        ucodeBaseUrl: "https://api.example.invalid",
        ucodeApiKey: "cr_1234567890abcdef",
      })),
    });

    await executor.handleUcodeConfigCommand(["show"]);

    expect(options.loadUcodeConfig).toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("provider: anthropic"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("model: claude-opus-4-6"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("url: https://api.example.invalid"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("key: cr_1...cdef"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("transport: anthropic-messages"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("url supports generic gateway base"))).toBe(true);
  });

  test("handleUcodeConfigCommand set writes mapped fields", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleUcodeConfigCommand([
      "set",
      "provider=openai",
      "model=gpt-5.1-codex",
      "url=https://api.openai.com/v1",
      "key=sk-secret-0000",
    ]);

    expect(options.saveUcodeConfig).toHaveBeenCalledWith({
      ucodeProvider: "openai",
      ucodeModel: "gpt-5.1-codex",
      ucodeBaseUrl: "https://api.openai.com/v1",
      ucodeApiKey: "sk-secret-0000",
    });
    expect(logs.some((entry) => entry.text.includes("ucode config updated"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("key: sk-s...0000"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("transport: openai-chat"))).toBe(true);
  });

  test("executeCommand does not route removed /ucodeconfig alias", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "ucodeconfig", args: ["clear", "all"] })),
    });

    await expect(executor.executeCommand("/ucodeconfig clear all")).resolves.toBe(true);

    expect(options.saveConfig).not.toHaveBeenCalled();
  });

  test("executeCommand routes /settings ucode to ucode config handler", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "settings", args: ["ucode", "set", "provider=anthropic", "model=claude-opus-4-6"] })),
    });

    await expect(executor.executeCommand("/settings ucode set provider=anthropic model=claude-opus-4-6")).resolves.toBe(true);

    expect(options.saveUcodeConfig).toHaveBeenCalledWith({
      ucodeProvider: "anthropic",
      ucodeModel: "claude-opus-4-6",
    });
  });

  test("handleSettingsCommand defaults /settings ucode to show", async () => {
    const { executor, options, logs } = createHarness({
      loadUcodeConfig: jest.fn(() => ({
        ucodeProvider: "anthropic",
        ucodeModel: "claude-opus-4-6",
        ucodeBaseUrl: "",
        ucodeApiKey: "",
      })),
    });

    await executor.handleSettingsCommand(["ucode"]);

    expect(options.loadUcodeConfig).toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("ucode config:"))).toBe(true);
  });

  test("handleSettingsCommand shows router mode", async () => {
    const { executor, options, logs } = createHarness({
      loadConfig: jest.fn(() => ({ controllerMode: "main", routerProvider: "codex", routerModel: "gpt-5.4-mini" })),
    });

    await executor.handleSettingsCommand(["router"]);

    expect(options.loadConfig).toHaveBeenCalledWith("/tmp/ufoo");
    expect(logs.some((entry) => entry.text.includes("router config:"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("controllerMode: main"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("provider: codex"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("model: gpt-5.4-mini"))).toBe(true);
  });

  test("executeCommand routes /settings router loop to project config and daemon restart", async () => {
    const { executor, options, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "settings", args: ["router", "loop"] })),
    });

    await expect(executor.executeCommand("/settings router loop")).resolves.toBe(true);

    expect(options.saveConfig).toHaveBeenCalledWith("/tmp/ufoo", { controllerMode: "loop" });
    expect(options.restartDaemon).toHaveBeenCalledWith("/tmp/ufoo");
    expect(logs.some((entry) => entry.text.includes("router mode set to loop"))).toBe(true);
  });

  test("executeCommand routes /settings router set provider/model kv pairs", async () => {
    const { executor, options, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "settings", args: ["router", "set", "provider=claude", "model=claude-haiku", "mode=main"] })),
    });

    await expect(executor.executeCommand("/settings router set provider=claude model=claude-haiku mode=main")).resolves.toBe(true);

    expect(options.saveConfig).toHaveBeenCalledWith("/tmp/ufoo", {
      controllerMode: "main",
      routerProvider: "claude",
      routerModel: "claude-haiku",
    });
    expect(options.restartDaemon).toHaveBeenCalledWith("/tmp/ufoo");
    expect(logs.some((entry) => entry.text.includes("router config updated"))).toBe(true);
  });

  test("handleSettingsCommand clears router provider and model", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleSettingsCommand(["router", "clear", "provider", "model"]);

    expect(options.saveConfig).toHaveBeenCalledWith("/tmp/ufoo", {
      routerProvider: "",
      routerModel: "",
    });
    expect(options.restartDaemon).toHaveBeenCalledWith("/tmp/ufoo");
    expect(logs.some((entry) => entry.text.includes("router config cleared"))).toBe(true);
  });

  test("handleUfooCommand with marker silently checks messages", async () => {
    const createBus = jest.fn(() => ({
      ensureBus: jest.fn(),
      checkMessages: jest.fn().mockReturnValue([]),
    }));
    const { executor, logs } = createHarness({ createBus });

    process.env.UFOO_SUBSCRIBER_ID = "claude-code:test123";
    await executor.handleUfooCommand(["claude-2"]);

    expect(createBus).toHaveBeenCalledWith("/tmp/ufoo");
    // Should not log anything for probe markers
    expect(logs.length).toBe(0);
  });

  test("handleUfooCommand without args shows protocol documentation", async () => {
    const { executor, logs } = createHarness();

    await executor.handleUfooCommand([]);

    expect(logs.some((entry) => entry.text.includes("ufoo Protocol"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("This project uses ufoo for agent coordination"))).toBe(true);
  });

  test("executeCommand routes /ufoo to ufoo handler", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "ufoo", args: ["claude-2"] })),
      createBus: jest.fn(() => ({
        ensureBus: jest.fn(),
        checkMessages: jest.fn().mockReturnValue([]),
      })),
    });

    const result = await executor.executeCommand("/ufoo claude-2");
    expect(result).toBe(true);
  });

  test("handleDaemonCommand stop path calls stopDaemon", async () => {
    const { executor, options, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["stop"] })),
    });
    await executor.executeCommand("/daemon stop");
    expect(options.stopDaemon).toHaveBeenCalled();
    expect(logs.some((e) => e.text.includes("Stopping"))).toBe(true);
  });

  test("handleDaemonCommand restart path calls stopDaemon then startDaemon", async () => {
    const { executor, options, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["restart"] })),
      isDaemonRunning: jest.fn(() => true),
    });
    await executor.executeCommand("/daemon restart");
    expect(options.stopDaemon).toHaveBeenCalled();
    expect(options.startDaemon).toHaveBeenCalled();
    expect(logs.some((e) => e.text.includes("Restarting"))).toBe(true);
  });

  test("handleDaemonCommand status shows running when daemon is active", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["status"] })),
      isDaemonRunning: jest.fn(() => true),
    });
    await executor.executeCommand("/daemon status");
    expect(logs.some((e) => e.text.includes("is running"))).toBe(true);
  });

  test("handleDaemonCommand status shows not running", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["status"] })),
    });
    await executor.executeCommand("/daemon status");
    expect(logs.some((e) => e.text.includes("not running"))).toBe(true);
  });

  test("handleDaemonCommand unknown subcommand shows usage", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["foo"] })),
    });
    await executor.executeCommand("/daemon foo");
    expect(logs.some((e) => e.text.includes("Unknown daemon command"))).toBe(true);
  });

  test("handleDaemonCommand start when already running", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["start"] })),
      isDaemonRunning: jest.fn(() => true),
    });
    await executor.executeCommand("/daemon start");
    expect(logs.some((e) => e.text.includes("already running"))).toBe(true);
  });

  test("handleDaemonCommand start that fails", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["start"] })),
      isDaemonRunning: jest.fn(() => false),
    });
    await executor.executeCommand("/daemon start");
    expect(logs.some((e) => e.text.includes("Failed to start"))).toBe(true);
  });

  test("handleDaemonCommand stop that fails", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "daemon", args: ["stop"] })),
      isDaemonRunning: jest.fn(() => true),
    });
    await executor.executeCommand("/daemon stop");
    expect(logs.some((e) => e.text.includes("Failed to stop"))).toBe(true);
  });

  test("handleInitCommand runs init and logs", async () => {
    const { executor, logs, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "init", args: [] })),
    });
    await executor.executeCommand("/init");
    expect(options.createInit).toHaveBeenCalled();
    expect(logs.some((e) => e.text.includes("Initializing") || e.text.includes("complete"))).toBe(true);
  });

  test("handleInitCommand with specific modules", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "init", args: ["context", "bus"] })),
    });
    await executor.executeCommand("/init context bus");
    const initMock = options.createInit.mock.results[0].value;
    expect(initMock.init).toHaveBeenCalledWith(
      expect.objectContaining({ modules: "context,bus" })
    );
  });

  test("handleInitCommand catches errors", async () => {
    const { executor, logs } = createHarness({
      parseCommand: jest.fn(() => ({ command: "init", args: [] })),
      createInit: jest.fn(() => ({
        init: jest.fn().mockRejectedValue(new Error("init boom")),
      })),
    });
    await executor.executeCommand("/init");
    expect(logs.some((e) => e.text.includes("init boom"))).toBe(true);
  });

  test("collectHostLaunchRequestContext collects env vars", () => {
    const { collectHostLaunchRequestContext } = require("../../../src/chat/commandExecutor");
    const ctx = collectHostLaunchRequestContext({
      UFOO_HOST_INJECT_SOCK: "/tmp/inject.sock",
      UFOO_HOST_DAEMON_SOCK: "/tmp/daemon.sock",
      UFOO_HOST_NAME: "horizon",
      UFOO_HOST_SESSION_ID: "sess-1",
    });
    expect(ctx.host_inject_sock).toBe("/tmp/inject.sock");
    expect(ctx.host_daemon_sock).toBe("/tmp/daemon.sock");
    expect(ctx.host_name).toBe("horizon");
    expect(ctx.host_session_id).toBe("sess-1");
  });

  test("collectHostLaunchRequestContext returns empty for missing vars", () => {
    const { collectHostLaunchRequestContext } = require("../../../src/chat/commandExecutor");
    const ctx = collectHostLaunchRequestContext({});
    expect(Object.keys(ctx)).toHaveLength(0);
  });

  test("collectHostLaunchRequestContext uses HORIZON fallbacks", () => {
    const { collectHostLaunchRequestContext } = require("../../../src/chat/commandExecutor");
    const ctx = collectHostLaunchRequestContext({
      HORIZON_INJECT_SOCK: "/tmp/h-inject.sock",
      HORIZON_SESSION_ID: "h-sess",
    });
    expect(ctx.host_inject_sock).toBe("/tmp/h-inject.sock");
    expect(ctx.host_session_id).toBe("h-sess");
  });
});

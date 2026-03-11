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
    createCronTask: jest.fn((payload) => ({ id: "c1", ...payload, summary: "c1@10s->codex:1: run" })),
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
      launch_scope: "window",
    });

    options.send.mockClear();
    await executor.handleLaunchCommand(["codex", "window"]);
    expect(options.send).toHaveBeenCalledWith({
      type: "launch_agent",
      agent: "codex",
      count: 1,
      nickname: "",
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

  test("handleGroupCommand run sends launch_group request", async () => {
    const { executor, options } = createHarness();

    await executor.handleGroupCommand(["run", "dev-basic", "instance=team-a", "dry_run=true"]);

    expect(options.send).toHaveBeenCalledWith({
      type: "launch_group",
      alias: "dev-basic",
      instance: "team-a",
      dry_run: true,
    });
    expect(options.schedule).toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
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

  test("handleGroupCommand diagram requires target", async () => {
    const { executor, options, logs } = createHarness();

    await executor.handleGroupCommand(["diagram"]);

    expect(options.send).not.toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("Usage: /group diagram <alias|groupId>"))).toBe(true);
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

  test("executeCommand routes /project", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({ command: "project", args: ["switch", "1"] })),
      switchProject: jest.fn(async () => ({ ok: true, project_root: "/tmp/new" })),
    });

    await expect(executor.executeCommand("/project switch 1")).resolves.toBe(true);
    expect(options.switchProject).toHaveBeenCalledWith({ target: "1" });
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
});

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
    });
    expect(options.schedule).toHaveBeenCalled();
    expect(options.requestStatus).toHaveBeenCalled();
    expect(logs.some((entry) => entry.text.includes("Launching codex (neo)"))).toBe(true);
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
    });
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

  test("handleCornCommand creates cron task with interval/targets/prompt", async () => {
    const { executor, options, logs } = createHarness({
      createCronTask: jest.fn((payload) => ({ id: "c7", ...payload })),
    });

    await executor.handleCornCommand([
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

  test("handleCornCommand list and stop", async () => {
    const { executor, options, logs } = createHarness({
      listCronTasks: jest.fn(() => [
        { id: "c1", summary: "c1@10s->codex:1: run smoke" },
      ]),
      stopCronTask: jest.fn((id) => id === "c1"),
    });

    await executor.handleCornCommand(["list"]);
    await executor.handleCornCommand(["stop", "c1"]);

    expect(options.listCronTasks).toHaveBeenCalled();
    expect(options.stopCronTask).toHaveBeenCalledWith("c1");
    expect(logs.some((entry) => entry.text.includes("c1@10s->codex:1: run smoke"))).toBe(true);
    expect(logs.some((entry) => entry.text.includes("Stopped cron task c1"))).toBe(true);
  });

  test("executeCommand routes /corn", async () => {
    const { executor, options } = createHarness({
      parseCommand: jest.fn(() => ({
        command: "corn",
        args: ["start", "every=5s", "target=codex:1", "prompt=ping"],
      })),
      createCronTask: jest.fn(() => ({ id: "c9", intervalMs: 5000, targets: ["codex:1"], prompt: "ping" })),
    });

    await expect(executor.executeCommand("/corn start every=5s target=codex:1 prompt=ping")).resolves.toBe(true);
    expect(options.createCronTask).toHaveBeenCalled();
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
});

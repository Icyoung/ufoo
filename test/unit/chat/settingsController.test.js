const { createSettingsController } = require("../../../src/chat/settingsController");

function createHarness(overrides = {}) {
  const state = {
    launchMode: "terminal",
    selectedModeIndex: 0,
    agentProvider: "codex-cli",
    selectedProviderIndex: 0,
    assistantEngine: "auto",
    selectedAssistantIndex: 0,
    autoResume: true,
    selectedResumeIndex: 0,
  };

  const fsModule = {
    rmSync: jest.fn(),
  };
  const saveConfig = jest.fn();
  const logMessage = jest.fn();
  const renderDashboard = jest.fn();
  const renderScreen = jest.fn();
  const restartDaemon = jest.fn();
  const normalizeLaunchMode = jest.fn((value) => value);
  const normalizeAgentProvider = jest.fn((value) => value);
  const normalizeAssistantEngine = jest.fn((value) => value);
  const getUfooPaths = jest.fn(() => ({ agentDir: "/tmp/agent-dir" }));

  const controller = createSettingsController({
    projectRoot: "/repo",
    saveConfig,
    normalizeLaunchMode,
    normalizeAgentProvider,
    normalizeAssistantEngine,
    fsModule,
    getUfooPaths,
    logMessage,
    renderDashboard,
    renderScreen,
    restartDaemon,
    getLaunchMode: () => state.launchMode,
    setLaunchModeState: (value) => {
      state.launchMode = value;
    },
    setSelectedModeIndex: (value) => {
      state.selectedModeIndex = value;
    },
    getAgentProvider: () => state.agentProvider,
    setAgentProviderState: (value) => {
      state.agentProvider = value;
    },
    setSelectedProviderIndex: (value) => {
      state.selectedProviderIndex = value;
    },
    getAssistantEngine: () => state.assistantEngine,
    setAssistantEngineState: (value) => {
      state.assistantEngine = value;
    },
    setSelectedAssistantIndex: (value) => {
      state.selectedAssistantIndex = value;
    },
    assistantOptions: [
      { label: "auto", value: "auto" },
      { label: "codex", value: "codex" },
      { label: "claude", value: "claude" },
      { label: "ucode", value: "ufoo" },
    ],
    providerOptions: [
      { label: "codex", value: "codex-cli" },
      { label: "claude", value: "claude-cli" },
      { label: "ucode", value: "ucode" },
    ],
    getAutoResume: () => state.autoResume,
    setAutoResumeState: (value) => {
      state.autoResume = value;
    },
    setSelectedResumeIndex: (value) => {
      state.selectedResumeIndex = value;
    },
    ...overrides,
  });

  return {
    controller,
    state,
    fsModule,
    saveConfig,
    logMessage,
    renderDashboard,
    renderScreen,
    restartDaemon,
  };
}

describe("chat settingsController", () => {
  test("requires projectRoot", () => {
    expect(() => createSettingsController({ fsModule: {} })).toThrow(/requires projectRoot/);
  });

  test("setLaunchMode updates config and triggers daemon restart", () => {
    const { controller, state, saveConfig, restartDaemon } = createHarness();

    const changed = controller.setLaunchMode("tmux");

    expect(changed).toBe(true);
    expect(state.launchMode).toBe("tmux");
    expect(state.selectedModeIndex).toBe(1);
    expect(saveConfig).toHaveBeenCalledWith("/repo", { launchMode: "tmux" });
    expect(restartDaemon).toHaveBeenCalledTimes(1);
  });

  test("setLaunchMode is no-op when value is unchanged", () => {
    const { controller, saveConfig, restartDaemon } = createHarness();

    const changed = controller.setLaunchMode("terminal");

    expect(changed).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(restartDaemon).not.toHaveBeenCalled();
  });

  test("setAgentProvider clears identity and restarts daemon", () => {
    const { controller, state, fsModule, saveConfig, restartDaemon } = createHarness();

    const changed = controller.setAgentProvider("claude-cli");

    expect(changed).toBe(true);
    expect(state.agentProvider).toBe("claude-cli");
    expect(state.selectedProviderIndex).toBe(1);
    expect(saveConfig).toHaveBeenCalledWith("/repo", { agentProvider: "claude-cli" });
    expect(fsModule.rmSync).toHaveBeenCalledTimes(2);
    expect(restartDaemon).toHaveBeenCalledTimes(1);
  });

  test("setAutoResume updates config without daemon restart", () => {
    const { controller, state, saveConfig, restartDaemon } = createHarness();

    const changed = controller.setAutoResume(false);

    expect(changed).toBe(true);
    expect(state.autoResume).toBe(false);
    expect(state.selectedResumeIndex).toBe(1);
    expect(saveConfig).toHaveBeenCalledWith("/repo", { autoResume: false });
    expect(restartDaemon).not.toHaveBeenCalled();
  });

  test("setAssistantEngine updates config without daemon restart", () => {
    const { controller, state, saveConfig, restartDaemon } = createHarness();

    const changed = controller.setAssistantEngine("ufoo");

    expect(changed).toBe(true);
    expect(state.assistantEngine).toBe("ufoo");
    expect(state.selectedAssistantIndex).toBe(3);
    expect(saveConfig).toHaveBeenCalledWith("/repo", { assistantEngine: "ufoo" });
    expect(restartDaemon).not.toHaveBeenCalled();
  });
});

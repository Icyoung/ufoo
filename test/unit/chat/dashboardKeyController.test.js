const { createDashboardKeyController } = require("../../../src/chat/dashboardKeyController");
const { createTerminalAdapterRouter } = require("../../../src/terminal/adapterRouter");

function createState(overrides = {}) {
  return {
    currentView: "main",
    focusMode: "dashboard",
    dashboardView: "agents",
    selectedProjectIndex: 0,
    projects: [
      { project_name: "alpha", project_root: "/tmp/alpha" },
      { project_name: "beta", project_root: "/tmp/beta" },
    ],
    activeProjectRoot: "/tmp/alpha",
    selectedAgentIndex: 0,
    activeAgents: ["codex:1", "claude:2"],
    viewingAgent: "codex:1",
    activeAgentMetaMap: new Map([
      ["codex:1", { launch_mode: "internal" }],
      ["claude:2", { launch_mode: "terminal" }],
    ]),
    selectedModeIndex: 0,
    selectedProviderIndex: 0,
    selectedAssistantIndex: 0,
    selectedResumeIndex: 0,
    launchMode: "terminal",
    agentProvider: "codex-cli",
    assistantEngine: "auto",
    autoResume: true,
    providerOptions: [
      { label: "codex", value: "codex-cli" },
      { label: "claude", value: "claude-cli" },
    ],
    assistantOptions: [
      { label: "auto", value: "auto" },
      { label: "codex", value: "codex" },
      { label: "claude", value: "claude" },
      { label: "ufoo", value: "ufoo" },
    ],
    resumeOptions: [
      { label: "Resume previous session", value: true },
      { label: "Start new session", value: false },
    ],
    agentOutputSuppressed: true,
    ...overrides,
  };
}

function createController(stateOverrides = {}, optionOverrides = {}) {
  const state = createState(stateOverrides);
  const adapterRouter = createTerminalAdapterRouter();
  const deps = {
    existsSync: jest.fn(() => false),
    getAgentAdapter: jest.fn((agentId) => {
      const meta = state.activeAgentMetaMap.get(agentId) || {};
      const launchMode = meta.launch_mode || "";
      return adapterRouter.getAdapter({ launchMode, agentId });
    }),
    getInjectSockPath: jest.fn((agentId) => `/tmp/${agentId}.sock`),
    activateAgent: jest.fn(),
    requestCloseAgent: jest.fn(),
    enterAgentView: jest.fn(),
    exitAgentView: jest.fn(),
    setAgentBarVisible: jest.fn(),
    requestAgentSnapshot: jest.fn(),
    clearTargetAgent: jest.fn(),
    restoreTargetFromSelection: jest.fn(),
    syncTargetFromSelection: jest.fn(),
    exitDashboardMode: jest.fn(),
    setLaunchMode: jest.fn(),
    setAgentProvider: jest.fn(),
    setAssistantEngine: jest.fn(),
    setAutoResume: jest.fn(),
    clampAgentWindow: jest.fn(),
    clampAgentWindowWithSelection: jest.fn(),
    requestProjectSwitch: jest.fn(),
    requestCloseProject: jest.fn(),
    renderDashboard: jest.fn(),
    renderAgentDashboard: jest.fn(),
    renderScreen: jest.fn(),
    setScreenGrabKeys: jest.fn(),
    ...optionOverrides,
  };

  const controller = createDashboardKeyController({ state, ...deps });
  return { state, deps, controller };
}

describe("chat dashboardKeyController", () => {
  test("throws when state object is missing", () => {
    expect(() => createDashboardKeyController({})).toThrow(/requires a mutable state object/);
  });

  test("returns false when not in dashboard focus", () => {
    const { controller } = createController({ focusMode: "input" });
    expect(controller.handleDashboardKey({ name: "left" })).toBe(false);
  });

  test("mode view handles navigation and apply", () => {
    const { state, deps, controller } = createController({
      dashboardView: "mode",
      selectedModeIndex: 0,
      agentProvider: "claude-cli",
    });

    expect(controller.handleDashboardKey({ name: "left" })).toBe(true);
    expect(state.selectedModeIndex).toBe(4);

    expect(controller.handleDashboardKey({ name: "down" })).toBe(true);
    expect(state.dashboardView).toBe("provider");
    expect(state.selectedProviderIndex).toBe(1);

    expect(controller.handleDashboardKey({ name: "down" })).toBe(true);
    expect(state.dashboardView).toBe("assistant");
    expect(state.selectedAssistantIndex).toBe(0);

    state.dashboardView = "mode";
    state.selectedModeIndex = 3;
    expect(controller.handleDashboardKey({ name: "enter" })).toBe(true);
    expect(deps.setLaunchMode).toHaveBeenCalledWith("tmux");
    expect(deps.exitDashboardMode).toHaveBeenCalledWith(false);
  });

  test("agents view enter activates external mode agent", () => {
    const { state, deps, controller } = createController({
      dashboardView: "agents",
      selectedAgentIndex: 1,
      activeAgentMetaMap: new Map([
        ["codex:1", { launch_mode: "internal" }],
        ["claude:2", { launch_mode: "terminal" }],
      ]),
    });

    expect(controller.handleDashboardKey({ name: "enter" })).toBe(true);
    expect(deps.clearTargetAgent).toHaveBeenCalled();
    expect(deps.exitDashboardMode).toHaveBeenCalledWith(false);
    expect(deps.activateAgent).toHaveBeenCalledWith("claude:2");
    expect(deps.enterAgentView).not.toHaveBeenCalled();
    expect(state.focusMode).toBe("dashboard");
  });

  test("assistant view applies selected engine", () => {
    const { state, deps, controller } = createController({
      dashboardView: "assistant",
      selectedAssistantIndex: 1,
      assistantOptions: [
        { label: "auto", value: "auto" },
        { label: "codex", value: "codex" },
      ],
    });

    expect(controller.handleDashboardKey({ name: "enter" })).toBe(true);
    expect(deps.setAssistantEngine).toHaveBeenCalledWith("codex");
    expect(deps.exitDashboardMode).toHaveBeenCalledWith(false);
    expect(state.dashboardView).toBe("assistant");
  });

  test("assistant down enters cron view and ctrl+x closes dashboard", () => {
    const { state, deps, controller } = createController({
      dashboardView: "assistant",
      selectedAssistantIndex: 0,
      assistantOptions: [
        { label: "auto", value: "auto" },
      ],
    });

    expect(controller.handleDashboardKey({ name: "down" })).toBe(true);
    expect(state.dashboardView).toBe("cron");

    expect(controller.handleDashboardKey({ name: "x", ctrl: true })).toBe(true);
    expect(deps.exitDashboardMode).toHaveBeenCalledWith(false);
  });

  test("agents view enter opens internal agent when inject socket exists", () => {
    const { state, deps, controller } = createController(
      {
        dashboardView: "agents",
        selectedAgentIndex: 0,
        activeAgentMetaMap: new Map([["codex:1", { launch_mode: "internal-pty" }]]),
      },
      { existsSync: jest.fn(() => true) }
    );

    expect(controller.handleDashboardKey({ name: "enter" })).toBe(true);
    expect(deps.clearTargetAgent).toHaveBeenCalled();
    expect(state.focusMode).toBe("input");
    expect(state.dashboardView).toBe("agents");
    expect(state.selectedAgentIndex).toBe(-1);
    expect(deps.setScreenGrabKeys).toHaveBeenCalledWith(false);
    expect(deps.enterAgentView).toHaveBeenCalledWith("codex:1");
    expect(deps.exitDashboardMode).not.toHaveBeenCalled();
  });

  test("agent view ctrl+x closes selected agent and switches to next", () => {
    const { state, deps, controller } = createController({
      currentView: "agent",
      focusMode: "dashboard",
      selectedAgentIndex: 1,
      activeAgents: ["codex:1", "codex:3"],
      viewingAgent: "codex:1",
      activeAgentMetaMap: new Map([
        ["codex:1", { launch_mode: "internal" }],
        ["codex:3", { launch_mode: "internal" }],
      ]),
    });

    expect(controller.handleDashboardKey({ name: "x", ctrl: true })).toBe(true);
    expect(deps.requestCloseAgent).toHaveBeenCalledWith("codex:1");
    expect(deps.enterAgentView).toHaveBeenCalledWith("codex:3");
    expect(deps.setAgentBarVisible).toHaveBeenCalledWith(true);
    expect(state.focusMode).toBe("input");
    expect(state.agentOutputSuppressed).toBe(false);
    expect(state.selectedAgentIndex).toBe(1);
  });

  test("agent view up exits dashboard overlay back to PTY", () => {
    const { state, deps, controller } = createController({
      currentView: "agent",
      focusMode: "dashboard",
    });

    expect(controller.handleDashboardKey({ name: "up" })).toBe(true);
    expect(state.focusMode).toBe("input");
    expect(state.agentOutputSuppressed).toBe(false);
    expect(deps.setAgentBarVisible).toHaveBeenCalledWith(true);
    expect(deps.renderAgentDashboard).toHaveBeenCalled();
    expect(deps.requestAgentSnapshot).toHaveBeenCalled();
  });

  test("global projects view switches project on left/right and enters second-row controls on down", () => {
    const requestProjectSwitch = jest.fn();
    const { state, deps, controller } = createController(
      {
        dashboardView: "projects",
        selectedProjectIndex: 0,
        projects: [
          { project_name: "alpha", project_root: "/tmp/alpha" },
          { project_name: "beta", project_root: "/tmp/beta" },
        ],
      },
      {
        globalMode: true,
        requestProjectSwitch,
      }
    );

    expect(controller.handleDashboardKey({ name: "right" })).toBe(true);
    expect(state.selectedProjectIndex).toBe(1);
    expect(requestProjectSwitch).toHaveBeenCalledWith(1);
    expect(deps.renderDashboard).toHaveBeenCalled();

    expect(controller.handleDashboardKey({ name: "left" })).toBe(true);
    expect(state.selectedProjectIndex).toBe(0);
    expect(requestProjectSwitch).toHaveBeenCalledWith(0);

    expect(controller.handleDashboardKey({ name: "down" })).toBe(true);
    expect(state.dashboardView).toBe("agents");
    expect(deps.clampAgentWindow).toHaveBeenCalled();

    expect(controller.handleDashboardKey({ name: "down" })).toBe(true);
    expect(state.dashboardView).toBe("mode");

    state.dashboardView = "projects";
    expect(controller.handleDashboardKey({ name: "up" })).toBe(true);
    expect(deps.exitDashboardMode).toHaveBeenCalledWith(false);
  });

  test("global projects view clamps at boundaries (no wrap-around)", () => {
    const requestProjectSwitch = jest.fn();
    const { state, controller } = createController(
      {
        dashboardView: "projects",
        selectedProjectIndex: 0,
        projects: [
          { project_name: "alpha", project_root: "/tmp/alpha" },
          { project_name: "beta", project_root: "/tmp/beta" },
        ],
      },
      {
        globalMode: true,
        requestProjectSwitch,
      }
    );

    expect(controller.handleDashboardKey({ name: "left" })).toBe(true);
    expect(state.selectedProjectIndex).toBe(0);
    expect(requestProjectSwitch).not.toHaveBeenCalled();

    expect(controller.handleDashboardKey({ name: "right" })).toBe(true);
    expect(state.selectedProjectIndex).toBe(1);
    expect(requestProjectSwitch).toHaveBeenCalledWith(1);

    requestProjectSwitch.mockClear();
    expect(controller.handleDashboardKey({ name: "right" })).toBe(true);
    expect(state.selectedProjectIndex).toBe(1);
    expect(requestProjectSwitch).not.toHaveBeenCalled();
  });

  test("global projects view ctrl+x closes selected project", () => {
    const requestCloseProject = jest.fn();
    const { state, controller } = createController(
      {
        dashboardView: "projects",
        selectedProjectIndex: 1,
        projects: [
          { project_name: "alpha", project_root: "/tmp/alpha" },
          { project_name: "beta", project_root: "/tmp/beta" },
        ],
      },
      {
        globalMode: true,
        requestCloseProject,
      }
    );

    expect(controller.handleDashboardKey({ name: "x", ctrl: true })).toBe(true);
    expect(state.selectedProjectIndex).toBe(1);
    expect(requestCloseProject).toHaveBeenCalledWith(1);
  });

  test("projects view is a no-op when globalMode is disabled", () => {
    const { state, deps, controller } = createController({
      dashboardView: "projects",
      selectedProjectIndex: 1,
    });

    expect(controller.handleDashboardKey({ name: "left" })).toBe(true);
    expect(state.selectedProjectIndex).toBe(1);
    expect(deps.requestProjectSwitch).not.toHaveBeenCalled();
    expect(deps.renderDashboard).not.toHaveBeenCalled();
  });

  test("global agents view up returns to projects instead of exiting", () => {
    const { state, deps, controller } = createController(
      {
        dashboardView: "agents",
        selectedAgentIndex: 0,
      },
      {
        globalMode: true,
      }
    );

    expect(controller.handleDashboardKey({ name: "up" })).toBe(true);
    expect(state.dashboardView).toBe("projects");
    expect(deps.exitDashboardMode).not.toHaveBeenCalled();
    expect(deps.renderDashboard).toHaveBeenCalled();
  });
});

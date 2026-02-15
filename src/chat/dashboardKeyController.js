const DEFAULT_MODE_OPTIONS = ["terminal", "tmux", "internal"];

function createDashboardKeyController(options = {}) {
  const {
    state,
    existsSync = () => false,
    getInjectSockPath = () => "",
    getAgentAdapter = () => null,
    activateAgent = () => {},
    requestCloseAgent = () => {},
    enterAgentView = () => {},
    exitAgentView = () => {},
    setAgentBarVisible = () => {},
    requestAgentSnapshot = () => {},
    clearTargetAgent = () => {},
    restoreTargetFromSelection = () => {},
    exitDashboardMode = () => {},
    setLaunchMode = () => {},
    setAgentProvider = () => {},
    setAssistantEngine = () => {},
    setAutoResume = () => {},
    clampAgentWindow = () => {},
    clampAgentWindowWithSelection = () => {},
    renderDashboard = () => {},
    renderAgentDashboard = () => {},
    renderScreen = () => {},
    setScreenGrabKeys = () => {},
    modeOptions = DEFAULT_MODE_OPTIONS,
  } = options;

  if (!state || typeof state !== "object") {
    throw new Error("createDashboardKeyController requires a mutable state object");
  }

  function renderDashboardAndScreen() {
    renderDashboard();
    renderScreen();
  }

  function getAgentCapabilities(agentId) {
    const adapter = getAgentAdapter(agentId);
    return adapter && adapter.capabilities ? adapter.capabilities : null;
  }

  function supportsActivate(agentId) {
    const caps = getAgentCapabilities(agentId);
    return Boolean(caps && caps.supportsActivate);
  }

  function supportsSocket(agentId) {
    const caps = getAgentCapabilities(agentId);
    return Boolean(caps && caps.supportsSocketProtocol);
  }

  function withAgentInputFocus() {
    state.focusMode = "input";
    state.agentOutputSuppressed = false;
    setAgentBarVisible(true);
  }

  function activateExternalAgent(agentId) {
    try {
      activateAgent(agentId);
    } catch {
      // Activation is best-effort.
    }
  }

  function switchAgentView(agentId) {
    withAgentInputFocus();
    enterAgentView(agentId);
  }

  function exitAgentDashboardToInput() {
    withAgentInputFocus();
    renderAgentDashboard();
    requestAgentSnapshot();
  }

  function handleAgentDashboardKey(key) {
    const totalItems = 1 + state.activeAgents.length;

    if (key.name === "left") {
      if (state.selectedAgentIndex > 0) {
        state.selectedAgentIndex -= 1;
      }
      clampAgentWindowWithSelection(state.selectedAgentIndex > 0 ? state.selectedAgentIndex - 1 : -1);
      renderAgentDashboard();
      return true;
    }

    if (key.name === "right") {
      if (state.selectedAgentIndex < totalItems - 1) {
        state.selectedAgentIndex += 1;
      }
      clampAgentWindowWithSelection(state.selectedAgentIndex > 0 ? state.selectedAgentIndex - 1 : -1);
      renderAgentDashboard();
      return true;
    }

    if (key.name === "enter" || key.name === "return") {
      if (state.selectedAgentIndex === 0) {
        exitAgentView();
        return true;
      }

      const agentId = state.activeAgents[state.selectedAgentIndex - 1];
      if (!agentId) {
        return true;
      }

      if (agentId === state.viewingAgent) {
        exitAgentDashboardToInput();
        return true;
      }

      if (supportsActivate(agentId)) {
        exitAgentView();
        activateExternalAgent(agentId);
        return true;
      }

      switchAgentView(agentId);
      return true;
    }

    if (key.name === "up") {
      exitAgentDashboardToInput();
      return true;
    }

    if (key.name === "x" && key.ctrl) {
      if (state.selectedAgentIndex <= 0 || state.selectedAgentIndex > state.activeAgents.length) {
        return true;
      }

      const agentId = state.activeAgents[state.selectedAgentIndex - 1];
      const remaining = state.activeAgents.filter((id) => id !== agentId);
      const nextIndex = remaining.length > 0
        ? Math.min(state.selectedAgentIndex - 1, remaining.length - 1)
        : -1;
      const nextAgent = nextIndex >= 0 ? remaining[nextIndex] : null;

      if (agentId === state.viewingAgent) {
        if (nextAgent) {
          if (supportsActivate(nextAgent)) {
            exitAgentView();
            activateExternalAgent(nextAgent);
          } else {
            withAgentInputFocus();
            state.selectedAgentIndex = nextIndex + 1;
            enterAgentView(nextAgent);
          }
        } else {
          exitAgentView();
        }
      } else if (nextAgent) {
        state.selectedAgentIndex = nextIndex + 1;
        renderAgentDashboard();
      } else {
        state.selectedAgentIndex = 0;
        renderAgentDashboard();
      }

      requestCloseAgent(agentId);
      return true;
    }

    return true;
  }

  function handleModeKey(key) {
    if (key.name === "left") {
      state.selectedModeIndex = state.selectedModeIndex <= 0 ? modeOptions.length - 1 : state.selectedModeIndex - 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "right") {
      state.selectedModeIndex = state.selectedModeIndex >= modeOptions.length - 1 ? 0 : state.selectedModeIndex + 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "down") {
      state.dashboardView = "provider";
      state.selectedProviderIndex = Math.max(0, (state.providerOptions || []).findIndex((opt) => opt.value === state.agentProvider));
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "up") {
      state.dashboardView = "agents";
      restoreTargetFromSelection();
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "enter" || key.name === "return") {
      const mode = modeOptions[state.selectedModeIndex];
      if (mode) setLaunchMode(mode);
      exitDashboardMode(false);
      return true;
    }

    if (key.name === "escape") {
      exitDashboardMode(false);
      return true;
    }

    return true;
  }

  function handleProviderKey(key) {
    if (key.name === "left") {
      state.selectedProviderIndex = state.selectedProviderIndex <= 0
        ? state.providerOptions.length - 1
        : state.selectedProviderIndex - 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "right") {
      state.selectedProviderIndex = state.selectedProviderIndex >= state.providerOptions.length - 1
        ? 0
        : state.selectedProviderIndex + 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "down") {
      state.dashboardView = "assistant";
      const list = Array.isArray(state.assistantOptions) ? state.assistantOptions : [];
      const nextIndex = list.findIndex((opt) => opt.value === state.assistantEngine);
      state.selectedAssistantIndex = nextIndex >= 0 ? nextIndex : 0;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "up") {
      state.dashboardView = "mode";
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "enter" || key.name === "return") {
      const selected = state.providerOptions[state.selectedProviderIndex];
      if (selected) setAgentProvider(selected.value);
      exitDashboardMode(false);
      return true;
    }

    if (key.name === "escape") {
      exitDashboardMode(false);
      return true;
    }

    return true;
  }

  function handleAssistantKey(key) {
    const options = Array.isArray(state.assistantOptions) ? state.assistantOptions : [];
    if (options.length === 0) {
      if (key.name === "up") {
        state.dashboardView = "provider";
        renderDashboardAndScreen();
        return true;
      }
      if (key.name === "escape" || key.name === "enter" || key.name === "return") {
        exitDashboardMode(false);
        return true;
      }
      return true;
    }

    if (key.name === "left") {
      state.selectedAssistantIndex = state.selectedAssistantIndex <= 0
        ? options.length - 1
        : state.selectedAssistantIndex - 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "right") {
      state.selectedAssistantIndex = state.selectedAssistantIndex >= options.length - 1
        ? 0
        : state.selectedAssistantIndex + 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "up") {
      state.dashboardView = "provider";
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "down") {
      state.dashboardView = "cron";
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "enter" || key.name === "return") {
      const selected = options[state.selectedAssistantIndex];
      if (selected) setAssistantEngine(selected.value);
      exitDashboardMode(false);
      return true;
    }

    if (key.name === "escape") {
      exitDashboardMode(false);
      return true;
    }

    return true;
  }

  function handleCronKey(key) {
    if (key.name === "up") {
      state.dashboardView = "assistant";
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "x" && key.ctrl) {
      exitDashboardMode(false);
      return true;
    }

    if (key.name === "escape" || key.name === "enter" || key.name === "return") {
      exitDashboardMode(false);
      return true;
    }

    return true;
  }

  function handleResumeKey(key) {
    if (key.name === "left") {
      state.selectedResumeIndex = state.selectedResumeIndex <= 0
        ? state.resumeOptions.length - 1
        : state.selectedResumeIndex - 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "right") {
      state.selectedResumeIndex = state.selectedResumeIndex >= state.resumeOptions.length - 1
        ? 0
        : state.selectedResumeIndex + 1;
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "up") {
      state.dashboardView = "provider";
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "enter" || key.name === "return") {
      const selected = state.resumeOptions[state.selectedResumeIndex];
      if (selected) setAutoResume(selected.value);
      exitDashboardMode(false);
      return true;
    }

    if (key.name === "escape") {
      exitDashboardMode(false);
      return true;
    }

    return true;
  }

  function handleAgentsKey(key) {
    if (key.name === "left") {
      if (state.activeAgents.length > 0 && state.selectedAgentIndex > 0) {
        state.selectedAgentIndex -= 1;
        clampAgentWindow();
        syncTargetFromSelection();
        renderDashboardAndScreen();
      }
      return true;
    }

    if (key.name === "right") {
      if (state.activeAgents.length > 0 && state.selectedAgentIndex < state.activeAgents.length - 1) {
        state.selectedAgentIndex += 1;
        clampAgentWindow();
        syncTargetFromSelection();
        renderDashboardAndScreen();
      }
      return true;
    }

    if (key.name === "down") {
      clearTargetAgent();
      state.dashboardView = "mode";
      state.selectedModeIndex = state.launchMode === "internal" ? 2 : (state.launchMode === "tmux" ? 1 : 0);
      renderDashboardAndScreen();
      return true;
    }

    if (key.name === "up" || key.name === "escape") {
      clearTargetAgent();
      exitDashboardMode(false);
      return true;
    }

    if (key.name === "x" && key.ctrl) {
      if (state.selectedAgentIndex >= 0 && state.selectedAgentIndex < state.activeAgents.length) {
        const agentId = state.activeAgents[state.selectedAgentIndex];
        requestCloseAgent(agentId);
        clearTargetAgent();
        exitDashboardMode(false);
      }
      return true;
    }

    if (key.name === "enter" || key.name === "return") {
      if (state.selectedAgentIndex >= 0 && state.selectedAgentIndex < state.activeAgents.length) {
        const agentId = state.activeAgents[state.selectedAgentIndex];
        if (supportsActivate(agentId)) {
          clearTargetAgent();
          exitDashboardMode(false);
          activateExternalAgent(agentId);
          return true;
        }

        const sockPath = getInjectSockPath(agentId);
        if (supportsSocket(agentId) && existsSync(sockPath)) {
          clearTargetAgent();
          state.focusMode = "input";
          state.dashboardView = "agents";
          state.selectedAgentIndex = -1;
          setScreenGrabKeys(false);
          enterAgentView(agentId);
          return true;
        }
      }

      exitDashboardMode(false);
      return true;
    }

    return false;
  }

  function syncTargetFromSelection() {
    if (typeof options.syncTargetFromSelection === "function") {
      options.syncTargetFromSelection();
    }
  }

  function handleDashboardKey(key) {
    if (!key || state.focusMode !== "dashboard") return false;

    if (state.currentView === "agent") {
      return handleAgentDashboardKey(key);
    }

    if (state.dashboardView === "mode") return handleModeKey(key);
    if (state.dashboardView === "provider") return handleProviderKey(key);
    if (state.dashboardView === "assistant") return handleAssistantKey(key);
    if (state.dashboardView === "resume") return handleResumeKey(key);
    if (state.dashboardView === "cron") return handleCronKey(key);

    return handleAgentsKey(key);
  }

  return {
    handleDashboardKey,
  };
}

module.exports = {
  createDashboardKeyController,
};

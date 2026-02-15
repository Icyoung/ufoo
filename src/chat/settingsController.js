const path = require("path");

function createSettingsController(options = {}) {
  const {
    projectRoot,
    saveConfig = () => {},
    normalizeLaunchMode = (value) => value,
    normalizeAgentProvider = (value) => value,
    normalizeAssistantEngine = (value) => value,
    fsModule,
    getUfooPaths = () => ({ agentDir: "" }),
    logMessage = () => {},
    renderDashboard = () => {},
    renderScreen = () => {},
    restartDaemon = () => {},
    getLaunchMode = () => "terminal",
    setLaunchModeState = () => {},
    setSelectedModeIndex = () => {},
    getAgentProvider = () => "codex-cli",
    setAgentProviderState = () => {},
    setSelectedProviderIndex = () => {},
    getAssistantEngine = () => "auto",
    setAssistantEngineState = () => {},
    setSelectedAssistantIndex = () => {},
    assistantOptions = [],
    providerOptions = [],
    getAutoResume = () => true,
    setAutoResumeState = () => {},
    setSelectedResumeIndex = () => {},
  } = options;

  if (!projectRoot) {
    throw new Error("createSettingsController requires projectRoot");
  }
  if (!fsModule) {
    throw new Error("createSettingsController requires fsModule");
  }

  function providerLabel(value) {
    return value === "claude-cli" ? "claude" : "codex";
  }

  function assistantLabel(value) {
    const normalized = normalizeAssistantEngine(value);
    if (normalized === "codex") return "codex";
    if (normalized === "claude") return "claude";
    if (normalized === "ufoo") return "ufoo";
    return "auto";
  }

  function clearUfooAgentIdentity() {
    const agentDir = getUfooPaths(projectRoot).agentDir;
    const stateFile = path.join(agentDir, "ufoo-agent.json");
    const historyFile = path.join(agentDir, "ufoo-agent.history.jsonl");
    try {
      fsModule.rmSync(stateFile, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    try {
      fsModule.rmSync(historyFile, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
  }

  function setLaunchMode(mode) {
    const next = normalizeLaunchMode(mode);
    if (next === getLaunchMode()) return false;
    setLaunchModeState(next);
    setSelectedModeIndex(next === "internal" ? 2 : (next === "tmux" ? 1 : 0));
    saveConfig(projectRoot, { launchMode: next });
    logMessage("status", `{white-fg}⚙{/white-fg} Launch mode: ${next}`);
    renderDashboard();
    renderScreen();
    void restartDaemon();
    return true;
  }

  function setAgentProvider(provider) {
    const next = normalizeAgentProvider(provider);
    if (next === getAgentProvider()) return false;
    setAgentProviderState(next);
    setSelectedProviderIndex(Math.max(0, providerOptions.findIndex((opt) => opt.value === next)));
    saveConfig(projectRoot, { agentProvider: next });
    clearUfooAgentIdentity();
    logMessage("status", `{white-fg}⚙{/white-fg} ufoo-agent: ${providerLabel(next)}`);
    renderDashboard();
    renderScreen();
    void restartDaemon();
    return true;
  }

  function setAutoResume(value) {
    const next = value !== false;
    if (next === getAutoResume()) return false;
    setAutoResumeState(next);
    setSelectedResumeIndex(next ? 0 : 1);
    saveConfig(projectRoot, { autoResume: next });
    const label = next ? "Resume previous session" : "Start new session";
    logMessage("status", `{white-fg}⚙{/white-fg} Resume mode: ${label}`);
    renderDashboard();
    renderScreen();
    return true;
  }

  function setAssistantEngine(engine) {
    const next = normalizeAssistantEngine(engine);
    if (next === getAssistantEngine()) return false;
    setAssistantEngineState(next);
    const idx = assistantOptions.findIndex((opt) => opt && opt.value === next);
    setSelectedAssistantIndex(idx >= 0 ? idx : 0);
    saveConfig(projectRoot, { assistantEngine: next });
    logMessage("status", `{white-fg}⚙{/white-fg} assistant-engine: ${assistantLabel(next)}`);
    renderDashboard();
    renderScreen();
    return true;
  }

  return {
    providerLabel,
    assistantLabel,
    clearUfooAgentIdentity,
    setLaunchMode,
    setAgentProvider,
    setAssistantEngine,
    setAutoResume,
  };
}

module.exports = {
  createSettingsController,
};

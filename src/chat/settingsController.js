const path = require("path");

function createSettingsController(options = {}) {
  const {
    projectRoot,
    saveConfig = () => {},
    normalizeLaunchMode = (value) => value,
    normalizeAgentProvider = (value) => value,
    fsModule,
    getUfooPaths = () => ({ agentDir: "" }),
    logMessage = () => {},
    resolveStatusLine = null,
    renderDashboard = () => {},
    renderScreen = () => {},
    restartDaemon = () => {},
    getLaunchMode = () => "terminal",
    setLaunchModeState = () => {},
    setSelectedModeIndex = () => {},
    getAgentProvider = () => "codex-cli",
    setAgentProviderState = () => {},
    setSelectedProviderIndex = () => {},
    providerOptions = [],
    modeOptions = [],
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
    const nextIndex = modeOptions.findIndex((opt) => opt === next);
    setSelectedModeIndex(nextIndex >= 0 ? nextIndex : 0);
    saveConfig(projectRoot, { launchMode: next });
    const statusMsg = resolveStatusLine || ((text) => logMessage("status", text));
    statusMsg(`{gray-fg}⚙{/gray-fg} Launch mode: ${next}`);
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
    const statusMsg = resolveStatusLine || ((text) => logMessage("status", text));
    statusMsg(`{gray-fg}⚙{/gray-fg} ufoo-agent: ${providerLabel(next)}`);
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
    const statusMsg = resolveStatusLine || ((text) => logMessage("status", text));
    statusMsg(`{gray-fg}⚙{/gray-fg} Resume mode: ${label}`);
    renderDashboard();
    renderScreen();
    return true;
  }

  return {
    providerLabel,
    clearUfooAgentIdentity,
    setLaunchMode,
    setAgentProvider,
    setAutoResume,
  };
}

module.exports = {
  createSettingsController,
};

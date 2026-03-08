function normalizeIndex(value, length) {
  const parsed = Number(value);
  const nextIndex = Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
  if (!Number.isFinite(nextIndex) || nextIndex < 0 || nextIndex >= length) {
    return -1;
  }
  return nextIndex;
}

function defaultResolveProjectRoot(row = {}) {
  return String((row && row.project_root) || "");
}

function createProjectCloseController(options = {}) {
  const {
    getProjects = () => [],
    getActiveProjectRoot = () => "",
    resolveProjectRoot = defaultResolveProjectRoot,
    isRunning = () => false,
    stopDaemon = () => false,
    switchProject = async () => ({ ok: false, error: "project switching unavailable" }),
    refreshProjects = () => {},
    renderDashboard = () => {},
    renderScreen = () => {},
    logMessage = () => {},
    escapeBlessed = (value) => String(value || ""),
  } = options;

  let closingProject = false;

  function pickFallbackProjectRoot(targetProjectRoot) {
    const rows = Array.isArray(getProjects()) ? getProjects() : [];
    for (const row of rows) {
      const root = resolveProjectRoot(row);
      if (!root || root === targetProjectRoot) continue;
      return root;
    }
    return "";
  }

  async function requestCloseProject(index) {
    if (closingProject) {
      return { ok: false, error: "project close already in progress" };
    }

    const rows = Array.isArray(getProjects()) ? getProjects() : [];
    const nextIndex = normalizeIndex(index, rows.length);
    if (nextIndex < 0) {
      return { ok: false, error: "project index out of range" };
    }

    const target = rows[nextIndex] || {};
    const projectRoot = resolveProjectRoot(target);
    if (!projectRoot) {
      return { ok: false, error: "project root unavailable" };
    }

    const projectName = String(target.project_name || projectRoot);
    const escapedName = escapeBlessed(projectName);
    const activeProjectRoot = String(getActiveProjectRoot() || "");

    closingProject = true;
    try {
      logMessage("status", `{white-fg}⚙{/white-fg} Closing project ${escapedName} daemon and agents...`);

      let switchedTo = "";
      if (activeProjectRoot === projectRoot) {
        const fallbackRoot = pickFallbackProjectRoot(projectRoot);
        if (!fallbackRoot) {
          const error = "Cannot close current project; switch to another project first";
          logMessage("error", `{white-fg}✗{/white-fg} ${escapeBlessed(error)}`);
          return { ok: false, error };
        }

        const switched = await Promise.resolve(switchProject(fallbackRoot));
        if (!switched || switched.ok !== true) {
          const reason = String((switched && switched.error) || "switch failed");
          logMessage("error", `{white-fg}✗{/white-fg} Failed to switch project before close: ${escapeBlessed(reason)}`);
          return { ok: false, error: reason };
        }
        switchedTo = fallbackRoot;
      }

      const wasRunning = Boolean(isRunning(projectRoot));
      stopDaemon(projectRoot);

      refreshProjects();
      renderDashboard();
      renderScreen();

      if (wasRunning) {
        logMessage("status", `{white-fg}✓{/white-fg} Closed project ${escapedName} daemon and agents`);
      } else {
        logMessage("status", `{white-fg}✓{/white-fg} Project ${escapedName} daemon already stopped`);
      }

      return {
        ok: true,
        project_root: projectRoot,
        switched_to: switchedTo || undefined,
      };
    } catch (err) {
      const message = err && err.message ? err.message : String(err || "project close failed");
      logMessage("error", `{white-fg}✗{/white-fg} Failed to close project: ${escapeBlessed(message)}`);
      return { ok: false, error: message };
    } finally {
      closingProject = false;
    }
  }

  return {
    requestCloseProject,
    pickFallbackProjectRoot,
  };
}

module.exports = {
  createProjectCloseController,
};

const { createProjectCloseController } = require("../../../src/chat/projectCloseController");

describe("chat projectCloseController", () => {
  function setup(overrides = {}) {
    let projects = [
      { project_name: "alpha", project_root: "/tmp/alpha", status: "running" },
      { project_name: "beta", project_root: "/tmp/beta", status: "running" },
    ];
    let activeProjectRoot = "/tmp/alpha";

    const deps = {
      getProjects: jest.fn(() => projects),
      getActiveProjectRoot: jest.fn(() => activeProjectRoot),
      resolveProjectRoot: jest.fn((row) => String((row && row.project_root) || "")),
      isRunning: jest.fn((projectRoot) => projectRoot === "/tmp/beta"),
      stopDaemon: jest.fn(),
      switchProject: jest.fn(async (projectRoot) => {
        activeProjectRoot = projectRoot;
        return { ok: true, project_root: projectRoot };
      }),
      refreshProjects: jest.fn(),
      renderDashboard: jest.fn(),
      renderScreen: jest.fn(),
      logMessage: jest.fn(),
      resolveStatusLine: jest.fn(),
      escapeBlessed: jest.fn((value) => String(value || "")),
      ...overrides,
    };

    const controller = createProjectCloseController(deps);
    return {
      controller,
      deps,
      setProjects: (next) => {
        projects = Array.isArray(next) ? next : [];
      },
      setActiveProjectRoot: (next) => {
        activeProjectRoot = String(next || "");
      },
      getActiveProjectRoot: () => activeProjectRoot,
    };
  }

  test("closes non-active project by stopping daemon", async () => {
    const { controller, deps } = setup();
    const result = await controller.requestCloseProject(1);

    expect(result.ok).toBe(true);
    expect(result.project_root).toBe("/tmp/beta");
    expect(deps.switchProject).not.toHaveBeenCalled();
    expect(deps.stopDaemon).toHaveBeenCalledWith("/tmp/beta");
    expect(deps.refreshProjects).toHaveBeenCalled();
    expect(deps.resolveStatusLine).toHaveBeenCalledWith(
      "{gray-fg}✓{/gray-fg} Closed project beta daemon and agents"
    );
    expect(deps.logMessage).not.toHaveBeenCalledWith("status", expect.anything());
  });

  test("closing active project switches fallback before stopping daemon", async () => {
    const { controller, deps } = setup({
      isRunning: jest.fn(() => true),
    });

    const result = await controller.requestCloseProject(0);

    expect(result.ok).toBe(true);
    expect(result.project_root).toBe("/tmp/alpha");
    expect(result.switched_to).toBe("/tmp/beta");
    expect(deps.switchProject).toHaveBeenCalledWith("/tmp/beta");
    expect(deps.stopDaemon).toHaveBeenCalledWith("/tmp/alpha");
  });

  test("fails to close active project when no fallback exists", async () => {
    const { controller, deps, setProjects } = setup();
    setProjects([
      { project_name: "alpha", project_root: "/tmp/alpha", status: "running" },
    ]);

    const result = await controller.requestCloseProject(0);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Cannot close current project");
    expect(deps.switchProject).not.toHaveBeenCalled();
    expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(deps.logMessage).toHaveBeenCalledWith(
      "error",
      "{white-fg}✗{/white-fg} Cannot close current project; switch to another project first"
    );
  });

  test("aborts close when fallback switch fails", async () => {
    const { controller, deps } = setup({
      switchProject: jest.fn(async () => ({ ok: false, error: "switch failed" })),
      isRunning: jest.fn(() => true),
    });

    const result = await controller.requestCloseProject(0);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("switch failed");
    expect(deps.stopDaemon).not.toHaveBeenCalled();
    expect(deps.logMessage).toHaveBeenCalledWith(
      "error",
      "{white-fg}✗{/white-fg} Failed to switch project before close: switch failed"
    );
  });
});

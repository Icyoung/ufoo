const {
  computeDashboardContent,
  providerLabel,
} = require("../../../src/chat/dashboardView");

describe("chat dashboardView", () => {
  const dashHints = {
    agents: "AGENTS",
    agentsGlobal: "AGENTS_GLOBAL",
    agentsEmpty: "EMPTY",
    mode: "MODE",
    provider: "PROVIDER",
    resume: "RESUME",
    projects: "PROJECTS",
    projectsFocus: "PROJECTS_FOCUS",
    projectsEmpty: "NO_PROJECTS",
  };

  test("providerLabel maps provider ids", () => {
    expect(providerLabel("claude-cli")).toBe("claude");
    expect(providerLabel("codex-cli")).toBe("codex");
    expect(providerLabel("unknown")).toBe("codex");
  });

  test("normal mode renders summary line without reports counter", () => {
    const out = computeDashboardContent({
      focusMode: "input",
      activeAgents: ["a", "b", "c", "d"],
      getAgentLabel: (id) => `@${id}`,
      launchMode: "tmux",
      agentProvider: "claude-cli",
      cronTasks: [{ id: "c1", summary: "c1@10s->a: smoke" }, { id: "c2", summary: "c2@5m->b: check" }],
      loopSummary: {
        rounds: 2,
        tool_calls: 1,
        total_tokens: 165,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        terminal_reason: "final_answer",
        tools: [{ name: "dispatch_message", count: 1 }],
      },
      autoResume: false,
      dashHints,
    });

    expect(out.windowStart).toBe(0);
    expect(out.content).toContain("{gray-fg}Agents:{/gray-fg} {cyan-fg}@a, @b, @c +1{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Mode:{/gray-fg} {cyan-fg}tmux{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Agent:{/gray-fg} {cyan-fg}claude{/cyan-fg}");
    expect(out.content).not.toContain("{gray-fg}Reports:{/gray-fg}");
    expect(out.content).toContain("{gray-fg}Cron:{/gray-fg} {cyan-fg}2{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Loop:{/gray-fg} {cyan-fg}r2 tc1 tok165 cache10/5 dispatch_messagex1 final_answer{/cyan-fg}");
  });

  test("dashboard mode page highlights selected mode", () => {
    const out = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "mode",
      selectedModeIndex: 3,
      dashHints,
    });

    expect(out.content).toContain("{inverse}tmux{/inverse}");
    expect(out.content).toContain("{gray-fg}│ MODE{/gray-fg}");
  });

  test("dashboard agents view clamps window and renders overflow markers", () => {
    const out = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "agents",
      activeAgents: ["a", "b", "c", "d", "e"],
      selectedAgentIndex: 4,
      agentListWindowStart: 0,
      maxAgentWindow: 3,
      getAgentLabel: (id) => id.toUpperCase(),
      dashHints,
    });

    expect(out.windowStart).toBe(2);
    expect(out.content).toContain("{gray-fg}<{/gray-fg}");
    expect(out.content).toContain("{inverse}@E{/inverse}");
    expect(out.content).toContain("{gray-fg}│ AGENTS{/gray-fg}");
  });

  test("dashboard agents empty renders empty hint", () => {
    const out = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "agents",
      activeAgents: [],
      dashHints,
    });

    expect(out.content).toContain("{cyan-fg}none{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}│ EMPTY{/gray-fg}");
  });

  test("provider/resume pages highlight selected options", () => {
    const providerOut = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "provider",
      providerOptions: [
        { label: "codex", value: "codex-cli" },
        { label: "claude", value: "claude-cli" },
      ],
      selectedProviderIndex: 1,
      dashHints,
    });
    expect(providerOut.content).toContain("{inverse}claude{/inverse}");
    expect(providerOut.content).toContain("{gray-fg}│ PROVIDER{/gray-fg}");

    const resumeOut = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "resume",
      resumeOptions: [
        { label: "Resume previous session", value: true },
        { label: "Start new session", value: false },
      ],
      selectedResumeIndex: 0,
      dashHints,
    });
    expect(resumeOut.content).toContain("{inverse}Resume previous session{/inverse}");
    expect(resumeOut.content).toContain("{gray-fg}│ RESUME{/gray-fg}");
  });

  test("cron page renders task summaries", () => {
    const out = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "cron",
      selectedCronIndex: 1,
      cronTasks: [
        { id: "c1", label: "codex:1:run smoke:10s", summary: "c1 codex:1:run smoke:10s" },
        { id: "c2", label: "claude:2:check logs:1m", summary: "c2 claude:2:check logs:1m" },
      ],
      dashHints: { ...dashHints, cron: "CRON" },
    });
    expect(out.content).toContain("{gray-fg}Cron:{/gray-fg}");
    expect(out.content).toContain("{cyan-fg}codex:1:run smoke:10s{/cyan-fg}");
    expect(out.content).toContain("{inverse}claude:2:check logs:1m{/inverse}");
    expect(out.content).toContain("{gray-fg}│ CRON{/gray-fg}");
  });

  test("global mode renders project rail with normal summary on second line", () => {
    const out = computeDashboardContent({
      globalMode: true,
      globalScope: "project",
      focusMode: "input",
      projects: [
        { project_name: "alpha", project_root: "/tmp/alpha", status: "running" },
        { project_name: "beta", project_root: "/tmp/beta", status: "stale" },
        { project_name: "gamma", project_root: "/tmp/gamma", status: "stopped" },
      ],
      selectedProjectIndex: 1,
      projectListWindowStart: 0,
      maxProjectWindow: 2,
      activeProjectRoot: "/tmp/alpha",
      activeAgents: ["codex:1", "claude:2"],
      dashHints,
    });

    expect(out.windowStart).toBe(0);
    expect(out.content).toContain("{gray-fg}Projects:{/gray-fg}");
    expect(out.content).toContain("{bold}{cyan-fg}alpha{/cyan-fg}{/bold}");
    expect(out.content).toContain("{cyan-fg}beta{/cyan-fg}");
    expect(out.content).not.toContain("{inverse}beta{/inverse}");
    expect(out.content).toContain("\n");
    expect(out.content).toContain("{gray-fg}Agents:{/gray-fg} {cyan-fg}@codex:1, @claude:2{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Mode:{/gray-fg} {cyan-fg}terminal{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Agent:{/gray-fg} {cyan-fg}codex{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Cron:{/gray-fg} {cyan-fg}0{/cyan-fg}");
  });

  test("global mode renders empty state when registry has no projects", () => {
    const out = computeDashboardContent({
      globalMode: true,
      focusMode: "input",
      projects: [],
      dashHints,
    });

    expect(out.windowStart).toBe(0);
    expect(out.content).toContain("{gray-fg}Projects:{/gray-fg} {cyan-fg}none{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}NO_PROJECTS{/gray-fg}");
  });

  test("global dashboard projects focus keeps normal summary second line", () => {
    const out = computeDashboardContent({
      globalMode: true,
      focusMode: "dashboard",
      dashboardView: "projects",
      projects: [{ project_name: "alpha", project_root: "/tmp/alpha", status: "running" }],
      selectedProjectIndex: 0,
      activeProjectRoot: "/tmp/alpha",
      activeAgents: ["codex:1"],
      dashHints,
    });

    expect(out.content).toContain("{inverse}alpha{/inverse}");
    expect(out.content).not.toContain("{bold}");
    expect(out.content).toContain("{gray-fg}Agents:{/gray-fg} {cyan-fg}@codex:1{/cyan-fg}");
  });

  test("global projects rail keeps selected project visible when list is folded", () => {
    const out = computeDashboardContent({
      globalMode: true,
      focusMode: "dashboard",
      dashboardView: "projects",
      projects: [
        { project_name: "alpha", project_root: "/tmp/alpha", status: "running" },
        { project_name: "beta", project_root: "/tmp/beta", status: "running" },
        { project_name: "gamma", project_root: "/tmp/gamma", status: "running" },
        { project_name: "delta", project_root: "/tmp/delta", status: "running" },
        { project_name: "epsilon", project_root: "/tmp/epsilon", status: "running" },
      ],
      selectedProjectIndex: 4,
      projectListWindowStart: 0,
      maxProjectWindow: 2,
      activeProjectRoot: "/tmp/alpha",
      activeAgents: ["codex:1"],
      dashHints,
    });

    expect(out.windowStart).toBe(3);
    expect(out.content).toContain("{gray-fg}<{/gray-fg}");
    expect(out.content).toContain("{inverse}epsilon{/inverse}");
  });

  test("global dashboard agents view uses agentsGlobal hint", () => {
    const out = computeDashboardContent({
      globalMode: true,
      globalScope: "project",
      focusMode: "dashboard",
      dashboardView: "agents",
      projects: [{ project_name: "alpha", project_root: "/tmp/alpha", status: "running" }],
      selectedProjectIndex: 0,
      activeProjectRoot: "/tmp/alpha",
      activeAgents: ["codex:1"],
      selectedAgentIndex: 0,
      getAgentLabel: (id) => id,
      dashHints,
    });

    expect(out.content).toContain("{gray-fg}Projects:{/gray-fg}");
    expect(out.content).toContain("{bold}{cyan-fg}alpha{/cyan-fg}{/bold}");
    expect(out.content).toContain("{gray-fg}│ AGENTS_GLOBAL{/gray-fg}");
  });

  test("global controller scope shows Enter→project hint when projects focused", () => {
    const out = computeDashboardContent({
      globalMode: true,
      globalScope: "controller",
      focusMode: "dashboard",
      dashboardView: "projects",
      projects: [{ project_name: "alpha", project_root: "/tmp/alpha", status: "running" }],
      selectedProjectIndex: 0,
      activeProjectRoot: "/home/user",
      dashHints: {},
    });

    expect(out.content).toContain("Enter\u2192project");
    expect(out.content).not.toContain("{bold}");
  });

  test("global project scope shows Esc→global hint when projects focused", () => {
    const out = computeDashboardContent({
      globalMode: true,
      globalScope: "project",
      focusMode: "dashboard",
      dashboardView: "projects",
      projects: [{ project_name: "alpha", project_root: "/tmp/alpha", status: "running" }],
      selectedProjectIndex: 0,
      activeProjectRoot: "/tmp/alpha",
      dashHints: {},
    });

    expect(out.content).toContain("Esc\u2192global");
  });

  test("global mode shows no hint when projects row is not focused", () => {
    const out = computeDashboardContent({
      globalMode: true,
      globalScope: "controller",
      focusMode: "input",
      projects: [{ project_name: "alpha", project_root: "/tmp/alpha", status: "running" }],
      selectedProjectIndex: 0,
      activeProjectRoot: "/home/user",
      dashHints: {},
    });

    expect(out.content).not.toContain("Enter\u2192project");
    expect(out.content).not.toContain("Esc\u2192global");
  });

  test("dashboard renders activity markers for agents", () => {
    const states = {
      "codex:1": "working",
      "claude:2": "waiting_input",
      "ucode:3": "blocked",
    };

    const summary = computeDashboardContent({
      focusMode: "input",
      activeAgents: ["codex:1", "claude:2", "ucode:3"],
      getAgentLabel: (id) => id,
      getAgentState: (id) => states[id] || "",
      dashHints,
    });
    expect(summary.content).toContain("*@codex:1");
    expect(summary.content).toContain("?@claude:2");
    expect(summary.content).toContain("!@ucode:3");

    const detail = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "agents",
      activeAgents: ["codex:1", "claude:2", "ucode:3"],
      selectedAgentIndex: 1,
      getAgentLabel: (id) => id,
      getAgentState: (id) => states[id] || "",
      dashHints,
    });
    expect(detail.content).toContain("{cyan-fg}*@codex:1{/cyan-fg}");
    expect(detail.content).toContain("{inverse}?@claude:2{/inverse}");
    expect(detail.content).toContain("{cyan-fg}!@ucode:3{/cyan-fg}");
  });

  test("omits loop summary when no recent loop metrics exist", () => {
    const out = computeDashboardContent({
      focusMode: "input",
      activeAgents: ["a"],
      getAgentLabel: (id) => id,
      loopSummary: {
        rounds: 0,
        tool_calls: 0,
        total_tokens: 0,
        terminal_reason: "",
        tools: [],
      },
      dashHints,
    });

    expect(out.content).not.toContain("{gray-fg}Loop:{/gray-fg}");
  });
});

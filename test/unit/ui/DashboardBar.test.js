"use strict";

const { buildDashboardRows } = require("../../../src/ui/components/DashboardBar");
const { createDashboardBar } = require("../../../src/ui/components/DashboardBar");

describe("Ink DashboardBar view model", () => {
  const getAgentLabel = (id) => ({ "codex:a": "builder", "claude:b": "reviewer" }[id] || id);
  const getAgentState = (id) => ({ "codex:a": "working", "claude:b": "waiting_input" }[id] || "");

  test("normal input mode renders blessed-style summary row", () => {
    const rows = buildDashboardRows({
      focusMode: "input",
      activeAgents: ["codex:a", "claude:b", "codex:c", "codex:d"],
      getAgentLabel,
      getAgentState,
      launchMode: "tmux",
      agentProvider: "claude-cli",
      cronTasks: [{ id: "c1" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("summary");
    expect(rows[0].parts).toEqual([
      { label: "Agents", value: "*@builder, ?@reviewer, @codex:c +1" },
      { label: "Mode", value: "tmux" },
      { label: "Agent", value: "claude" },
      { label: "Cron", value: "1" },
    ]);
  });

  test("summary row includes loop summary when controller loop reports metrics", () => {
    const rows = buildDashboardRows({
      focusMode: "input",
      activeAgents: [],
      loopSummary: {
        rounds: 2,
        tool_calls: 3,
        total_tokens: 1200,
        tools: [{ name: "read", count: 2 }, { name: "bash", count: 1 }],
        terminal_reason: "done",
      },
    });

    expect(rows[0].parts).toContainEqual({
      label: "Loop",
      value: "r2 tc3 tok1200 readx2,bashx1 done",
    });
  });

  test("normal dashboard agents row shows selected item and activity markers", () => {
    const rows = buildDashboardRows({
      focusMode: "dashboard",
      dashboardView: "agents",
      activeAgents: ["codex:a", "claude:b"],
      selectedAgentIndex: 1,
      getAgentLabel,
      getAgentState,
      dashHints: { agents: "AGENTS" },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "chips",
        caption: "Agents",
        hint: "AGENTS",
        items: [
          { label: "*@builder", selected: false },
          { label: "?@reviewer", selected: true },
        ],
      }),
    ]);
  });

  test("summary row marks the current target agent as active only", () => {
    const rows = buildDashboardRows({
      focusMode: "input",
      activeAgents: ["codex:a", "claude:b"],
      activeAgentId: "codex:a",
      getAgentLabel,
      getAgentState,
    });

    expect(rows[0].kind).toBe("summary");
    expect(rows[0].agentItems[0]).toEqual({
      label: "*@builder",
      selected: false,
      active: true,
    });
    expect(rows[0].agentItems[1]).toEqual({
      label: "?@reviewer",
      selected: false,
      active: false,
    });
  });

  test("agents detail row marks current target agent active", () => {
    const rows = buildDashboardRows({
      focusMode: "dashboard",
      dashboardView: "agents",
      activeAgents: ["codex:a", "claude:b"],
      activeAgentId: "claude:b",
      selectedAgentIndex: 1,
      getAgentLabel,
      getAgentState,
    });

    expect(rows[0].items[1]).toEqual({
      label: "?@reviewer",
      selected: true,
      active: true,
    });
  });

  test("global projects focus keeps summary on the second row", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      globalScope: "controller",
      focusMode: "dashboard",
      dashboardView: "projects",
      projects: [
        { project_name: "one", project_root: "/one" },
        { project_name: "two", project_root: "/two" },
      ],
      selectedProjectIndex: 0,
      activeProjectRoot: "/two",
      activeAgents: ["codex:a"],
      getAgentLabel,
      getAgentState,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].caption).toBe("Projects");
    expect(rows[0].items[0]).toEqual({ label: "one", selected: true, active: false });
    expect(rows[0].items[1]).toEqual({ label: "two", selected: false, active: true });
    expect(rows[0].hint).toBe("Enter→project");
    expect(rows[1].kind).toBe("summary");
  });

  test("global empty projects keeps project hint on first row and overview on second row", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      globalScope: "controller",
      focusMode: "input",
      dashboardView: "agents",
      projects: [],
      activeAgents: ["codex:a"],
      getAgentLabel,
      getAgentState,
      dashHints: {
        projectsEmpty: "Run ufoo chat or ufoo daemon start in project directories",
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(expect.objectContaining({
      kind: "chips",
      caption: "Projects",
      emptyLabel: "none",
      hint: "Run ufoo chat or ufoo daemon start in project directories",
      items: [],
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      kind: "summary",
      parts: expect.arrayContaining([
        { label: "Agents", value: "*@builder" },
      ]),
    }));
  });

  test("global empty projects keeps agents detail when agents row is focused", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      globalScope: "controller",
      focusMode: "dashboard",
      dashboardView: "agents",
      projects: [],
      activeAgents: ["codex:a"],
      selectedAgentIndex: 0,
      getAgentLabel,
      getAgentState,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].caption).toBe("Projects");
    expect(rows[1]).toEqual(expect.objectContaining({
      caption: "Agents",
      items: [{ label: "*@builder", selected: true }],
    }));
  });

  test("global projects rail fits project count to available width", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      globalScope: "controller",
      focusMode: "dashboard",
      dashboardView: "projects",
      maxWidth: 34,
      projects: [
        { project_name: "alpha", project_root: "/alpha" },
        { project_name: "beta", project_root: "/beta" },
        { project_name: "gamma", project_root: "/gamma" },
      ],
      selectedProjectIndex: 0,
    });
    expect(rows[0].items.map((item) => item.label)).toEqual(["alpha"]);
    expect(rows[0].rightMore).toBe(true);

    const wider = buildDashboardRows({
      globalMode: true,
      globalScope: "controller",
      focusMode: "dashboard",
      dashboardView: "projects",
      maxWidth: 80,
      projects: [
        { project_name: "alpha", project_root: "/alpha" },
        { project_name: "beta", project_root: "/beta" },
        { project_name: "gamma", project_root: "/gamma" },
      ],
      selectedProjectIndex: 0,
    });
    expect(wider[0].items.map((item) => item.label)).toEqual(["alpha", "beta", "gamma"]);
    expect(wider[0].rightMore).toBe(false);
  });

  test("global projects rail keeps an overlong selected project visible when narrow", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      focusMode: "dashboard",
      dashboardView: "projects",
      maxWidth: 20,
      projects: [{ label: "very-long-project-name-that-does-not-fit", root: "/x" }],
      selectedProjectIndex: 0,
    });

    expect(rows[0]).toEqual(expect.objectContaining({
      caption: "Projects",
      hint: "",
      leftMore: false,
      rightMore: false,
    }));
    expect(rows[0].items).toHaveLength(1);
    expect(rows[0].items[0]).toEqual({
      label: "very-lo...",
      selected: true,
      active: false,
    });
  });

  test("global projects rail keeps an overlong active project visible when not focused", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      globalScope: "project",
      focusMode: "input",
      dashboardView: "agents",
      maxWidth: 20,
      activeProjectRoot: "/x",
      projects: [{ label: "very-long-project-name-that-does-not-fit", root: "/x" }],
      selectedProjectIndex: 0,
    });

    expect(rows[0]).toEqual(expect.objectContaining({
      caption: "Projects",
      hint: "",
      leftMore: false,
      rightMore: false,
    }));
    expect(rows[0].items).toEqual([{
      label: "very-lo...",
      selected: false,
      active: true,
    }]);
  });

  test("global projects rail does not scroll to active project until focused", () => {
    const projects = [
      { project_name: "alpha", project_root: "/alpha" },
      { project_name: "beta", project_root: "/beta" },
      { project_name: "gamma", project_root: "/gamma" },
      { project_name: "delta", project_root: "/delta" },
    ];
    const rows = buildDashboardRows({
      globalMode: true,
      globalScope: "project",
      focusMode: "input",
      dashboardView: "agents",
      maxWidth: 26,
      projects,
      selectedProjectIndex: -1,
      activeProjectRoot: "/delta",
    });
    expect(rows[0].caption).toBe("Projects");
    expect(rows[0].leftMore).toBe(false);
    expect(rows[0].rightMore).toBe(true);
    expect(rows[0].items[0].label).toBe("alpha");
  });

  test("global projects rail scrolls to keep selected project visible", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      focusMode: "dashboard",
      dashboardView: "projects",
      maxWidth: 36,
      projects: [
        { project_name: "alpha", project_root: "/alpha" },
        { project_name: "beta", project_root: "/beta" },
        { project_name: "gamma", project_root: "/gamma" },
        { project_name: "delta", project_root: "/delta" },
      ],
      selectedProjectIndex: 2,
    });
    expect(rows[0].items.some((item) => item.label === "gamma" && item.selected)).toBe(true);
  });

  test("global agents focus keeps projects rail and renders agents detail second", () => {
    const rows = buildDashboardRows({
      globalMode: true,
      globalScope: "project",
      focusMode: "dashboard",
      dashboardView: "agents",
      projects: [{ label: "one", root: "/one" }],
      activeProjectRoot: "/one",
      activeAgents: ["codex:a"],
      selectedAgentIndex: 0,
      getAgentLabel,
      getAgentState,
      dashHints: { agentsGlobal: "GLOBAL AGENTS" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].caption).toBe("Projects");
    expect(rows[0].items[0].active).toBe(true);
    expect(rows[1]).toEqual(expect.objectContaining({
      caption: "Agents",
      hint: "GLOBAL AGENTS",
      items: [{ label: "*@builder", selected: true }],
    }));
  });

  test("provider detail uses blessed Agent caption", () => {
    const rows = buildDashboardRows({
      focusMode: "dashboard",
      dashboardView: "provider",
      providerOptions: [
        { label: "codex", value: "codex-cli" },
        { label: "claude", value: "claude-cli" },
      ],
      selectedProviderIndex: 1,
    });
    expect(rows[0].caption).toBe("Agent");
    expect(rows[0].items[1]).toEqual({ label: "claude", selected: true });
  });

  test("DashboardBar render path accepts maxWidth", () => {
    const React = require("react");
    const ink = {
      Box: "box",
      Text: "text",
    };
    const DashboardBar = createDashboardBar({ React, ink });
    expect(() => DashboardBar({
      globalMode: true,
      focusMode: "dashboard",
      dashboardView: "projects",
      maxWidth: 40,
      projects: [{ label: "alpha", root: "/alpha" }],
      selectedProjectIndex: 0,
    })).not.toThrow();
  });

  test("mode detail row drops the long hint and uses overflow markers when narrow", () => {
    const rows = buildDashboardRows({
      focusMode: "dashboard",
      dashboardView: "mode",
      maxWidth: 22,
      modeOptions: ["auto", "host", "terminal", "tmux", "internal"],
      selectedModeIndex: 3,
      dashHints: { mode: "←/→ select · Enter · ↓ provider · ↑ back" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].caption).toBe("Mode");
    expect(rows[0].hint).toBe("");
    expect(rows[0].leftMore || rows[0].rightMore).toBe(true);
    expect(rows[0].items.some((item) => item.selected)).toBe(true);
  });

  test("provider detail row keeps selected option even with budget pressure", () => {
    const rows = buildDashboardRows({
      focusMode: "dashboard",
      dashboardView: "provider",
      maxWidth: 18,
      providerOptions: [
        { label: "codex", value: "codex-cli" },
        { label: "claude", value: "claude-cli" },
        { label: "ucode", value: "ufoo-code" },
      ],
      selectedProviderIndex: 2,
      dashHints: { provider: "←/→ select · Enter · ↓ cron · ↑ back" },
    });
    const selected = rows[0].items.find((item) => item.selected);
    expect(selected).toBeTruthy();
    expect(selected.label).toBe("ucode");
  });

  test("agents detail scrolls labels around selection inside the budget", () => {
    const rows = buildDashboardRows({
      focusMode: "dashboard",
      dashboardView: "agents",
      maxWidth: 30,
      activeAgents: ["a:1", "a:2", "a:3", "a:4", "a:5", "a:6"],
      selectedAgentIndex: 5,
      maxAgentWindow: 4,
      getAgentLabel: (id) => id.slice(2),
      getAgentState: () => "",
      dashHints: { agents: "long-hint-that-may-not-fit" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].items.some((item) => item.selected)).toBe(true);
    expect(rows[0].leftMore || rows[0].rightMore).toBe(true);
  });
});

const {
  computeDashboardContent,
  providerLabel,
  assistantLabel,
} = require("../../../src/chat/dashboardView");

describe("chat dashboardView", () => {
  const dashHints = {
    agents: "AGENTS",
    agentsEmpty: "EMPTY",
    mode: "MODE",
    provider: "PROVIDER",
    resume: "RESUME",
  };

  test("providerLabel maps provider ids", () => {
    expect(providerLabel("claude-cli")).toBe("claude");
    expect(providerLabel("codex-cli")).toBe("codex");
    expect(providerLabel("unknown")).toBe("codex");
  });

  test("assistantLabel maps assistant engine ids", () => {
    expect(assistantLabel("auto")).toBe("auto");
    expect(assistantLabel("codex")).toBe("codex");
    expect(assistantLabel("claude")).toBe("claude");
    expect(assistantLabel("ufoo")).toBe("ucode");
    expect(assistantLabel("ucode")).toBe("ucode");
    expect(assistantLabel("unknown")).toBe("auto");
  });

  test("normal mode renders summary line without reports counter", () => {
    const out = computeDashboardContent({
      focusMode: "input",
      activeAgents: ["a", "b", "c", "d"],
      getAgentLabel: (id) => `@${id}`,
      launchMode: "tmux",
      agentProvider: "claude-cli",
      assistantEngine: "ufoo",
      cronTasks: [{ id: "c1", summary: "c1@10s->a: smoke" }, { id: "c2", summary: "c2@5m->b: check" }],
      autoResume: false,
      dashHints,
    });

    expect(out.windowStart).toBe(0);
    expect(out.content).toContain("{gray-fg}Agents:{/gray-fg} {cyan-fg}@a, @b, @c +1{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Mode:{/gray-fg} {cyan-fg}tmux{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Agent:{/gray-fg} {cyan-fg}claude{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Assistant:{/gray-fg} {cyan-fg}ucode{/cyan-fg}");
    expect(out.content).toContain("{gray-fg}Cron:{/gray-fg} {cyan-fg}2{/cyan-fg}");
    expect(out.content).not.toContain("{gray-fg}Reports:{/gray-fg}");
  });

  test("dashboard mode page highlights selected mode", () => {
    const out = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "mode",
      selectedModeIndex: 1,
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

  test("provider/assistant/resume pages highlight selected options", () => {
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

    const assistantOut = computeDashboardContent({
      focusMode: "dashboard",
      dashboardView: "assistant",
      assistantOptions: [
        { label: "auto", value: "auto" },
        { label: "codex", value: "codex" },
        { label: "ucode", value: "ufoo" },
      ],
      selectedAssistantIndex: 2,
      dashHints: { ...dashHints, assistant: "ASSISTANT" },
    });
    expect(assistantOut.content).toContain("{inverse}ucode{/inverse}");
    expect(assistantOut.content).toContain("{gray-fg}│ ASSISTANT{/gray-fg}");

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
      cronTasks: [
        { id: "c1", summary: "c1@10s->codex:1: run smoke" },
        { id: "c2", summary: "c2@1m->claude:2: check logs" },
      ],
      dashHints: { ...dashHints, cron: "CRON" },
    });
    expect(out.content).toContain("{gray-fg}Cron:{/gray-fg}");
    expect(out.content).toContain("c1@10s->codex:1: run smoke");
    expect(out.content).toContain("c2@1m->claude:2: check logs");
    expect(out.content).toContain("{gray-fg}│ CRON{/gray-fg}");
  });
});

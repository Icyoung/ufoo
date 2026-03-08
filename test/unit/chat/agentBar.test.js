const { computeAgentBar } = require("../../../src/chat/agentBar");
const { stripAnsi } = require("../../../src/chat/text");

describe("chat agentBar", () => {
  test("renders ucode + none when there are no agents", () => {
    const result = computeAgentBar({
      cols: 80,
      hintText: "↓ agents",
      focusMode: "input",
      selectedAgentIndex: -1,
      activeAgents: [],
      viewingAgent: null,
      agentListWindowStart: 0,
      maxAgentWindow: 4,
      getAgentLabel: (id) => id,
    });

    expect(stripAnsi(result.bar)).toContain("ucode");
    expect(stripAnsi(result.bar)).toContain("none");
    expect(result.windowStart).toBe(0);
    expect(stripAnsi(result.bar).length).toBe(80);
  });

  test("adjusts window start to keep selected agent visible", () => {
    const activeAgents = ["a:1", "b:2", "c:3", "d:4", "e:5", "f:6"];
    const result = computeAgentBar({
      cols: 120,
      hintText: "←/→",
      focusMode: "dashboard",
      selectedAgentIndex: 6, // includes ucode(0), so selects f:6
      activeAgents,
      viewingAgent: "a:1",
      agentListWindowStart: 0,
      maxAgentWindow: 4,
      getAgentLabel: (id) => id,
    });

    expect(result.windowStart).toBe(2);
    expect(stripAnsi(result.bar)).toContain("f:6");
  });

  test("truncates output to terminal width", () => {
    const activeAgents = ["agent-very-long-name-1", "agent-very-long-name-2"];
    const result = computeAgentBar({
      cols: 24,
      hintText: "hint",
      focusMode: "dashboard",
      selectedAgentIndex: 1,
      activeAgents,
      viewingAgent: null,
      agentListWindowStart: 0,
      maxAgentWindow: 4,
      getAgentLabel: (id) => id,
    });

    expect(stripAnsi(result.bar).length).toBe(24);
  });

  describe("activity state indicators", () => {
    test("shows * for working agent", () => {
      const result = computeAgentBar({
        cols: 80,
        hintText: "",
        focusMode: "input",
        activeAgents: ["a:1"],
        agentStates: { "a:1": "working" },
        getAgentLabel: () => "builder",
      });
      expect(stripAnsi(result.bar)).toContain("*builder");
    });

    test("shows ? for waiting_input agent", () => {
      const result = computeAgentBar({
        cols: 80,
        hintText: "",
        focusMode: "input",
        activeAgents: ["a:1"],
        agentStates: { "a:1": "waiting_input" },
        getAgentLabel: () => "builder",
      });
      expect(stripAnsi(result.bar)).toContain("?builder");
      // Should have yellow color
      expect(result.bar).toContain("\x1b[33m?");
    });

    test("shows ! for blocked agent", () => {
      const result = computeAgentBar({
        cols: 80,
        hintText: "",
        focusMode: "input",
        activeAgents: ["a:1"],
        agentStates: { "a:1": "blocked" },
        getAgentLabel: () => "builder",
      });
      expect(stripAnsi(result.bar)).toContain("!builder");
      // Should have red color
      expect(result.bar).toContain("\x1b[31m!");
    });

    test("shows no indicator for idle/ready agents", () => {
      const result = computeAgentBar({
        cols: 80,
        hintText: "",
        focusMode: "input",
        activeAgents: ["a:1"],
        agentStates: { "a:1": "idle" },
        getAgentLabel: () => "builder",
      });
      const bar = stripAnsi(result.bar);
      expect(bar).toContain("builder");
      expect(bar).not.toContain("*builder");
      expect(bar).not.toContain("?builder");
      expect(bar).not.toContain("!builder");
    });

    test("clears indicator when state returns to idle", () => {
      // Simulate: first render with blocked, then re-render with idle
      const blocked = computeAgentBar({
        cols: 80,
        hintText: "",
        focusMode: "input",
        activeAgents: ["a:1"],
        agentStates: { "a:1": "blocked" },
        getAgentLabel: () => "builder",
      });
      expect(stripAnsi(blocked.bar)).toContain("!builder");

      const idle = computeAgentBar({
        cols: 80,
        hintText: "",
        focusMode: "input",
        activeAgents: ["a:1"],
        agentStates: { "a:1": "idle" },
        getAgentLabel: () => "builder",
      });
      expect(stripAnsi(idle.bar)).not.toContain("!builder");
      expect(stripAnsi(idle.bar)).toContain("builder");
    });

    test("handles multiple agents with different states", () => {
      const result = computeAgentBar({
        cols: 120,
        hintText: "",
        focusMode: "input",
        activeAgents: ["a:1", "b:2"],
        agentStates: { "a:1": "working", "b:2": "blocked" },
        getAgentLabel: (id) => id === "a:1" ? "alpha" : "beta",
      });
      const bar = stripAnsi(result.bar);
      expect(bar).toContain("*alpha");
      expect(bar).toContain("!beta");
    });
  });
});

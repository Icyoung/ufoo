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
});

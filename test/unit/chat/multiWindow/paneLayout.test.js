const { calculatePaneLayout } = require("../../../../src/app/chat/multiWindow/paneLayout");

describe("paneLayout", () => {
  test("0 agents returns full-width chat pane", () => {
    const { chatPane, agentPanes, separatorPane, statusPane, inputPane, inputSepPane, dashboardPane } = calculatePaneLayout(120, 40, 0);
    expect(chatPane).toEqual({ top: 0, left: 0, width: 120, height: 34 });
    expect(agentPanes).toHaveLength(0);
    expect(separatorPane).toEqual({ top: 35, left: 0, width: 120 });
    expect(statusPane).toEqual({ top: 34, left: 0, width: 120 });
    expect(inputPane).toEqual({ top: 36, left: 0, width: 120 });
    expect(inputSepPane).toEqual({ top: 37, left: 0, width: 120 });
    expect(dashboardPane).toEqual({ top: 38, left: 0, width: 120 });
  });

  test("1 agent gets full right area", () => {
    const { chatPane, agentPanes } = calculatePaneLayout(120, 40, 1);
    expect(chatPane.width).toBe(40);
    expect(chatPane.top).toBe(0);
    expect(agentPanes).toHaveLength(1);
    expect(agentPanes[0].left).toBe(41);
    expect(agentPanes[0].width).toBe(79);
    expect(agentPanes[0].top).toBe(0);
    expect(agentPanes[0].height).toBe(34);
  });

  test("2 agents split top/bottom", () => {
    const { agentPanes } = calculatePaneLayout(120, 40, 2);
    expect(agentPanes).toHaveLength(2);
    expect(agentPanes[0].top).toBe(0);
    expect(agentPanes[1].top).toBe(17);
    expect(agentPanes[0].height).toBe(17);
  });

  test("3 agents: 1 top, 2 bottom", () => {
    const { agentPanes } = calculatePaneLayout(120, 40, 3);
    expect(agentPanes).toHaveLength(3);
    expect(agentPanes[0].top).toBe(0);
    expect(agentPanes[1].top).toBe(17);
    expect(agentPanes[2].top).toBe(17);
    expect(agentPanes[1].left).not.toBe(agentPanes[2].left);
  });

  test("4 agents: 2x2 grid", () => {
    const { agentPanes } = calculatePaneLayout(120, 40, 4);
    expect(agentPanes).toHaveLength(4);
    expect(agentPanes[0].top).toBe(0);
    expect(agentPanes[1].top).toBe(0);
    expect(agentPanes[2].top).toBe(17);
    expect(agentPanes[3].top).toBe(17);
  });

  test("terminal too small returns no agent panes", () => {
    const { chatPane, agentPanes } = calculatePaneLayout(10, 2, 2);
    expect(chatPane.width).toBe(10);
    expect(agentPanes).toHaveLength(0);
  });
});

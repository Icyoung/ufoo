"use strict";

const {
  loadGlobalProjectRows,
  cronTasksFromStatus,
  formatLoopSummary,
  buildDashboardPublishPayload,
} = require("../../../src/ui/dashboardBridge");

describe("dashboardBridge", () => {
  test("cronTasksFromStatus maps tasks", () => {
    const tasks = cronTasksFromStatus({
      cron: { tasks: [{ id: "c1", label: "nightly" }] },
    });
    expect(tasks).toEqual([{ id: "c1", label: "nightly", summary: "" }]);
  });

  test("formatLoopSummary returns empty for blank loop", () => {
    expect(formatLoopSummary(null)).toBe("");
    expect(formatLoopSummary({ rounds: 2, tool_calls: 1, total_tokens: 10 })).toContain("r2");
  });

  test("loadGlobalProjectRows returns an array", () => {
    expect(Array.isArray(loadGlobalProjectRows(process.cwd()))).toBe(true);
  });

  test("buildDashboardPublishPayload includes agents footer", () => {
    const controller = {
      getAgentsSnapshot: () => ({
        agents: [{ id: "codex:1", label: "one" }],
        footer: "one",
        loop: null,
      }),
    };
    const payload = buildDashboardPublishPayload(controller, {
      cron: { tasks: [{ id: "a", name: "job" }] },
      loop: { rounds: 1, tool_calls: 0, total_tokens: 0 },
    });
    expect(payload.agents).toHaveLength(1);
    expect(payload.cron[0].id).toBe("a");
    expect(payload.loop_summary).toContain("r1");
  });
});

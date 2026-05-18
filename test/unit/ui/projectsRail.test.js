"use strict";

const { planProjectsRail, displayCellWidth } = require("../../../src/ui/format");

describe("planProjectsRail", () => {
  test("empty input is a no-op", () => {
    expect(planProjectsRail({ labels: [] })).toEqual({
      items: [],
      windowStart: 0,
      leftMore: false,
      rightMore: false,
    });
  });

  test("everything fits when budget is generous", () => {
    const plan = planProjectsRail({ labels: ["a", "b", "c"], selectedIndex: 1, maxCells: 100 });
    expect(plan.items.map((i) => i.label)).toEqual(["a", "b", "c"]);
    expect(plan.leftMore).toBe(false);
    expect(plan.rightMore).toBe(false);
    expect(plan.windowStart).toBe(0);
  });

  test("items past the budget become a > arrow", () => {
    const plan = planProjectsRail({ labels: ["aa", "bb", "cc", "dd"], selectedIndex: 0, maxCells: 8 });
    expect(plan.leftMore).toBe(false);
    expect(plan.rightMore).toBe(true);
    expect(plan.items.length).toBeGreaterThan(0);
    const totalWidth = plan.items.reduce((acc, item, idx) =>
      acc + (idx > 0 ? 2 : 0) + displayCellWidth(item.label), 0);
    expect(totalWidth).toBeLessThanOrEqual(8);
  });

  test("window slides forward to keep the selection visible", () => {
    const labels = ["aa", "bb", "cc", "dd", "ee"];
    // Tight budget that fits ~2 labels at a time; selecting index 4 must
    // scroll the window right.
    const plan = planProjectsRail({ labels, selectedIndex: 4, maxCells: 10, windowStart: 0 });
    expect(plan.items.some((i) => i.absoluteIndex === 4)).toBe(true);
    expect(plan.leftMore).toBe(true);
  });

  test("window snaps back when the selection is to the left of windowStart", () => {
    const labels = ["aa", "bb", "cc", "dd"];
    const plan = planProjectsRail({ labels, selectedIndex: 0, windowStart: 2, maxCells: 10 });
    expect(plan.windowStart).toBe(0);
    expect(plan.items[0].absoluteIndex).toBe(0);
  });
});

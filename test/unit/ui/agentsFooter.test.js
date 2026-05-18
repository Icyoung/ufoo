"use strict";

const { planAgentsFooter, displayCellWidth } = require("../../../src/ui/format");

describe("planAgentsFooter", () => {
  test("fits all labels when budget is generous", () => {
    const plan = planAgentsFooter(["@a", "@b", "@c"], -1, 100);
    expect(plan.items.map((i) => i.label)).toEqual(["@a", "@b", "@c"]);
    expect(plan.overflowed).toBe(0);
  });

  test("flags the selected index", () => {
    const plan = planAgentsFooter(["@a", "@b"], 1, 100);
    expect(plan.items[0].selected).toBe(false);
    expect(plan.items[1].selected).toBe(true);
  });

  test("drops items that don't fit and reports the count", () => {
    // budget only fits @aaa (3 + sep accounting); @bbb won't fit.
    const plan = planAgentsFooter(["@aaa", "@bbb"], -1, 4);
    expect(plan.items.length).toBe(1);
    expect(plan.items[0].label).toBe("@aaa");
    expect(plan.overflowed).toBe(1);
  });

  test("truncates a label that almost fits with '...'", () => {
    // Budget fits "@verylonglabel" up to ~10 cells, and we need 3 for '...'.
    const plan = planAgentsFooter(["@verylonglabel"], -1, 8);
    expect(plan.items.length).toBe(1);
    const out = plan.items[0];
    expect(out.truncated).toBe(true);
    expect(out.label.endsWith("...")).toBe(true);
    expect(displayCellWidth(out.label)).toBeLessThanOrEqual(8);
  });

  test("CJK labels are measured by display cells, not chars", () => {
    // 4 cells of CJK take 4 cells (2 chars * 2 cells), so a budget of 5 fits 1.
    const plan = planAgentsFooter(["@中文", "@二号"], -1, 5);
    expect(plan.items.length).toBe(1);
    expect(plan.overflowed).toBe(1);
  });

  test("empty input is a no-op", () => {
    expect(planAgentsFooter([], -1, 80)).toEqual({ items: [], overflowed: 0 });
  });
});

"use strict";

const { planAgentsFooter, displayCellWidth } = require("../../../src/ui/format");

describe("planAgentsFooter", () => {
  test("fits all labels when budget is generous", () => {
    const plan = planAgentsFooter(["@a", "@b", "@c"], -1, 100);
    expect(plan.items.map((i) => i.label)).toEqual(["@a", "@b", "@c"]);
    expect(plan.overflowed).toBe(0);
    expect(plan.hint).toBe("");
  });

  test("flags the selected index", () => {
    const plan = planAgentsFooter(["@a", "@b"], 1, 100);
    expect(plan.items[0].selected).toBe(false);
    expect(plan.items[1].selected).toBe(true);
  });

  test("drops items that don't fit and reports the count via hint", () => {
    const plan = planAgentsFooter(["@aaa", "@bbb", "@ccc"], -1, 12);
    expect(plan.items.length).toBeGreaterThan(0);
    expect(plan.overflowed).toBeGreaterThan(0);
    expect(plan.hint).toMatch(/^ \+\d+ more$/);
  });

  test("truncates a label that almost fits with '...'", () => {
    const plan = planAgentsFooter(["@verylonglabel"], -1, 8);
    expect(plan.items.length).toBe(1);
    const out = plan.items[0];
    expect(out.truncated).toBe(true);
    expect(out.label.endsWith("...")).toBe(true);
    expect(displayCellWidth(out.label)).toBeLessThanOrEqual(8);
    // Single label, no overflow.
    expect(plan.hint).toBe("");
  });

  test("CJK labels are measured by display cells, not chars", () => {
    // budget 12: "@中文"(5) + worst-case " +1 more"(8) = 13 > 12, so even
    // the first label gets refused (we'd rather show "+N more" alone).
    const plan = planAgentsFooter(["@中文", "@二号"], -1, 12);
    expect(plan.items.length).toBeLessThanOrEqual(1);
    expect(plan.overflowed).toBeGreaterThanOrEqual(1);
  });

  test("empty input is a no-op", () => {
    expect(planAgentsFooter([], -1, 80)).toEqual({ items: [], overflowed: 0, hint: "" });
  });

  test("reserves room for the +N more hint up front so trailing label doesn't get popped", () => {
    // 3 items, last one too long to fully fit. Either it gets truncated
    // (preferred when there's enough room for "..."), or it gets dropped
    // and emitted as " +1 more". Either way the rendered total must stay
    // within the budget — that's the invariant we care about.
    const plan = planAgentsFooter(["@x", "@y", "@longname"], -1, 14);
    expect(plan.items.length).toBeGreaterThan(0);
    const itemsWidth = plan.items.reduce((acc, item, idx) =>
      acc + (idx > 0 ? 1 : 0) + displayCellWidth(item.label), 0);
    const totalWidth = itemsWidth + displayCellWidth(plan.hint);
    expect(totalWidth).toBeLessThanOrEqual(14);
  });

  test("when the last label is dropped entirely, hint reports it", () => {
    // budget 12: "@x" fits (2 + 8 = 10 ≤ 12), then "@y" needs 2+1+2+8 = 13 > 12.
    // Truncate of "@y" needs 12-2-1-3-8 = -2, can't, so drop. items=[@x],
    // overflowed=2, hint=" +2 more".
    const plan = planAgentsFooter(["@x", "@y", "@z"], -1, 12);
    expect(plan.items.length).toBe(1);
    expect(plan.overflowed).toBe(2);
    expect(plan.hint).toBe(" +2 more");
  });
});

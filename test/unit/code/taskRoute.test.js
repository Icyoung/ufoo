"use strict";

const { shouldUpgradeToDecomposition } = require("../../../src/code/taskRoute");

describe("shouldUpgradeToDecomposition (R7)", () => {
  test("doc wording with fix does not upgrade", () => {
    const decision = shouldUpgradeToDecomposition("fix documentation wording in README");
    expect(decision.upgrade).toBe(false);
    expect(decision.reason).toBe("direct_default");
  });

  test("chinese explicit decompose upgrades", () => {
    const decision = shouldUpgradeToDecomposition("请拆解这个需求并分步实现登录与支付");
    expect(decision.upgrade).toBe(true);
    expect(decision.reasons).toContain("explicit_decompose_request");
  });

  test("english numbered multi-goal upgrades", () => {
    const decision = shouldUpgradeToDecomposition(
      "Please do the following:\n1. Add auth\n2. Add billing\n3. Add audits"
    );
    expect(decision.upgrade).toBe(true);
    expect(decision.reasons).toContain("multiple_listed_goals");
  });

  test("forceDirect wins over explicit request", () => {
    const decision = shouldUpgradeToDecomposition("请拆解任务", { forceDirect: true });
    expect(decision.upgrade).toBe(false);
    expect(decision.reason).toBe("forced_direct");
  });

  test("disableDecomposition keeps direct", () => {
    const decision = shouldUpgradeToDecomposition("1. a\n2. b", { disableDecomposition: true });
    expect(decision.upgrade).toBe(false);
  });
});

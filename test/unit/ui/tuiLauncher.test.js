"use strict";

const {
  normalizeTuiMode,
  resolveTuiLaunchPlan,
} = require("../../../src/ui/tuiLauncher");

describe("tuiLauncher", () => {
  const original = process.env.UFOO_TUI;
  const originalBin = process.env.UFOO_TUI_BIN;

  afterEach(() => {
    if (original == null) delete process.env.UFOO_TUI;
    else process.env.UFOO_TUI = original;
    if (originalBin == null) delete process.env.UFOO_TUI_BIN;
    else process.env.UFOO_TUI_BIN = originalBin;
  });

  test("normalizeTuiMode defaults to auto", () => {
    delete process.env.UFOO_TUI;
    expect(normalizeTuiMode()).toBe("auto");
    expect(normalizeTuiMode("RUST")).toBe("rust");
  });

  test("unknown values normalize to auto", () => {
    expect(normalizeTuiMode("ink")).toBe("auto");
    expect(normalizeTuiMode("whatever")).toBe("auto");
  });

  test("rust mode errors when binary missing", () => {
    process.env.UFOO_TUI_BIN = "/tmp/ufoo-tui-does-not-exist";
    const plan = resolveTuiLaunchPlan({ mode: "rust" });
    expect(plan.mode).toBe("error");
    expect(plan.reason).toBe("binary_missing");
  });

  test("auto errors without binary", () => {
    process.env.UFOO_TUI_BIN = "/tmp/ufoo-tui-does-not-exist";
    const plan = resolveTuiLaunchPlan({ mode: "auto" });
    expect(plan.mode).toBe("error");
    expect(plan.reason).toBe("binary_missing");
  });
});

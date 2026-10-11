"use strict";

const { resolveToolBudget, resolveTaskTimeoutMs } = require("../../../src/agents/runtime/core/executionBudget");

describe("shared main and coding execution budgets", () => {
  test("defaults to unlimited tools, 20 errors and a 12-hour deadline", () => {
    expect(resolveToolBudget(undefined, {})).toEqual({ maxToolCalls: null, maxToolErrors: 20 });
    expect(resolveTaskTimeoutMs(undefined, {})).toBe(43200000);
  });

  test("explicit ucode options take precedence over shared environment settings", () => {
    const env = { UFOO_UCODE_MAX_TOOL_CALLS: "200", UFOO_UCODE_MAX_TOOL_ERRORS: "30", UFOO_UCODE_TASK_TIMEOUT_MS: "3600000" };
    expect(resolveToolBudget(undefined, env)).toEqual({ maxToolCalls: 200, maxToolErrors: 30 });
    expect(resolveToolBudget(null, env).maxToolCalls).toBeNull();
    expect(resolveToolBudget(10, env).maxToolCalls).toBe(10);
    expect(resolveTaskTimeoutMs(undefined, env)).toBe(3600000);
    expect(resolveTaskTimeoutMs(45000, env)).toBe(45000);
    expect(resolveTaskTimeoutMs(10, env)).toBe(1000);
  });

  test("invalid error and timeout settings retain the existing defaults", () => {
    const env = { UFOO_UCODE_MAX_TOOL_ERRORS: "0", UFOO_UCODE_TASK_TIMEOUT_MS: "invalid" };
    expect(resolveToolBudget(undefined, env).maxToolErrors).toBe(20);
    expect(resolveTaskTimeoutMs(undefined, env)).toBe(43200000);
  });
});

"use strict";

/**
 * Lightweight, framework-free coverage for UcodeApp. We can't render with
 * ink-testing-library here because jest runs in CJS mode and ink/ink-testing-
 * library are ESM-only — that path would force --experimental-vm-modules on
 * the whole suite. The full render path is exercised by
 * scripts/ucode-app-smoke.js (exit=0 in CI).
 *
 * Here we just confirm the factory is callable and produces a React function
 * component.
 */

const { createUcodeApp } = require("../../../src/ui/ink/UcodeApp");

describe("createUcodeApp", () => {
  test("returns a render function when given a React + stub ink namespace", () => {
    const React = require("react");
    const ink = {
      Box: () => null,
      Text: () => null,
      Static: () => null,
      useInput: () => undefined,
      useApp: () => ({ exit: () => {} }),
      useStdout: () => ({ stdout: null }),
    };
    const props = {
      runSingleCommand: () => ({ kind: "empty" }),
      runNaturalLanguageTask: async () => ({ ok: true, summary: "ok" }),
      runUbusCommand: async () => ({ ok: false, error: "stub", summary: "" }),
      formatNlResult: () => "ok",
      workspaceRoot: "/tmp/ufoo-test",
      state: { model: "test-model", sessionId: "ut", engine: "ufoo-core" },
      autoBus: { enabled: false, getPendingCount: () => 0, subscriberId: "" },
    };
    const UcodeApp = createUcodeApp({ React, ink, props, interactive: false });
    expect(typeof UcodeApp).toBe("function");
    expect(UcodeApp.length).toBeLessThanOrEqual(2);
  });
});

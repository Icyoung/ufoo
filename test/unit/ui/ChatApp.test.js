"use strict";

/**
 * Lightweight, framework-free coverage for ChatApp. Mirrors the UcodeApp
 * test approach: we don't render with ink-testing-library because jest
 * runs in CJS mode and ink is ESM-only — that path would force
 * --experimental-vm-modules on the whole suite. The full render path is
 * exercised by scripts/ucode-app-smoke.js plus real-TTY runs.
 */

const { createChatApp, bootstrapEnvironment } = require("../../../src/ui/components/ChatApp");

describe("createChatApp", () => {
  test("returns a render function for stub React + ink", () => {
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
      activeProjectRoot: "/tmp/ufoo-test",
      globalMode: false,
    };
    const ChatApp = createChatApp({ React, ink, props, interactive: false });
    expect(typeof ChatApp).toBe("function");
  });
});

describe("bootstrapEnvironment", () => {
  test("returns canonical project root and globalMode flag", () => {
    const env = bootstrapEnvironment("/tmp/ufoo-test", { globalMode: false });
    expect(env.globalMode).toBe(false);
    expect(typeof env.activeProjectRoot).toBe("string");
    expect(env.runtimePaths).toBeTruthy();
    // We don't assert needsBootstrap (depends on filesystem state) — the
    // important contract is that the helper is pure-of-side-effects and
    // hands back the modules it found.
    expect(typeof env.UfooInit).toBe("function");
    expect(typeof env.isRunning).toBe("function");
    expect(typeof env.startDaemon).toBe("function");
  });
});

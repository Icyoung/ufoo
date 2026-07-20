"use strict";

const path = require("path");

function withIsolatedKimiBin({ args = [], env = {} } = {}) {
  const launchMock = jest.fn();
  const launcherCtor = jest.fn(() => ({ launch: launchMock }));

  jest.doMock("../../../src/agents/launch/launcher", () => launcherCtor);

  const originalEnv = { ...process.env };
  const originalArgv = process.argv.slice();

  process.argv = [process.execPath, path.resolve(__dirname, "../../../bin/ukimi.js"), ...args];
  Object.assign(process.env, env);

  jest.isolateModules(() => {
    require("../../../bin/ukimi.js");
  });

  const snapshotEnv = { ...process.env };
  process.argv = originalArgv;
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);

  return { launchMock, launcherCtor, env: snapshotEnv };
}

describe("bin/ukimi default bootstrap and arg shaping", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.UFOO_NICKNAME;
    delete process.env.UFOO_PROMPT_PROFILE;
    delete process.env.UFOO_STARTUP_BOOTSTRAP_TEXT;
  });

  test("creates the launcher for agentType kimi and keeps user args untouched", () => {
    const { launchMock, launcherCtor, env } = withIsolatedKimiBin();
    expect(launcherCtor).toHaveBeenCalledWith("kimi", "kimi");
    // kimi has no initial-prompt flag: args stay as-is and the bootstrap is
    // handed to the launcher via UFOO_STARTUP_BOOTSTRAP_TEXT for post-launch
    // PTY injection.
    expect(launchMock).toHaveBeenCalledWith([]);
    expect(env.UFOO_STARTUP_BOOTSTRAP_TEXT).toContain("Session bootstrap for Kimi.");
  });

  test("passes through kimi flags without rewriting them", () => {
    const { launchMock, env } = withIsolatedKimiBin({ args: ["--session", "session_abc-123"] });
    expect(launchMock).toHaveBeenCalledWith(["--session", "session_abc-123"]);
    expect(env.UFOO_STARTUP_BOOTSTRAP_TEXT).toContain("Session bootstrap for Kimi.");
  });

  test("leaves args intact and skips bootstrap for meta commands like --help", () => {
    const { launchMock, env } = withIsolatedKimiBin({ args: ["--help"] });
    expect(launchMock).toHaveBeenCalledWith(["--help"]);
    expect(env.UFOO_STARTUP_BOOTSTRAP_TEXT).toBeUndefined();
  });

  test("extracts ufoo nickname/role params into env and strips them from args", () => {
    const { launchMock, env } = withIsolatedKimiBin({
      args: ["--nickname", "builder", "--role=reviewer", "--yolo"],
    });
    expect(env.UFOO_NICKNAME).toBe("builder");
    expect(env.UFOO_PROMPT_PROFILE).toBe("reviewer");
    expect(launchMock).toHaveBeenCalledWith(["--yolo"]);
  });
});

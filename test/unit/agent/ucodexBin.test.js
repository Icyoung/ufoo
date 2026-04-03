"use strict";

const path = require("path");

function withIsolatedCodexBin({ args = [], env = {} } = {}) {
  const launchMock = jest.fn();
  const launcherCtor = jest.fn(() => ({ launch: launchMock }));

  jest.doMock("../../../src/agent/launcher", () => launcherCtor);

  const originalEnv = { ...process.env };
  const originalArgv = process.argv.slice();

  process.argv = [process.execPath, path.resolve(__dirname, "../../../bin/ucodex.js"), ...args];
  Object.assign(process.env, env);

  jest.isolateModules(() => {
    require("../../../bin/ucodex.js");
  });

  const snapshotEnv = { ...process.env };
  process.argv = originalArgv;
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);

  return {
    launchMock,
    launcherCtor,
    env: snapshotEnv,
  };
}

describe("bin/ucodex default bootstrap", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.UFOO_STARTUP_BOOTSTRAP_TEXT;
  });

  test("sets startup bootstrap for blank launch", () => {
    const { launchMock, env } = withIsolatedCodexBin();
    expect(launchMock).toHaveBeenCalledWith([]);
    expect(env.UFOO_STARTUP_BOOTSTRAP_TEXT).toContain("ufoo ctx decisions -l");
  });

  test("skips startup bootstrap when user already passes args", () => {
    const { launchMock, env } = withIsolatedCodexBin({ args: ["fix the flaky test"] });
    expect(launchMock).toHaveBeenCalledWith(["fix the flaky test"]);
    expect(env.UFOO_STARTUP_BOOTSTRAP_TEXT).toBeUndefined();
  });
});

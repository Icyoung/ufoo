"use strict";

const path = require("path");

function withIsolatedGrokBin({ args = [], env = {} } = {}) {
  const launchMock = jest.fn();
  const launcherCtor = jest.fn(() => ({ launch: launchMock }));

  jest.doMock("../../../src/agents/launch/launcher", () => launcherCtor);

  const originalEnv = { ...process.env };
  const originalArgv = process.argv.slice();

  process.argv = [process.execPath, path.resolve(__dirname, "../../../bin/ugrok.js"), ...args];
  Object.assign(process.env, env);

  jest.isolateModules(() => {
    require("../../../bin/ugrok.js");
  });

  const snapshotEnv = { ...process.env };
  process.argv = originalArgv;
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);

  return { launchMock, launcherCtor, env: snapshotEnv };
}

describe("bin/ugrok default bootstrap and arg shaping", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.UFOO_NICKNAME;
    delete process.env.UFOO_PROMPT_PROFILE;
  });

  test("creates a grok launcher and prepends --rules bootstrap on blank launch", () => {
    const { launchMock, launcherCtor } = withIsolatedGrokBin();
    expect(launcherCtor).toHaveBeenCalledWith("grok", "grok");
    const passed = launchMock.mock.calls[0][0];
    expect(passed[0]).toBe("--rules");
    expect(passed[1]).toContain("Session bootstrap for Grok.");
    expect(passed[1]).toContain("ufoo ctx decisions -l");
  });

  test("preserves user prompt after --rules bootstrap", () => {
    const { launchMock } = withIsolatedGrokBin({ args: ["fix the flaky test"] });
    const passed = launchMock.mock.calls[0][0];
    expect(passed[0]).toBe("--rules");
    expect(passed[1]).toContain("Session bootstrap for Grok.");
    expect(passed[2]).toBe("fix the flaky test");
  });

  test("sets nickname and role env without forwarding wrapper flags", () => {
    const { launchMock, env } = withIsolatedGrokBin({
      args: ["--nickname", "neo", "--role", "review-critic", "review the diff"],
    });
    const passed = launchMock.mock.calls[0][0];
    expect(env.UFOO_NICKNAME).toBe("neo");
    expect(env.UFOO_PROMPT_PROFILE).toBe("review-critic");
    expect(passed).not.toContain("--nickname");
    expect(passed).not.toContain("--role");
    expect(passed).toContain("review the diff");
  });

  test("leaves meta command args intact", () => {
    const { launchMock } = withIsolatedGrokBin({ args: ["doctor"] });
    expect(launchMock).toHaveBeenCalledWith(["doctor"]);
  });
});

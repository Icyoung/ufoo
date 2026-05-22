"use strict";

const path = require("path");

function withIsolatedAgyBin({ args = [], env = {} } = {}) {
  const launchMock = jest.fn();
  const launcherCtor = jest.fn(() => ({ launch: launchMock }));

  jest.doMock("../../../src/agent/launcher", () => launcherCtor);
  // Stub the previous-conversation reader so the bin doesn't try to touch
  // a real .ufoo/agent/all-agents.json on disk.
  jest.doMock("../../../src/agent/agyConversation", () => {
    const actual = jest.requireActual("../../../src/agent/agyConversation");
    return {
      ...actual,
      readPreviousConversationId: jest.fn(() => ""),
    };
  });

  const originalEnv = { ...process.env };
  const originalArgv = process.argv.slice();

  process.argv = [process.execPath, path.resolve(__dirname, "../../../bin/uagy.js"), ...args];
  Object.assign(process.env, env);

  jest.isolateModules(() => {
    require("../../../bin/uagy.js");
  });

  const snapshotEnv = { ...process.env };
  process.argv = originalArgv;
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);

  return { launchMock, launcherCtor, env: snapshotEnv };
}

describe("bin/uagy default bootstrap and arg shaping", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.UFOO_LAUNCH_MODE;
    delete process.env.UFOO_STARTUP_BOOTSTRAP_TEXT;
  });

  test("prepends -i <bootstrap> on a blank launch", () => {
    const { launchMock, launcherCtor } = withIsolatedAgyBin();
    // AgentLauncher should be created with agentType="agy", command="agy"
    expect(launcherCtor).toHaveBeenCalledWith("agy", "agy");
    const passed = launchMock.mock.calls[0][0];
    expect(passed[0]).toBe("-i");
    expect(passed[1]).toContain("Session bootstrap for Agy.");
  });

  test("merges bootstrap into existing -i text from the user", () => {
    const { launchMock } = withIsolatedAgyBin({ args: ["-i", "review the diff"] });
    const passed = launchMock.mock.calls[0][0];
    expect(passed[0]).toBe("-i");
    expect(passed[1]).toContain("review the diff");
    expect(passed[1]).toContain("Session bootstrap for Agy.");
  });

  test("adds --dangerously-skip-permissions when running in internal launch mode", () => {
    const { launchMock } = withIsolatedAgyBin({
      args: [],
      env: { UFOO_LAUNCH_MODE: "internal" },
    });
    const passed = launchMock.mock.calls[0][0];
    // Order of flags doesn't matter to agy's parser; just assert both made it.
    expect(passed).toContain("--dangerously-skip-permissions");
    expect(passed).toContain("-i");
    const promptIndex = passed.indexOf("-i") + 1;
    expect(passed[promptIndex]).toContain("Session bootstrap for Agy.");
  });

  test("omits --dangerously-skip-permissions for terminal launch mode", () => {
    const { launchMock } = withIsolatedAgyBin({
      args: [],
      env: { UFOO_LAUNCH_MODE: "terminal" },
    });
    const passed = launchMock.mock.calls[0][0];
    expect(passed).not.toContain("--dangerously-skip-permissions");
  });

  test("leaves args intact for meta commands like --help", () => {
    const { launchMock } = withIsolatedAgyBin({ args: ["--help"] });
    expect(launchMock).toHaveBeenCalledWith(["--help"]);
  });
});

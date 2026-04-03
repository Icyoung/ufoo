"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function withIsolatedClaudeBin({ args = [], env = {} } = {}) {
  const launchMock = jest.fn();
  const launcherCtor = jest.fn(() => ({ launch: launchMock }));

  jest.doMock("../../../src/agent/launcher", () => launcherCtor);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-uclaude-bin-"));
  const originalEnv = { ...process.env };
  const originalArgv = process.argv.slice();
  const originalCwd = process.cwd();

  process.argv = [process.execPath, path.resolve(__dirname, "../../../bin/uclaude.js"), ...args];
  process.chdir(cwd);
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv, env);

  jest.isolateModules(() => {
    require("../../../bin/uclaude.js");
  });

  process.argv = originalArgv;
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);

  return {
    cwd,
    launchMock,
    launcherCtor,
  };
}

describe("bin/uclaude default bootstrap", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test("adds append-system-prompt by default", () => {
    const { cwd, launchMock } = withIsolatedClaudeBin();
    try {
      const launchArgs = launchMock.mock.calls[0][0];
      expect(launchArgs).toEqual([
        "--append-system-prompt",
        expect.stringContaining(path.join("claude-code", "default-bootstrap.md")),
      ]);
      const promptFile = launchArgs[1];
      expect(fs.existsSync(promptFile)).toBe(true);
      expect(fs.readFileSync(promptFile, "utf8")).toContain("ufoo ctx decisions -l");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not add bootstrap when help flag is used", () => {
    const { cwd, launchMock } = withIsolatedClaudeBin({ args: ["--help"] });
    try {
      expect(launchMock).toHaveBeenCalledWith(["--help"]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

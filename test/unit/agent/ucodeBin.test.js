const fs = require("fs");
const os = require("os");
const path = require("path");

const { EventEmitter } = require("events");

async function withIsolatedBinMocks({
  resolved,
  runtimePrepared = {},
  bootstrapImpl = () => {},
  setupImpl = async () => ({ prompted: false }),
} = {}) {
  const launchMock = jest.fn();
  const spawnMock = jest.fn((cmd, args) => {
    launchMock(args);
    const child = new EventEmitter();
    return child;
  });
  const resolveUcodeLaunchMock = jest.fn(() => resolved);
  const prepareUcodeRuntimeConfigMock = jest.fn(() => runtimePrepared);
  const prepareUcodeBootstrapMock = jest.fn(bootstrapImpl);
  const setupMock = jest.fn(setupImpl);

  jest.doMock("child_process", () => ({
    ...jest.requireActual("child_process"),
    spawn: spawnMock,
  }));
  jest.doMock("../../../src/app/cli/setupCommands", () => ({
    maybeRunFirstTimeSetup: setupMock,
  }));

  jest.doMock("../../../src/code/launcher/ucode", () => ({
    resolveUcodeLaunch: resolveUcodeLaunchMock,
  }));
  jest.doMock("../../../src/code/launcher/ucodeRuntimeConfig", () => ({
    prepareUcodeRuntimeConfig: prepareUcodeRuntimeConfigMock,
  }));
  jest.doMock("../../../src/code/launcher/ucodeBootstrap", () => ({
    prepareUcodeBootstrap: prepareUcodeBootstrapMock,
  }));

  await jest.isolateModulesAsync(async () => {
    require("../../../bin/ucode.js");
    // The launcher must wait for optional setup, including its failure path.
    expect(launchMock).not.toHaveBeenCalled();
    await setupMock.mock.results[0].value.catch(() => {});
  });

  return {
    launchMock,
    spawnMock,
    setupMock,
    resolveUcodeLaunchMock,
    prepareUcodeRuntimeConfigMock,
    prepareUcodeBootstrapMock,
  };
}

describe("bin/ucode launch guards", () => {
  const originalArgv = process.argv.slice();
  const originalStartupBootstrap = process.env.UFOO_STARTUP_BOOTSTRAP_TEXT;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.argv = [process.execPath, path.resolve(__dirname, "../../../bin/ucode.js")];
  });

  afterEach(() => {
    process.argv = originalArgv;
    delete process.env.UFOO_UCODE_BOOTSTRAP_FILE;
    delete process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT;
    delete process.env.UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE;
    if (originalStartupBootstrap === undefined) delete process.env.UFOO_STARTUP_BOOTSTRAP_TEXT;
    else process.env.UFOO_STARTUP_BOOTSTRAP_TEXT = originalStartupBootstrap;
  });

  test("drops inherited CLI-wrapper bootstrap while preserving ucode's system-prompt arguments", async () => {
    process.env.UFOO_STARTUP_BOOTSTRAP_TEXT = "Session bootstrap for Codex.";
    const args = ["--append-system-prompt", "/tmp/ucode-system.md"];
    const { launchMock } = await withIsolatedBinMocks({
      resolved: { agentType: "ucode", command: process.execPath, args, env: {} },
    });
    expect(process.env.UFOO_STARTUP_BOOTSTRAP_TEXT).toBeUndefined();
    expect(launchMock).toHaveBeenCalledWith(args);
  });

  test.each([false, true])("launches once after asynchronous optional setup settles (reject=%s)", async (reject) => {
    const args = ["--help"];
    const { launchMock, setupMock } = await withIsolatedBinMocks({
      resolved: { agentType: "ucode", command: process.execPath, args, env: {} },
      setupImpl: async () => {
        await Promise.resolve();
        if (reject) throw new Error("optional setup unavailable");
        return { prompted: true };
      },
    });
    expect(setupMock).toHaveBeenCalledWith({ surface: "ucode", argv: [] });
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(launchMock).toHaveBeenCalledWith(args);
  });

  test("removes append-system-prompt when bootstrap preparation fails in auto mode", async () => {
    const bootstrapFile = "/tmp/ufoo-nonexistent-bootstrap-auto.md";
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const resolved = {
      agentType: "ucode",
      command: "pi",
      args: ["--help", "--append-system-prompt", bootstrapFile],
      env: {
        UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "auto",
      },
    };

    const { launchMock } = await withIsolatedBinMocks({
      resolved,
      bootstrapImpl: () => {
        throw new Error("prepare failed");
      },
    });

    expect(launchMock).toHaveBeenCalledWith(["--help"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("keeps append-system-prompt when mode is always even if bootstrap preparation fails", async () => {
    const bootstrapFile = "/tmp/ufoo-nonexistent-bootstrap-always.md";
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const resolved = {
      agentType: "ucode",
      command: "pi",
      args: ["--help", "--append-system-prompt", bootstrapFile],
      env: {
        UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "always",
      },
    };

    const { launchMock } = await withIsolatedBinMocks({
      resolved,
      bootstrapImpl: () => {
        throw new Error("prepare failed");
      },
    });

    expect(launchMock).toHaveBeenCalledWith(["--help", "--append-system-prompt", bootstrapFile]);
    errorSpy.mockRestore();
  });

  test("preserves custom append-system-prompt when bootstrap fails in auto mode", async () => {
    const bootstrapFile = "/tmp/ufoo-nonexistent-bootstrap-custom.md";
    const customFile = path.join(os.tmpdir(), `ufoo-custom-append-${Date.now()}.md`);
    fs.writeFileSync(customFile, "# custom append\n", "utf8");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const resolved = {
      agentType: "ucode",
      command: "pi",
      args: ["--help", "--append-system-prompt", customFile],
      env: {
        UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT: customFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "auto",
      },
    };

    const { launchMock } = await withIsolatedBinMocks({
      resolved,
      bootstrapImpl: () => {
        throw new Error("prepare failed");
      },
    });

    expect(launchMock).toHaveBeenCalledWith(["--help", "--append-system-prompt", customFile]);
    errorSpy.mockRestore();
    fs.rmSync(customFile, { force: true });
  });
});

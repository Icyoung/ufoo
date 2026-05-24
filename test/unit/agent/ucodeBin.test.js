const fs = require("fs");
const os = require("os");
const path = require("path");

function withIsolatedBinMocks({
  resolved,
  runtimePrepared = {},
  bootstrapImpl = () => {},
} = {}) {
  const launchMock = jest.fn();
  const launcherCtor = jest.fn(() => ({ launch: launchMock }));
  const resolveUcodeLaunchMock = jest.fn(() => resolved);
  const prepareUcodeRuntimeConfigMock = jest.fn(() => runtimePrepared);
  const prepareUcodeBootstrapMock = jest.fn(bootstrapImpl);

  jest.doMock("../../../src/agents/launch/launcher", () => launcherCtor);
  jest.doMock("../../../src/code/launcher/ucode", () => ({
    resolveUcodeLaunch: resolveUcodeLaunchMock,
  }));
  jest.doMock("../../../src/code/launcher/ucodeRuntimeConfig", () => ({
    prepareUcodeRuntimeConfig: prepareUcodeRuntimeConfigMock,
  }));
  jest.doMock("../../../src/code/launcher/ucodeBootstrap", () => ({
    prepareUcodeBootstrap: prepareUcodeBootstrapMock,
  }));

  jest.isolateModules(() => {
    require("../../../bin/ucode.js");
  });

  return {
    launchMock,
    launcherCtor,
    resolveUcodeLaunchMock,
    prepareUcodeRuntimeConfigMock,
    prepareUcodeBootstrapMock,
  };
}

describe("bin/ucode launch guards", () => {
  const originalArgv = process.argv.slice();

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
  });

  test("removes append-system-prompt when bootstrap preparation fails in auto mode", () => {
    const bootstrapFile = "/tmp/ufoo-nonexistent-bootstrap-auto.md";
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const resolved = {
      agentType: "ufoo-code",
      command: "pi",
      args: ["--help", "--append-system-prompt", bootstrapFile],
      env: {
        UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "auto",
      },
    };

    const { launchMock } = withIsolatedBinMocks({
      resolved,
      bootstrapImpl: () => {
        throw new Error("prepare failed");
      },
    });

    expect(launchMock).toHaveBeenCalledWith(["--help"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test("keeps append-system-prompt when mode is always even if bootstrap preparation fails", () => {
    const bootstrapFile = "/tmp/ufoo-nonexistent-bootstrap-always.md";
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const resolved = {
      agentType: "ufoo-code",
      command: "pi",
      args: ["--help", "--append-system-prompt", bootstrapFile],
      env: {
        UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "always",
      },
    };

    const { launchMock } = withIsolatedBinMocks({
      resolved,
      bootstrapImpl: () => {
        throw new Error("prepare failed");
      },
    });

    expect(launchMock).toHaveBeenCalledWith(["--help", "--append-system-prompt", bootstrapFile]);
    errorSpy.mockRestore();
  });

  test("preserves custom append-system-prompt when bootstrap fails in auto mode", () => {
    const bootstrapFile = "/tmp/ufoo-nonexistent-bootstrap-custom.md";
    const customFile = path.join(os.tmpdir(), `ufoo-custom-append-${Date.now()}.md`);
    fs.writeFileSync(customFile, "# custom append\n", "utf8");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const resolved = {
      agentType: "ufoo-code",
      command: "pi",
      args: ["--help", "--append-system-prompt", customFile],
      env: {
        UFOO_UCODE_BOOTSTRAP_FILE: bootstrapFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT: customFile,
        UFOO_UCODE_APPEND_SYSTEM_PROMPT_MODE: "auto",
      },
    };

    const { launchMock } = withIsolatedBinMocks({
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

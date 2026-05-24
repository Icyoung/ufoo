const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  inspectUcodeSetup,
  formatUcodeDoctor,
  prepareAndInspectUcode,
} = require("../../../src/code/launcher/ucodeDoctor");

describe("ucode doctor", () => {
  test("inspect reports native core ready only when executable is available", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-doctor-ready-"));
    const promptFile = path.join(projectRoot, "prompt.md");
    fs.writeFileSync(promptFile, "prompt");

    const result = inspectUcodeSetup({
      projectRoot,
      env: {
        UFOO_UCODE_PROMPT_FILE: promptFile,
      },
      loadConfigImpl: () => ({}),
      resolveNativeImpl: () => ({
        command: process.execPath,
        args: ["/tmp/native-agent.js"],
        root: path.join(projectRoot, "src", "code"),
        kind: "native",
        available: true,
        resolvedPath: "/tmp/native-agent.js",
      }),
    });

    expect(result.core.found).toBe(true);
    expect(result.core.available).toBe(true);
    expect(result.core.resolvedPath).toBe("/tmp/native-agent.js");
    expect(result.promptExists).toBe(true);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("inspect reports missing executable when fallback command is unavailable", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-doctor-missing-"));
    const result = inspectUcodeSetup({
      projectRoot,
      env: {},
      loadConfigImpl: () => ({}),
      resolveNativeImpl: () => ({
        command: "ucode-core",
        args: ["agent"],
        root: "",
        kind: "native",
        available: false,
        missingReason: "ucode-core not found on PATH",
      }),
    });
    const output = formatUcodeDoctor(result);

    expect(result.core.found).toBe(false);
    expect(result.core.available).toBe(false);
    expect(output).toContain("core: missing");
    expect(output).toContain("attempted launch: ucode-core agent");
    expect(output).toContain("missing reason: ucode-core not found on PATH");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("prepareAndInspectUcode writes bootstrap file", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-doctor-prepare-"));
    const promptFile = path.join(projectRoot, "prompt.md");
    fs.writeFileSync(promptFile, "prompt");

    const result = prepareAndInspectUcode({
      projectRoot,
      env: { UFOO_UCODE_PROMPT_FILE: promptFile },
      loadConfigImpl: () => ({}),
    });

    expect(result.bootstrapPrepared).toBeTruthy();
    expect(fs.existsSync(result.bootstrapPrepared.file)).toBe(true);
    expect(formatUcodeDoctor(result)).toContain("=== ucode doctor ===");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

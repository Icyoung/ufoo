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
        command: process.execPath,
        args: ["/tmp/missing-agent.js"],
        root: "",
        kind: "native",
        available: false,
        missingReason: "src/code/agent.js not found",
      }),
    });
    const output = formatUcodeDoctor(result);

    expect(result.core.found).toBe(false);
    expect(result.core.available).toBe(false);
    expect(output).toContain("core: missing");
    expect(output).toContain(`attempted launch: ${process.execPath} /tmp/missing-agent.js`);
    expect(output).toContain("missing reason: src/code/agent.js not found");

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

  test("prepareAndInspectUcode does not inline the bundled prompt by default", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-doctor-noprompt-"));

    const result = prepareAndInspectUcode({
      projectRoot,
      env: {},
      loadConfigImpl: () => ({}),
    });

    // The native core's modular prompt already carries the ufoo protocol;
    // the bootstrap file must not duplicate it.
    expect(result.promptFile).toBe("");
    const content = fs.readFileSync(result.bootstrapPrepared.file, "utf8");
    expect(content).not.toContain("## Core Prompt");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("prepareAndInspectUcode still inlines an explicitly configured prompt file", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-doctor-explicit-"));
    const promptFile = path.join(projectRoot, "prompt.md");
    fs.writeFileSync(promptFile, "custom prompt body");

    const result = prepareAndInspectUcode({
      projectRoot,
      env: { UFOO_UCODE_PROMPT_FILE: promptFile },
      loadConfigImpl: () => ({}),
    });

    const content = fs.readFileSync(result.bootstrapPrepared.file, "utf8");
    expect(content).toContain("## Core Prompt");
    expect(content).toContain("custom prompt body");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  defaultBootstrapPath,
  prepareUcodeBootstrap,
  resolveProjectRules,
} = require("../../../src/agent/ucodeBootstrap");

describe("ucode bootstrap preparation", () => {
  test("resolves AGENTS.md as project rules", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-rules-"));
    fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "# rules\n");

    const rules = resolveProjectRules(projectRoot);
    expect(rules).toHaveLength(1);
    expect(rules[0].path).toContain("AGENTS.md");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("prepareUcodeBootstrap writes merged bootstrap file", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-bootstrap-"));
    const promptFile = path.join(projectRoot, "ucode.prompt.md");
    fs.writeFileSync(promptFile, "Core prompt line");
    fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Project rule line");

    const result = prepareUcodeBootstrap({ projectRoot, promptFile });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(result.file)).toBe(true);

    const content = fs.readFileSync(result.file, "utf8");
    expect(content).toContain("# ucode Bootstrap");
    expect(content).toContain("Core prompt line");
    expect(content).toContain("Project rule line");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("defaultBootstrapPath points to .ufoo/agent/ucode/bootstrap.md", () => {
    const file = defaultBootstrapPath("/tmp/project-x");
    expect(file).toBe(path.join("/tmp/project-x", ".ufoo", "agent", "ucode", "bootstrap.md"));
  });

  test("prepareUcodeBootstrap accepts inline prompt text", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-ucode-inline-bootstrap-"));
    fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "Project rule line");

    const result = prepareUcodeBootstrap({
      projectRoot,
      promptText: "Inline prompt body",
      targetFile: path.join(projectRoot, ".ufoo", "agent", "ucode", "inline.md"),
    });

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(result.file, "utf8");
    expect(content).toContain("Inline prompt body");

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

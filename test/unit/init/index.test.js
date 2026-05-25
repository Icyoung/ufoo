const fs = require("fs");
const path = require("path");
const UfooInit = require("../../../src/app/cli/features/init");

describe("UfooInit", () => {
  const testRoot = "/tmp/ufoo-init-test";
  const repoRoot = path.join(testRoot, "repo");
  const projectRoot = path.join(testRoot, "project");
  let init;
  let logSpy;
  let errorSpy;

  function read(filePath) {
    return fs.readFileSync(filePath, "utf8");
  }

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });

    init = new UfooInit(repoRoot);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("init creates AGENTS.md and CLAUDE.md without injecting a protocol template", async () => {
    await init.init({
      targets: "context",
      project: projectRoot,
    });

    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    expect(fs.existsSync(agentsFile)).toBe(true);
    expect(fs.existsSync(claudeFile)).toBe(true);
    expect(read(claudeFile)).toBe("AGENTS.md\n");
    expect(read(agentsFile)).toContain("`CLAUDE.md` points to this file");
    expect(read(agentsFile)).not.toContain("ufoo-template");
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions.jsonl"))).toBe(true);
  });

  test("init preserves existing markdown without injecting protocol text", async () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "ORIGINAL AGENTS CONTENT\n", "utf8");
    fs.writeFileSync(claudeFile, "ORIGINAL CLAUDE CONTENT\n", "utf8");

    await init.init({
      targets: "context",
      project: projectRoot,
    });

    expect(read(agentsFile)).toContain("ORIGINAL AGENTS CONTENT");
    expect(read(agentsFile)).not.toContain("ufoo-template");
    expect(read(claudeFile)).toContain("ORIGINAL CLAUDE CONTENT");
  });

  test("ensureAgentsFiles preserves existing CLAUDE.md symlink", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "ORIGINAL AGENTS CONTENT\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.ensureAgentsFiles(projectRoot);

    expect(fs.lstatSync(claudeFile).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeFile)).toBe("AGENTS.md");
    expect(read(agentsFile)).toBe("ORIGINAL AGENTS CONTENT\n");
  });

  test("init in controllerMode skips AGENTS/CLAUDE project files while bootstrapping .ufoo", async () => {
    await init.init({
      targets: "context",
      project: projectRoot,
      controllerMode: true,
    });

    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions.jsonl"))).toBe(true);
  });

  test("init with context and bus targets", async () => {
    await init.init({
      targets: "context,bus",
      project: projectRoot,
    });

    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "bus"))).toBe(true);
  });

  test("init with unknown target logs error", async () => {
    await init.init({
      targets: "unknown-target",
      project: projectRoot,
    });
    expect(errorSpy).toHaveBeenCalledWith("Unknown init target: unknown-target");
  });

  test("initContext creates decisions directory structure", () => {
    init.initContext(projectRoot);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions.jsonl"))).toBe(true);
  });

  test("initCore creates .ufoo directory", () => {
    init.initCore(projectRoot);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "memory"))).toBe(true);
  });

  test("initCore creates docs symlink when docs/ exists", () => {
    const docsDir = path.join(projectRoot, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "README.md"), "docs");

    init.initCore(projectRoot);
    const docsLink = path.join(projectRoot, ".ufoo", "docs");
    expect(fs.existsSync(docsLink)).toBe(true);
  });

  test("safeLstat returns null for nonexistent file", () => {
    expect(init.safeLstat("/nonexistent/path")).toBeNull();
  });

  test("safeLstat returns stat for existing file", () => {
    const file = path.join(projectRoot, "test.txt");
    fs.writeFileSync(file, "content");
    expect(init.safeLstat(file)).not.toBeNull();
  });

});

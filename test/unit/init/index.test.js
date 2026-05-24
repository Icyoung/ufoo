const fs = require("fs");
const path = require("path");
const UfooInit = require("../../../src/app/cli/features/init");

describe("UfooInit", () => {
  const testRoot = "/tmp/ufoo-init-test";
  const repoRoot = path.join(testRoot, "repo");
  const projectRoot = path.join(testRoot, "project");
  const templatePath = path.join(repoRoot, "modules", "AGENTS.template.md");
  let init;
  let logSpy;
  let warnSpy;
  let errorSpy;

  function read(filePath) {
    return fs.readFileSync(filePath, "utf8");
  }

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(templatePath), { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.writeFileSync(templatePath, "<!-- ufoo -->\nTemplate Block\n<!-- /ufoo -->\n", "utf8");

    init = new UfooInit(repoRoot);
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("init creates AGENTS.md and CLAUDE.md and injects the ufoo template", async () => {
    await init.init({
      modules: "context",
      project: projectRoot,
    });

    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    expect(fs.existsSync(agentsFile)).toBe(true);
    expect(fs.existsSync(claudeFile)).toBe(true);
    expect(read(claudeFile)).toContain("Template Block");
    expect(read(agentsFile)).toContain("`CLAUDE.md` points to this file");
    expect(read(agentsFile)).toContain("Template Block");
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions.jsonl"))).toBe(true);
  });

  test("init preserves existing markdown while injecting the protocol template", async () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "ORIGINAL AGENTS CONTENT\n", "utf8");
    fs.writeFileSync(claudeFile, "ORIGINAL CLAUDE CONTENT\n", "utf8");

    await init.init({
      modules: "context",
      project: projectRoot,
    });

    expect(read(agentsFile)).toContain("ORIGINAL AGENTS CONTENT");
    expect(read(agentsFile)).toContain("Template Block");
    expect(read(claudeFile)).toContain("ORIGINAL CLAUDE CONTENT");
    expect(read(claudeFile)).toContain("Template Block");
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

  test("injectAgentsTemplate is idempotent for AGENTS.md symlinked from CLAUDE.md", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# AGENTS\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.injectAgentsTemplate(projectRoot);
    init.injectAgentsTemplate(projectRoot);

    const content = read(agentsFile);
    const marker = "<!-- ufoo-template -->";
    expect((content.match(new RegExp(marker, "g")) || []).length).toBe(2);
    expect(content).toContain("Template Block");
  });

  test("injectAgentsTemplate inserts after the first heading", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# My Project\n\nSome content here.\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.injectAgentsTemplate(projectRoot);

    const content = read(agentsFile);
    expect(content.indexOf("<!-- ufoo-template -->")).toBeGreaterThan(content.indexOf("# My Project"));
    expect(content.indexOf("<!-- ufoo-template -->")).toBeLessThan(content.indexOf("Some content here."));
  });

  test("resolveTemplateTargets skips CLAUDE.md symlink targets outside the project", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    const outsideFile = path.join(testRoot, "outside.md");
    fs.writeFileSync(agentsFile, "# AGENTS\n", "utf8");
    fs.writeFileSync(outsideFile, "# Outside\n", "utf8");
    fs.symlinkSync(outsideFile, claudeFile);

    const targets = init.resolveTemplateTargets(projectRoot);

    expect(targets).toEqual([agentsFile]);
    expect(warnSpy).toHaveBeenCalled();
  });

  test("init in controllerMode skips AGENTS/CLAUDE project files while bootstrapping .ufoo", async () => {
    await init.init({
      modules: "context",
      project: projectRoot,
      controllerMode: true,
    });

    expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, "CLAUDE.md"))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions.jsonl"))).toBe(true);
  });

  test("init with context and bus modules", async () => {
    await init.init({
      modules: "context,bus",
      project: projectRoot,
    });

    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "context", "decisions"))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, ".ufoo", "bus"))).toBe(true);
  });

  test("init with resources module when module exists", async () => {
    const resourcesDir = path.join(repoRoot, "modules", "resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, "test.txt"), "resource content");

    await init.init({
      modules: "resources",
      project: projectRoot,
    });

    const destFile = path.join(projectRoot, ".ufoo", "resources", "test.txt");
    expect(fs.existsSync(destFile)).toBe(true);
    expect(fs.readFileSync(destFile, "utf8")).toBe("resource content");
  });

  test("init with resources module when module does not exist", async () => {
    await init.init({
      modules: "resources",
      project: projectRoot,
    });
  });

  test("init with unknown module logs error", async () => {
    await init.init({
      modules: "unknown-module",
      project: projectRoot,
    });
    expect(errorSpy).toHaveBeenCalledWith("Unknown module: unknown-module");
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

  test("findFirstHeadingEnd finds headings and returns -1 without headings", () => {
    expect(init.findFirstHeadingEnd("# Title\nContent")).toBeGreaterThan(0);
    expect(init.findFirstHeadingEnd("Title\n===\nContent")).toBeGreaterThan(0);
    expect(init.findFirstHeadingEnd("no heading here")).toBe(-1);
  });

  test("copyModuleContent copies files and subdirectories", () => {
    const src = path.join(projectRoot, "src-mod");
    const dest = path.join(projectRoot, "dest-mod");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "file.txt"), "root file");
    fs.writeFileSync(path.join(src, "sub", "nested.txt"), "nested file");

    init.copyModuleContent(src, dest);

    expect(fs.readFileSync(path.join(dest, "file.txt"), "utf8")).toBe("root file");
    expect(fs.readFileSync(path.join(dest, "sub", "nested.txt"), "utf8")).toBe("nested file");
  });

  test("copyModuleContent skips hidden dirs and node_modules", () => {
    const src = path.join(projectRoot, "src-skip");
    const dest = path.join(projectRoot, "dest-skip");
    fs.mkdirSync(path.join(src, ".hidden"), { recursive: true });
    fs.mkdirSync(path.join(src, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(src, ".hidden", "secret.txt"), "secret");
    fs.writeFileSync(path.join(src, "node_modules", "pkg.json"), "pkg");
    fs.writeFileSync(path.join(src, "visible.txt"), "visible");

    init.copyModuleContent(src, dest);

    expect(fs.existsSync(path.join(dest, "visible.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dest, ".hidden"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
  });
});

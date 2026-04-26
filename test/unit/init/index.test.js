const fs = require("fs");
const path = require("path");
const UfooInit = require("../../../src/init");

describe("UfooInit markdown handling", () => {
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

  test("ensureAgentsFiles should create default AGENTS.md and CLAUDE.md when absent", () => {
    init.ensureAgentsFiles(projectRoot);

    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");

    expect(fs.existsSync(agentsFile)).toBe(true);
    expect(fs.existsSync(claudeFile)).toBe(true);
    expect(read(claudeFile)).toBe("AGENTS.md\n");
    expect(read(agentsFile)).toContain("`CLAUDE.md` points to this file");
  });

  test("ensureAgentsFiles should preserve existing CLAUDE.md symlink", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "ORIGINAL AGENTS CONTENT\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.ensureAgentsFiles(projectRoot);

    expect(fs.lstatSync(claudeFile).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(claudeFile)).toBe("AGENTS.md");
    expect(read(agentsFile)).toBe("ORIGINAL AGENTS CONTENT\n");
  });

  test("injectAgentsTemplate should inject once into symlink source file", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# AGENTS\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.injectAgentsTemplate(projectRoot);
    init.injectAgentsTemplate(projectRoot);

    const content = read(agentsFile);
    const marker = "<!-- ufoo-template -->";
    const markerCount = (content.match(new RegExp(marker, "g")) || []).length;
    expect(markerCount).toBe(2);
    expect(content).toContain("Template Block");
  });

  test("injectAgentsTemplate should inject into both files when CLAUDE.md is separate file", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# AGENTS\n", "utf8");
    fs.writeFileSync(claudeFile, "# CLAUDE\n", "utf8");

    init.injectAgentsTemplate(projectRoot);

    expect(read(agentsFile)).toContain("Template Block");
    expect(read(claudeFile)).toContain("Template Block");
  });

  test("injectAgentsTemplate should insert after first heading, not at end", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# My Project\n\nSome content here.\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.injectAgentsTemplate(projectRoot);

    const content = read(agentsFile);
    const headingIdx = content.indexOf("# My Project");
    const templateIdx = content.indexOf("<!-- ufoo-template -->");
    const contentIdx = content.indexOf("Some content here.");

    // Template should appear between heading and existing content
    expect(templateIdx).toBeGreaterThan(headingIdx);
    expect(templateIdx).toBeLessThan(contentIdx);
  });

  test("injectAgentsTemplate should prepend when no heading exists", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "No heading, just text.\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.injectAgentsTemplate(projectRoot);

    const content = read(agentsFile);
    expect(content.startsWith("<!-- ufoo-template -->")).toBe(true);
    expect(content).toContain("Template Block");
    expect(content).toContain("No heading, just text.");
  });

  test("injectAgentsTemplate should insert after heading even without trailing newline", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# Heading without newline", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.injectAgentsTemplate(projectRoot);

    const content = read(agentsFile);
    const headingIdx = content.indexOf("# Heading without newline");
    const templateIdx = content.indexOf("<!-- ufoo-template -->");
    expect(templateIdx).toBeGreaterThan(headingIdx);
    expect(content.startsWith("<!-- ufoo-template -->")).toBe(false);
  });

  test("injectAgentsTemplate should recover malformed single marker block in-place", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(
      agentsFile,
      "# AGENTS\n\n<!-- ufoo-template -->\nLegacy tail content.\n",
      "utf8",
    );
    fs.symlinkSync("AGENTS.md", claudeFile);

    init.injectAgentsTemplate(projectRoot);

    const content = read(agentsFile);
    const marker = "<!-- ufoo-template -->";
    const markerCount = (content.match(new RegExp(marker, "g")) || []).length;
    expect(markerCount).toBe(2);
    expect(content).toContain("Template Block");
    expect(content).toContain("Legacy tail content.");
  });

  test("resolveTemplateTargets should only return symlink target for CLAUDE.md symlink", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# AGENTS\n", "utf8");
    fs.symlinkSync("AGENTS.md", claudeFile);

    const targets = init.resolveTemplateTargets(projectRoot);

    // Should only contain AGENTS.md (the symlink target), not CLAUDE.md separately
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(agentsFile);
  });

  test("resolveTemplateTargets should return both files when CLAUDE.md is independent", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    fs.writeFileSync(agentsFile, "# AGENTS\n", "utf8");
    fs.writeFileSync(claudeFile, "# CLAUDE\n", "utf8");

    const targets = init.resolveTemplateTargets(projectRoot);

    expect(targets).toHaveLength(2);
    expect(targets).toContain(agentsFile);
    expect(targets).toContain(claudeFile);
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
    // Create resources module
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
    // Should not crash, just log and skip
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

  test("findFirstHeadingEnd finds ATX heading", () => {
    expect(init.findFirstHeadingEnd("# Title\nContent")).toBeGreaterThan(0);
    expect(init.findFirstHeadingEnd("## Subtitle\nContent")).toBeGreaterThan(0);
  });

  test("findFirstHeadingEnd finds setext heading", () => {
    expect(init.findFirstHeadingEnd("Title\n===\nContent")).toBeGreaterThan(0);
    expect(init.findFirstHeadingEnd("Title\n---\nContent")).toBeGreaterThan(0);
  });

  test("findFirstHeadingEnd returns -1 when no heading", () => {
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

  test("resolveTemplateTargets handles symlink to outside project", () => {
    const agentsFile = path.join(projectRoot, "AGENTS.md");
    const claudeFile = path.join(projectRoot, "CLAUDE.md");
    const outsideFile = path.join(testRoot, "outside.md");
    fs.writeFileSync(agentsFile, "# AGENTS\n", "utf8");
    fs.writeFileSync(outsideFile, "# Outside\n", "utf8");
    fs.symlinkSync(outsideFile, claudeFile);

    const targets = init.resolveTemplateTargets(projectRoot);
    // Should only contain AGENTS.md, not the outside file
    expect(targets).toHaveLength(1);
    expect(targets[0]).toBe(agentsFile);
    expect(warnSpy).toHaveBeenCalled();
  });
});

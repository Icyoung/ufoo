const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  LEGACY_COMMAND_NAMES,
  RETIRED_DEFAULT_SKILLS,
  removeLegacySkillAndCommandLinks,
  refreshInstalledOptionalSkills,
  installManagedSkillLink,
} = require("../../../scripts/postinstall-skills");

function pathEntryExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe("postinstall retired skill cleanup", () => {
  let root;
  let pkgRoot;
  let home;
  let codexHome;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-postinstall-skills-"));
    pkgRoot = path.join(root, "package");
    home = path.join(root, "home");
    codexHome = path.join(root, "codex-home");
    fs.mkdirSync(path.join(pkgRoot, "SKILLS"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("removes only retired symlinks managed by this package", () => {
    const managedLinks = [];
    for (const name of RETIRED_DEFAULT_SKILLS) {
      const skillDir = path.join(pkgRoot, "SKILLS", name);
      const links = [
        [path.join(home, ".claude", "skills", name), skillDir],
        [path.join(codexHome, "skills", name), skillDir],
      ];
      for (const [linkPath, target] of links) {
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(target, linkPath);
        managedLinks.push(linkPath);
      }
    }
    for (const name of LEGACY_COMMAND_NAMES) {
      const linkPath = path.join(home, ".claude", "commands", `${name}.md`);
      const target = path.join(pkgRoot, "SKILLS", name, "SKILL.md");
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(target, linkPath);
      managedLinks.push(linkPath);
    }

    const removed = removeLegacySkillAndCommandLinks({ pkgRoot, home, codexHome });

    expect(removed.sort()).toEqual(managedLinks.sort());
    for (const linkPath of managedLinks) {
      expect(pathEntryExists(linkPath)).toBe(false);
    }
  });

  test("preserves user-owned directories and symlinks", () => {
    const userDirectory = path.join(home, ".claude", "skills", "uinit");
    const foreignTarget = path.join(root, "custom-ustatus");
    const foreignLink = path.join(codexHome, "skills", "ustatus");
    fs.mkdirSync(userDirectory, { recursive: true });
    fs.writeFileSync(path.join(userDirectory, "SKILL.md"), "# custom", "utf8");
    fs.mkdirSync(foreignTarget, { recursive: true });
    fs.mkdirSync(path.dirname(foreignLink), { recursive: true });
    fs.symlinkSync(foreignTarget, foreignLink);

    const removed = removeLegacySkillAndCommandLinks({ pkgRoot, home, codexHome });

    expect(removed).toEqual([]);
    expect(pathEntryExists(userDirectory)).toBe(true);
    expect(pathEntryExists(foreignLink)).toBe(true);
  });

  test("postinstall installs only the four skill directories", () => {
    const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
    const installHome = path.join(root, "install-home");
    const installCodexHome = path.join(root, "install-codex");
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts", "postinstall.js")], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: installHome,
        CODEX_HOME: installCodexHome,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const expected = ["ufoo", "ufoo-bus", "ufoo-context", "ufoo-online"];
    for (const name of expected) {
      const claudeSkill = path.join(installHome, ".claude", "skills", name);
      const codexSkill = path.join(installCodexHome, "skills", name);
      expect(pathEntryExists(claudeSkill)).toBe(true);
      expect(pathEntryExists(codexSkill)).toBe(true);
      expect(fs.existsSync(path.join(claudeSkill, "agents", "openai.yaml"))).toBe(true);
      expect(fs.existsSync(path.join(codexSkill, "agents", "openai.yaml"))).toBe(true);
    }
    expect(pathEntryExists(path.join(installHome, ".claude", "commands"))).toBe(false);
  });

  test("updates installed optional skills while leaving uninstalled skills opt-in", () => {
    const source = path.join(pkgRoot, "OPTIONAL_SKILLS", "ufoo-bus-poll");
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "timeout_seconds: 0");
    const targetDir = path.join(home, ".agents", "skills");
    const target = path.join(targetDir, "ufoo-bus-poll");
    const oldRoot = path.join(root, "old-package");
    fs.mkdirSync(path.join(oldRoot, "OPTIONAL_SKILLS", "ufoo-bus-poll"), { recursive: true });
    fs.writeFileSync(path.join(oldRoot, "package.json"), JSON.stringify({ name: "u-foo" }));
    fs.mkdirSync(targetDir, { recursive: true });
    fs.symlinkSync(path.join(oldRoot, "OPTIONAL_SKILLS", "ufoo-bus-poll"), target);
    const uninstalledDir = path.join(home, ".claude", "skills");
    const refreshed = refreshInstalledOptionalSkills({ pkgRoot, targetDirs: [targetDir, uninstalledDir] });
    expect(refreshed).toEqual([target]);
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("timeout_seconds: 0");
    expect(pathEntryExists(path.join(uninstalledDir, "ufoo-bus-poll"))).toBe(false);
    expect(refreshInstalledOptionalSkills({ pkgRoot, targetDirs: [targetDir] })).toEqual([]);
  });
  test("never replaces user directories, files or foreign links", () => {
    const source = path.join(pkgRoot, "SKILLS", "ufoo");
    const targetDir = path.join(root, "targets");
    fs.mkdirSync(targetDir);
    const directory = path.join(targetDir, "directory");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "notes.md"), "keep");
    const file = path.join(targetDir, "file");
    fs.writeFileSync(file, "keep");
    const link = path.join(targetDir, "link");
    fs.symlinkSync(directory, link);
    for (const target of [directory, file, link]) {
      expect(installManagedSkillLink(source, target)).toBe("conflict");
    }
    expect(fs.readFileSync(path.join(directory, "notes.md"), "utf8")).toBe("keep");
    expect(fs.readFileSync(file, "utf8")).toBe("keep");
    expect(fs.readlinkSync(link)).toBe(directory);
  });

});

const fs = require("fs");
const path = require("path");

const RETIRED_DEFAULT_SKILLS = Object.freeze(["ubus", "uctx", "uinit", "ustatus"]);
const LEGACY_COMMAND_NAMES = Object.freeze([
  "ubus",
  "uctx",
  "ufoo",
  "ufoo-bus",
  "ufoo-context",
  "ufoo-online",
  "uinit",
  "ustatus",
]);

// A matching name is not ownership evidence: user-authored skills must survive
// npm install. Only links into this package (or another verified u-foo install)
// may be refreshed automatically.
function isManagedSkillLink(linkPath, source) {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
    const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    if (target === path.resolve(source)) return true;
    if (path.basename(target) !== path.basename(source)) return false;
    const collection = path.basename(path.dirname(target));
    if (!["SKILLS", "OPTIONAL_SKILLS"].includes(collection)) return false;
    const manifest = JSON.parse(fs.readFileSync(path.join(target, "..", "..", "package.json"), "utf8"));
    return manifest.name === "u-foo";
  } catch { return false; }
}

function installManagedSkillLink(source, target) {
  try {
    fs.lstatSync(target);
    if (!isManagedSkillLink(target, source)) return "conflict";
    const current = path.resolve(path.dirname(target), fs.readlinkSync(target));
    if (current === path.resolve(source)) return "unchanged";
    fs.unlinkSync(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);
  return "installed";
}

function removeManagedSymlink(linkPath, expectedTarget) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) return false;

    const rawTarget = fs.readlinkSync(linkPath);
    const resolvedTarget = path.resolve(path.dirname(linkPath), rawTarget);
    if (resolvedTarget !== path.resolve(expectedTarget)) return false;

    fs.rmSync(linkPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function removeLegacySkillAndCommandLinks({ pkgRoot, home, codexHome } = {}) {
  const rawPackageRoot = String(pkgRoot || "").trim();
  const rawUserHome = String(home || "").trim();
  if (!rawPackageRoot || !rawUserHome) return [];

  const packageRoot = path.resolve(rawPackageRoot);
  const userHome = path.resolve(rawUserHome);
  const codexRoots = new Set([
    path.join(userHome, ".codex"),
    path.resolve(String(codexHome || path.join(userHome, ".codex"))),
  ]);
  const removed = [];

  for (const name of RETIRED_DEFAULT_SKILLS) {
    const skillDir = path.join(packageRoot, "SKILLS", name);
    const candidates = [
      {
        linkPath: path.join(userHome, ".claude", "skills", name),
        expectedTarget: skillDir,
      },
      ...Array.from(codexRoots).map((root) => ({
        linkPath: path.join(root, "skills", name),
        expectedTarget: skillDir,
      })),
    ];

    for (const candidate of candidates) {
      if (removeManagedSymlink(candidate.linkPath, candidate.expectedTarget)) {
        removed.push(candidate.linkPath);
      }
    }
  }

  for (const name of LEGACY_COMMAND_NAMES) {
    const linkPath = path.join(userHome, ".claude", "commands", `${name}.md`);
    const expectedTarget = path.join(packageRoot, "SKILLS", name, "SKILL.md");
    if (removeManagedSymlink(linkPath, expectedTarget)) {
      removed.push(linkPath);
    }
  }

  return removed;
}

function refreshInstalledOptionalSkills({ pkgRoot, targetDirs = [] } = {}) {
  const optionalRoot = path.join(pkgRoot, "OPTIONAL_SKILLS");
  if (!fs.existsSync(optionalRoot)) return [];
  const refreshed = [];
  for (const entry of fs.readdirSync(optionalRoot, { withFileTypes: true })) {
    const source = path.join(optionalRoot, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(path.join(source, "SKILL.md"))) continue;
    for (const targetDir of new Set(targetDirs)) {
      const target = path.join(targetDir, entry.name);
      try { fs.lstatSync(target); } catch { continue; }
      // Do not install new opt-in skills, and do not remove a skill when this
      // checkout is already its source.
      try { if (fs.realpathSync(target) === fs.realpathSync(source)) continue; } catch { /* stale link */ }
      if (installManagedSkillLink(source, target) === "installed") refreshed.push(target);
    }
  }
  return refreshed;
}

module.exports = {
  RETIRED_DEFAULT_SKILLS,
  LEGACY_COMMAND_NAMES,
  removeManagedSymlink,
  removeLegacySkillAndCommandLinks,
  refreshInstalledOptionalSkills,
  installManagedSkillLink,
  isManagedSkillLink,
};

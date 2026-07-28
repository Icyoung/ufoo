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

module.exports = {
  RETIRED_DEFAULT_SKILLS,
  LEGACY_COMMAND_NAMES,
  removeManagedSymlink,
  removeLegacySkillAndCommandLinks,
};

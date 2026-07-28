/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { removeLegacySkillAndCommandLinks } = require("./postinstall-skills");

// Fix node-pty spawn-helper permissions on macOS (both arm64 and x64)
const platforms = ["darwin-arm64", "darwin-x64"];

for (const platform of platforms) {
  try {
    const spawnHelperPath = path.join(
      __dirname,
      "..",
      "node_modules",
      "node-pty",
      "prebuilds",
      platform,
      "spawn-helper"
    );

    if (fs.existsSync(spawnHelperPath)) {
      const stats = fs.statSync(spawnHelperPath);
      if ((stats.mode & 0o111) === 0) {
        fs.chmodSync(spawnHelperPath, 0o755);
        console.log(`[postinstall] Fixed node-pty spawn-helper permissions (${platform})`);
      }
    }
  } catch {
    // Silently ignore - not critical for non-macOS or if node-pty not installed
  }
}

// Ensure the platform ufoo-tui binary from the npm pack is executable.
try {
  const plat = `${process.platform}-${process.arch}`;
  const tuiBin = path.join(__dirname, "..", "dist", "tui", plat, "ufoo-tui");
  if (fs.existsSync(tuiBin)) {
    fs.chmodSync(tuiBin, 0o755);
  }
} catch {
  // Non-fatal — doctor / launch will report missing binary.
}

// Collect all skill sources from the package-level SKILLS directory.
function collectSkillSources(pkgRoot) {
  const sources = [];
  const topSkills = path.join(pkgRoot, "SKILLS");
  if (fs.existsSync(topSkills)) {
    for (const entry of fs.readdirSync(topSkills, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const skillMd = path.join(topSkills, entry.name, "SKILL.md");
        if (fs.existsSync(skillMd)) {
          sources.push({ name: entry.name, dir: path.join(topSkills, entry.name) });
        }
      }
    }
  }
  return sources;
}

function forceSymlink(target, linkPath) {
  try {
    const existing = fs.lstatSync(linkPath);
    if (existing.isSymbolicLink() || existing.isFile() || existing.isDirectory()) {
      fs.rmSync(linkPath, { recursive: true, force: true });
    }
  } catch {
    // doesn't exist - fine
  }
  fs.symlinkSync(target, linkPath);
}

function installSkillDirs(targetDir, sources, label) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const { name, dir } of sources) {
    forceSymlink(dir, path.join(targetDir, name));
  }

  console.log(`[postinstall] Installed ${sources.length} ufoo skill(s) to ${label}`);
}

// Install ufoo skills for Claude and Codex at npm install time.
// - Claude skills: ~/.claude/skills/<name> -> skill dir
// - Codex skills: ${CODEX_HOME:-~/.codex}/skills/<name> -> skill dir
try {
  const pkgRoot = path.resolve(__dirname, "..");
  const home = os.homedir();
  const sources = collectSkillSources(pkgRoot);
  const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
  const retiredLinks = removeLegacySkillAndCommandLinks({ pkgRoot, home, codexHome });

  if (retiredLinks.length > 0) {
    console.log(`[postinstall] Removed ${retiredLinks.length} legacy ufoo link(s)`);
  }

  if (sources.length > 0) {
    installSkillDirs(path.join(home, ".claude", "skills"), sources, "~/.claude/skills");

    installSkillDirs(path.join(codexHome, "skills"), sources, `${codexHome}/skills`);
  }
} catch (err) {
  // Non-fatal - skills can be installed manually via `ufoo skills install`
  console.log(`[postinstall] Skipped skills install: ${err.message}`);
}

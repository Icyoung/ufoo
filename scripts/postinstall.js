/* eslint-disable no-console */
const path = require("path");
const fs = require("fs");
const os = require("os");

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

// Install ufoo skills to ~/.claude/skills/ via symlinks
// Skills auto-update when the package is updated since they're symlinks.
try {
  const pkgRoot = path.resolve(__dirname, "..");
  const home = os.homedir();
  const claudeSkillsDir = path.join(home, ".claude", "skills");

  // Collect all skill directories
  const skillSources = [];

  // Top-level SKILLS/
  const topSkills = path.join(pkgRoot, "SKILLS");
  if (fs.existsSync(topSkills)) {
    for (const entry of fs.readdirSync(topSkills, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        skillSources.push({ name: entry.name, src: path.join(topSkills, entry.name) });
      }
    }
  }

  // modules/*/SKILLS/
  const modulesDir = path.join(pkgRoot, "modules");
  if (fs.existsSync(modulesDir)) {
    for (const mod of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!mod.isDirectory()) continue;
      const modSkills = path.join(modulesDir, mod.name, "SKILLS");
      if (!fs.existsSync(modSkills)) continue;
      for (const entry of fs.readdirSync(modSkills, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          skillSources.push({ name: entry.name, src: path.join(modSkills, entry.name) });
        }
      }
    }
  }

  if (skillSources.length > 0) {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });

    let installed = 0;
    for (const { name, src } of skillSources) {
      const dest = path.join(claudeSkillsDir, name);
      try {
        // Remove existing (symlink or dir) before creating fresh symlink
        if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
          fs.rmSync(dest, { recursive: true, force: true });
        }
      } catch {
        // lstatSync throws if path doesn't exist at all — fine
      }
      fs.symlinkSync(src, dest);
      installed += 1;
    }
    if (installed > 0) {
      console.log(`[postinstall] Installed ${installed} ufoo skill(s) to ${claudeSkillsDir}`);
    }
  }
} catch (err) {
  // Non-fatal — skills can be installed manually via `ufoo skills install`
  console.log(`[postinstall] Skipped skills install: ${err.message}`);
}

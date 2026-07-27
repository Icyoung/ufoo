#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Stage a release `ufoo-tui` binary under dist/tui/<platform>-<arch>/.
 *
 * Usage:
 *   node scripts/pack-tui.js            # build current host + stage
 *   node scripts/pack-tui.js --copy-only # stage from existing target/release
 *   node scripts/pack-tui.js --check     # exit 0 only if at least one staged binary exists
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.join(ROOT, "dist", "tui");
const BINARY_NAME = process.platform === "win32" ? "ufoo-tui.exe" : "ufoo-tui";

function hostPlatform() {
  return `${process.platform}-${process.arch}`;
}

function listStagedPlatforms() {
  if (!fs.existsSync(DIST_ROOT)) return [];
  const out = [];
  for (const entry of fs.readdirSync(DIST_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const bin = path.join(DIST_ROOT, entry.name, "ufoo-tui");
    const binExe = path.join(DIST_ROOT, entry.name, "ufoo-tui.exe");
    if (fs.existsSync(bin) || fs.existsSync(binExe)) out.push(entry.name);
  }
  return out.sort();
}

function findReleaseBinary() {
  const candidates = [
    path.join(ROOT, "target", "release", BINARY_NAME),
    path.join(ROOT, "crates", "ufoo-tui", "target", "release", BINARY_NAME),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function buildRelease() {
  console.log("[pack-tui] cargo build -p ufoo-tui --release");
  const result = spawnSync("cargo", ["build", "-p", "ufoo-tui", "--release"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error("cargo build failed");
  }
}

function stageBinary(sourcePath, platform = hostPlatform()) {
  const destDir = path.join(DIST_ROOT, platform);
  fs.mkdirSync(destDir, { recursive: true });
  const destName = platform.startsWith("win32") ? "ufoo-tui.exe" : "ufoo-tui";
  const destPath = path.join(destDir, destName);
  fs.copyFileSync(sourcePath, destPath);
  try {
    fs.chmodSync(destPath, 0o755);
  } catch {
    // Windows may ignore chmod
  }
  console.log(`[pack-tui] staged ${destPath}`);
  return destPath;
}

function main(argv = process.argv.slice(2)) {
  const copyOnly = argv.includes("--copy-only");
  const checkOnly = argv.includes("--check");

  if (checkOnly) {
    const plats = listStagedPlatforms();
    if (plats.length === 0) {
      console.error("[pack-tui] no staged binaries under dist/tui/<platform>/");
      process.exit(1);
    }
    console.log(`[pack-tui] staged platforms: ${plats.join(", ")}`);
    return;
  }

  if (!copyOnly) {
    buildRelease();
  }

  const source = findReleaseBinary();
  if (!source) {
    throw new Error(
      `release binary not found (looked for target/release/${BINARY_NAME}). `
        + "Run cargo build -p ufoo-tui --release first.",
    );
  }
  stageBinary(source);
  console.log(`[pack-tui] ok (${hostPlatform()})`);
}

try {
  main();
} catch (err) {
  console.error(`[pack-tui] ${err && err.message ? err.message : err}`);
  process.exit(1);
}

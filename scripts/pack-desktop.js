#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Self-contained bundler & runtime stager for Ufoo macOS Desktop (`Ufoo.app`).
 *
 * Stages into `crates/ufoo-desktop/resources/runtime/`:
 *   - `bin/node`     (Managed Node.js executable)
 *   - `bin/ufoo-tui` (Rust TUI binary for seamless CLI handoff)
 *   - `ufoo-core/`   (Complete ufoo JS runtime + production node_modules)
 *   - `shims/`       (Portable CLI shims: ufoo, ucode)
 *
 * Usage:
 *   node scripts/pack-desktop.js --icons-only               # generate app icons only
 *   node scripts/pack-desktop.js --stage-only [--skip-icons] # build frontend + tui + stage runtime
 *   node scripts/pack-desktop.js                            # full stage + cargo build -p ufoo-desktop --release
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const DESKTOP_CRATE = path.join(ROOT, "crates", "ufoo-desktop");
const ICONS_DIR = path.join(DESKTOP_CRATE, "icons");
const BROWSER_ICONS_DIR = path.join(ROOT, "extensions", "ufoo-browser", "icons");
const STAGED_RUNTIME = path.join(DESKTOP_CRATE, "resources", "runtime");

function createIcoFromPng(pngBuf, size = 32) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);

  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);

  return Buffer.concat([header, entry, pngBuf]);
}

function ensureDesktopIcons() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
  const browserIcon = (size) => path.join(BROWSER_ICONS_DIR, `icon-${size}.png`);
  const png32 = fs.readFileSync(browserIcon(32));
  fs.writeFileSync(path.join(ICONS_DIR, "icon.ico"), createIcoFromPng(png32, 32));

  const variants = [["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256]];
  if (process.platform === "darwin") {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-icon-"));
    try {
      const master = path.join(temp, "macos.png");
      runChecked("swift", ["-module-cache-path", path.join(temp, "modules"),
        path.join(DESKTOP_CRATE, "render-icon.swift"), path.join(BROWSER_ICONS_DIR, "logo.png"), master]);
      for (const [filename, size] of [...variants, ["icon.png", 512]]) {
        runChecked("sips", ["-z", String(size), String(size), master, "--out", path.join(ICONS_DIR, filename)]);
      }
      runChecked("sips", ["-s", "format", "icns", path.join(ICONS_DIR, "icon.png"), "--out", path.join(ICONS_DIR, "icon.icns")]);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  } else {
    for (const [filename, size] of variants) fs.copyFileSync(browserIcon(size), path.join(ICONS_DIR, filename));
  }
  console.log(`[pack-desktop] generated icons in ${ICONS_DIR}`);
}

function runChecked(cmd, args, cwd = ROOT) {
  console.log(`[pack-desktop] ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with status ${res.status}`);
  }
}

function copyTreeFiltered(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      const base = path.basename(sourcePath);
      return base !== ".DS_Store" && base !== ".git";
    },
  });
}

function stageBundledRuntime() {
  console.log("[pack-desktop] staging self-contained Node + ufoo runtime...");
  fs.rmSync(STAGED_RUNTIME, { recursive: true, force: true });
  const binDir = path.join(STAGED_RUNTIME, "bin");
  const coreDir = path.join(STAGED_RUNTIME, "ufoo-core");
  const shimsDir = path.join(STAGED_RUNTIME, "shims");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(coreDir, { recursive: true });
  fs.mkdirSync(shimsDir, { recursive: true });

  // 1. Stage Node executable
  const sourceNode = process.env.UFOO_BUNDLE_NODE_PATH || process.execPath;
  const stagedNode = path.join(binDir, "node");
  fs.copyFileSync(sourceNode, stagedNode);
  fs.chmodSync(stagedNode, 0o755);

  // 2. Ensure & stage ufoo-tui binary
  runChecked(process.execPath, [path.join(ROOT, "scripts", "pack-tui.js")]);
  const plat = `${process.platform}-${process.arch}`;
  const stagedTuiSrc = path.join(ROOT, "dist", "tui", plat, "ufoo-tui");
  const stagedTuiDest = path.join(binDir, "ufoo-tui");
  if (fs.existsSync(stagedTuiSrc)) {
    fs.copyFileSync(stagedTuiSrc, stagedTuiDest);
    fs.chmodSync(stagedTuiDest, 0o755);
  }

  // 3. Stage ufoo-core JS runtime & production dependencies
  for (const rel of ["bin", "src", "extensions", "templates", "SKILLS", "OPTIONAL_SKILLS", "package.json"]) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(coreDir, rel);
    if (fs.statSync(from).isDirectory()) copyTreeFiltered(from, to);
    else fs.copyFileSync(from, to);
  }

  copyTreeFiltered(path.join(ROOT, "node_modules"), path.join(coreDir, "node_modules"));

  // 4. Generate portable relocatable shims
  for (const cliName of ["ufoo", "ucode"]) {
    const shimPath = path.join(shimsDir, cliName);
    const content = [
      "#!/bin/sh",
      'SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"',
      'RT_DIR="$(dirname "$SELF_DIR")"',
      'export UFOO_NODE_EXECUTABLE="$RT_DIR/bin/node"',
      'export UFOO_TUI_BIN="$RT_DIR/bin/ufoo-tui"',
      `exec "$RT_DIR/bin/node" "$RT_DIR/ufoo-core/bin/${cliName}.js" "$@"`,
      "",
    ].join("\n");
    fs.writeFileSync(shimPath, content, { mode: 0o755 });
  }

  console.log(`[pack-desktop] staged self-contained runtime at ${STAGED_RUNTIME}`);
}

function hasExistingDesktopIcons() {
  const required = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.icns", "icon.ico", "icon.png"];
  return required.every((name) => fs.existsSync(path.join(ICONS_DIR, name)));
}

function main(argv = process.argv.slice(2)) {
  const skipIcons = argv.includes("--skip-icons") && hasExistingDesktopIcons();
  if (!skipIcons) {
    ensureDesktopIcons();
  }
  if (argv.includes("--icons-only")) return;

  runChecked("npm", ["--prefix", path.join(ROOT, "apps", "desktop"), "run", "build"]);
  stageBundledRuntime();

  if (argv.includes("--stage-only")) return;

  runChecked("cargo", ["build", "-p", "ufoo-desktop", "--release"]);
  console.log("[pack-desktop] build complete: target/release/Ufoo");
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[pack-desktop] ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

module.exports = {
  ensureDesktopIcons,
};

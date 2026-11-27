/* eslint-disable no-console */
"use strict";

const path = require("path");
const { openInDesktopApp, installCliShims } = require("../../ui/cliHandoff");
const { canonicalProjectRoot } = require("../../runtime/projects/projectId");

function printAppHelp() {
  console.log("Usage: ufoo app [project-path] [options]");
  console.log("");
  console.log("Open or hand off the current workspace to Ufoo Desktop App (macOS).");
  console.log("");
  console.log("Options:");
  console.log("  --agent <id>         Focus a specific Worker Agent in single-agent view");
  console.log("  --window <mode>      Open project root in main, side, or multi window mode");
  console.log("  --doc <path>         Open a workspace document in the Right Inspector");
  console.log("  --install-cli        Install ufoo/ucode shims to ~/.ufoo/bin");
  console.log("  --zshrc              Append ~/.ufoo/bin to ~/.zshrc when used with --install-cli");
  console.log("  --json               Print structured JSON result");
  console.log("  -h, --help           Show help");
}

function parseAppCliArgs(argv = []) {
  const out = {
    projectRoot: "",
    target: "main",
    windowMode: "",
    docPath: "",
    installCli: false,
    updateZshrc: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "");
    if (arg === "-h" || arg === "--help") out.help = true;
    else if (arg === "--install-cli") out.installCli = true;
    else if (arg === "--zshrc") out.updateZshrc = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--agent" && argv[i + 1]) {
      out.target = String(argv[++i]).trim();
    } else if (arg === "--window" && argv[i + 1]) {
      out.windowMode = String(argv[++i]).trim().toLowerCase();
    } else if (arg === "--doc" && argv[i + 1]) {
      out.docPath = String(argv[++i]).trim();
    } else if (!arg.startsWith("-") && !out.projectRoot) {
      out.projectRoot = arg;
    }
  }
  return out;
}

async function runAppCommand(argv = []) {
  const parsed = parseAppCliArgs(argv);
  if (parsed.help) {
    printAppHelp();
    return { ok: true, help: true };
  }

  if (parsed.installCli) {
    const res = installCliShims({ updateZshrc: parsed.updateZshrc });
    if (parsed.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`Installed ${res.installed.length} CLI shims into ${res.targetDir}`);
      if (!res.inPath) {
        console.log(`Add to PATH: export PATH="${res.targetDir}:$PATH"`);
      }
    }
    return res;
  }

  const rawRoot = parsed.projectRoot || process.cwd();
  let projectRoot = path.resolve(rawRoot);
  try {
    projectRoot = canonicalProjectRoot(rawRoot);
  } catch {
    // keep resolved path
  }

  const result = await openInDesktopApp({
    projectRoot,
    target: parsed.target || "main",
    windowMode: parsed.windowMode || "",
    docPath: parsed.docPath || "",
  });

  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  if (result.ok) {
    console.log(`Handed off to Ufoo Desktop (${result.url})`);
  } else {
    console.error(`Could not open Ufoo Desktop: ${result.error}`);
    console.error(`Deep link: ${result.url}`);
    process.exitCode = 1;
  }
  return result;
}

module.exports = {
  runAppCommand,
  parseAppCliArgs,
  printAppHelp,
};

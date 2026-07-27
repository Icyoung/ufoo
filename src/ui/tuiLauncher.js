"use strict";

/**
 * Resolve / spawn ufoo-tui. Terminal UI is Rust-only.
 *
 * UFOO_TUI=auto|rust → rust when binary+version probe OK, else error.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PROTOCOL = "ufoo-ui/1";

function normalizeTuiMode(value = process.env.UFOO_TUI) {
  const raw = String(value || "auto").trim().toLowerCase();
  if (raw === "rust") return "rust";
  return "auto";
}

function candidateBinaryPaths() {
  const out = [];
  if (process.env.UFOO_TUI_BIN) {
    out.push(String(process.env.UFOO_TUI_BIN));
    return out;
  }
  const platform = `${process.platform}-${process.arch}`;
  const root = path.resolve(__dirname, "../..");
  out.push(path.join(root, "target/release/ufoo-tui"));
  out.push(path.join(root, "target/debug/ufoo-tui"));
  out.push(path.join(root, "crates/ufoo-tui/target/release/ufoo-tui"));
  out.push(path.join(root, "crates/ufoo-tui/target/debug/ufoo-tui"));
  out.push(path.join(root, "dist/tui", platform, "ufoo-tui"));
  try {
    const optional = require.resolve(`@u-foo/tui-${platform}/ufoo-tui`);
    out.push(optional);
  } catch {
    // optional package not installed
  }
  return out;
}

function resolveUfooTuiBinary() {
  for (const candidate of candidateBinaryPaths()) {
    try {
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function probeBinaryVersion(binaryPath) {
  try {
    const result = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status !== 0) return null;
    return String(result.stdout || result.stderr || "").trim();
  } catch {
    return null;
  }
}

function resolveTuiLaunchPlan({
  mode = normalizeTuiMode(),
  surface = "chat",
} = {}) {
  const normalized = normalizeTuiMode(mode);
  const binary = resolveUfooTuiBinary();
  const version = binary ? probeBinaryVersion(binary) : null;

  if (!binary || !version) {
    return {
      mode: "error",
      binary,
      version,
      protocol: PROTOCOL,
      reason: binary ? "version_probe_failed" : "binary_missing",
      surface,
    };
  }

  return {
    mode: "rust",
    binary,
    version,
    protocol: PROTOCOL,
    reason: normalized === "rust" ? "forced_rust" : "auto_prefer_rust",
    surface,
  };
}

module.exports = {
  PROTOCOL,
  normalizeTuiMode,
  resolveUfooTuiBinary,
  probeBinaryVersion,
  resolveTuiLaunchPlan,
  candidateBinaryPaths,
};

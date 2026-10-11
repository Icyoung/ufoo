"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Protocol baseline verified against CLIProxyAPI v8.0.22's xAI adapter.
const GROK_CLIENT_VERSION = "1.0.46";

function validClientVersion(value) {
  const version = String(value || "").trim();
  return /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version) ? version : "";
}

function newestVersion(...versions) {
  return versions.filter(Boolean).sort((left, right) => {
    const a = left.match(/\d+/g).slice(0, 3).map(Number);
    const b = right.match(/\d+/g).slice(0, 3).map(Number);
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return b[i] - a[i];
    return 0;
  })[0] || "";
}

function installedPackageVersion(packageName, { binary = "", env = process.env } = {}) {
  const candidates = (require.resolve.paths(packageName) || []).map((directory) => path.join(directory, packageName, "package.json"));
  if (binary) {
    for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
      try {
        let parent = path.dirname(fs.realpathSync(path.join(directory, binary)));
        for (let i = 0; i < 4; i += 1) {
          candidates.push(path.join(parent, "package.json"));
          parent = path.dirname(parent);
        }
      } catch { /* CLI installation is optional; never invoke it. */ }
    }
  }
  const versions = [];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const version = validClientVersion(pkg.version);
      if (pkg.name === packageName && version) versions.push(version);
    } catch { /* Try the next installation path. */ }
  }
  return newestVersion(...versions);
}

function resolveCodexClientVersion({ env = process.env, codexHome = "", clientVersion = "" } = {}) {
  const override = validClientVersion(clientVersion) || validClientVersion(env.UFOO_CODEX_CLIENT_VERSION);
  if (override) return override;
  // Only the version is read from the cache. Models and account access still
  // come from the live provider; credentials are never read or written here.
  let cachedVersion = "";
  try {
    const home = codexHome || env.CODEX_HOME || path.join(os.homedir(), ".codex");
    cachedVersion = validClientVersion(JSON.parse(fs.readFileSync(path.join(home, "models_cache.json"), "utf8")).client_version);
  } catch { /* Codex need not have populated its cache yet. */ }
  return newestVersion(cachedVersion,
    installedPackageVersion("@openai/codex", { binary: "codex", env }),
    installedPackageVersion("@openai/codex-sdk", { env }));
}

function resolveCodexUserAgent(options = {}) {
  const env = options.env || process.env;
  if (String(env.UFOO_CODEX_USER_AGENT || "").trim()) return env.UFOO_CODEX_USER_AGENT.trim();
  const version = resolveCodexClientVersion(options) || "dev";
  return `codex-tui/${version} (${os.type()} ${os.release()}; ${process.arch})`;
}

function resolveGrokClientVersion({ env = process.env } = {}) {
  return validClientVersion(env.UFOO_GROK_CLIENT_VERSION)
    || newestVersion(GROK_CLIENT_VERSION, installedPackageVersion("@xai-official/grok", { binary: "grok", env }));
}

module.exports = { resolveCodexClientVersion, resolveCodexUserAgent, resolveGrokClientVersion };

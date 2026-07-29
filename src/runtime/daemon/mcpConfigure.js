"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  readConnectionFiles,
} = require("./mcpStdioProxy");
const {
  resolveGlobalControllerProjectRoot,
} = require("../projects");

const MANAGED_BLOCK_START = "# >>> ufoo MCP (managed)";
const MANAGED_BLOCK_END = "# <<< ufoo MCP (managed)";

function tomlString(value = "") {
  return JSON.stringify(String(value || ""));
}

function codexConfigPath(options = {}) {
  if (options.configPath) return options.configPath;
  const codexHome = String(options.codexHome || process.env.CODEX_HOME || "").trim();
  return path.join(codexHome || path.join(os.homedir(), ".codex"), "config.toml");
}

function buildCodexManagedBlock(connection) {
  return [
    MANAGED_BLOCK_START,
    "[mcp_servers.ufoo]",
    `url = ${tomlString(connection.endpoint)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${connection.token}`)} }`,
    "tool_timeout_sec = 610",
    "enabled = true",
    MANAGED_BLOCK_END,
  ].join("\n");
}

function removeManagedBlock(text = "") {
  const escapedStart = MANAGED_BLOCK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = MANAGED_BLOCK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(text || "").replace(
    new RegExp(`(?:^|\\n)${escapedStart}\\n[\\s\\S]*?\\n${escapedEnd}(?=\\n|$)`, "g"),
    ""
  );
}

function findTomlSections(text = "") {
  const sections = [];
  const pattern = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/gm;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    sections.push({
      header: match[1].trim(),
      start: match.index,
      contentStart: pattern.lastIndex,
    });
  }
  return sections.map((section, index) => ({
    ...section,
    end: index + 1 < sections.length ? sections[index + 1].start : text.length,
  }));
}

function isUfooMainSection(header = "") {
  return /^(?:mcp_servers\.ufoo|mcp_servers\."ufoo")$/.test(String(header || ""));
}

function isUfooStdioEnvSection(header = "") {
  return /^(?:mcp_servers\.ufoo|mcp_servers\."ufoo")\.env$/.test(String(header || ""));
}

function removeLegacyUfooTransportSections(text = "") {
  const sections = findTomlSections(text);
  const ranges = sections
    .filter((section) => isUfooMainSection(section.header) || isUfooStdioEnvSection(section.header))
    .map((section) => [section.start, section.end])
    .sort((a, b) => b[0] - a[0]);
  let next = text;
  for (const [start, end] of ranges) {
    next = `${next.slice(0, start)}${next.slice(end)}`;
  }
  return next;
}

function renderCodexConfig(existing, connection) {
  const withoutManaged = removeManagedBlock(existing);
  const withoutLegacy = removeLegacyUfooTransportSections(withoutManaged);
  const trimmed = withoutLegacy.trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ""}${buildCodexManagedBlock(connection)}\n`;
}

function configureCodexMcp(options = {}) {
  const projectRoot = options.projectRoot || resolveGlobalControllerProjectRoot();
  const connection = options.connection || readConnectionFiles(projectRoot);
  const target = codexConfigPath(options);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const next = renderCodexConfig(existing, connection);
  if (options.dryRun === true) {
    const managedBlock = buildCodexManagedBlock({
      ...connection,
      token: "<redacted>",
    });
    return {
      ok: true,
      dry_run: true,
      target,
      transport: "streamable_http",
      endpoint: connection.endpoint,
      changed: next !== existing,
      managed_block: managedBlock,
    };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let backup = "";
  if (fs.existsSync(target) && next !== existing) {
    backup = `${target}.ufoo-backup-${Date.now()}`;
    fs.copyFileSync(target, backup);
    try {
      fs.chmodSync(backup, 0o600);
    } catch {
      // Best effort for filesystems without POSIX modes.
    }
  }
  fs.writeFileSync(target, next, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Best effort for filesystems without POSIX modes.
  }
  return {
    ok: true,
    dry_run: false,
    target,
    backup: backup || null,
    transport: "streamable_http",
    endpoint: connection.endpoint,
    changed: next !== existing,
  };
}

function runMcpConfigureCli(host, options = {}) {
  const normalized = String(host || "").trim().toLowerCase();
  if (normalized !== "codex") {
    const err = new Error(
      `Direct HTTP auto-configuration is verified only for Codex App/CLI/IDE; keep ${normalized || "this host"} on the stateless "ufoo mcp" stdio proxy`
    );
    err.code = "unsupported_mcp_host_config";
    throw err;
  }
  const result = configureCodexMcp(options);
  if (options.dryRun === true) {
    process.stdout.write(`Target: ${result.target}\n`);
    process.stdout.write(`Changed: ${result.changed ? "yes" : "no"}\n`);
    process.stdout.write(`Transport: Streamable HTTP ${result.endpoint}\n\n`);
    process.stdout.write(`${result.managed_block}\n`);
  } else {
    process.stdout.write(`Configured Codex MCP at ${result.target}\n`);
    process.stdout.write(`Transport: Streamable HTTP ${result.endpoint}\n`);
    if (result.backup) process.stdout.write(`Backup: ${result.backup}\n`);
    process.stdout.write("Restart Codex App/CLI/IDE to load the shared MCP configuration.\n");
  }
  return result;
}

module.exports = {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  buildCodexManagedBlock,
  codexConfigPath,
  configureCodexMcp,
  findTomlSections,
  removeLegacyUfooTransportSections,
  removeManagedBlock,
  renderCodexConfig,
  runMcpConfigureCli,
};

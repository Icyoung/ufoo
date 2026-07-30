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
const CODEX_STANDARD_TOOL_TIMEOUT_SECONDS = 610;
// Codex currently requires a finite server-level MCP timeout. One year is
// effectively session-lifetime while avoiding periodic model wakeups. Keep the
// long timeout isolated from normal ufoo tools so a broken short call cannot
// hang for the same duration.
const CODEX_WAIT_TOOL_TIMEOUT_SECONDS = 365 * 24 * 60 * 60;
const RETIRED_UFOO_SKILL_NAMES = new Set([
  "ubus",
  "uctx",
  "uinit",
  "ustatus",
  "ufoo-poll",
]);

function tomlString(value = "") {
  return JSON.stringify(String(value || ""));
}

function codexConfigPath(options = {}) {
  if (options.configPath) return options.configPath;
  const codexHome = String(options.codexHome || process.env.CODEX_HOME || "").trim();
  return path.join(codexHome || path.join(os.homedir(), ".codex"), "config.toml");
}

function buildCodexManagedBlock(connection) {
  const authorization = tomlString(`Bearer ${connection.token}`);
  return [
    MANAGED_BLOCK_START,
    "[mcp_servers.ufoo]",
    `url = ${tomlString(connection.endpoint)}`,
    `http_headers = { Authorization = ${authorization} }`,
    `tool_timeout_sec = ${CODEX_STANDARD_TOOL_TIMEOUT_SECONDS}`,
    'disabled_tools = ["wait_for_message"]',
    "enabled = true",
    "",
    "[mcp_servers.ufoo_wait]",
    `url = ${tomlString(connection.endpoint)}`,
    `http_headers = { Authorization = ${authorization} }`,
    `tool_timeout_sec = ${CODEX_WAIT_TOOL_TIMEOUT_SECONDS}`,
    'enabled_tools = ["wait_for_message"]',
    "enabled = true",
    "",
    "[mcp_servers.ufoo_wait.tools.wait_for_message]",
    'approval_mode = "approve"',
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
    .filter((section) => (
      isUfooMainSection(section.header)
      || isUfooStdioEnvSection(section.header)
      || /^(?:mcp_servers\.ufoo_wait|mcp_servers\."ufoo_wait")(?:\.|$)/
        .test(String(section.header || ""))
    ))
    .map((section) => [section.start, section.end])
    .sort((a, b) => b[0] - a[0]);
  let next = text;
  for (const [start, end] of ranges) {
    next = `${next.slice(0, start)}${next.slice(end)}`;
  }
  return next;
}

function removeRetiredUfooSkillConfigBlocks(text = "") {
  const source = String(text || "");
  const tables = [];
  const tablePattern = /^\s*(\[{1,2}[^\]\r\n]+\]{1,2})\s*(?:#.*)?$/gm;
  let match;
  while ((match = tablePattern.exec(source)) !== null) {
    tables.push({
      header: match[1],
      start: match.index,
    });
  }
  const ranges = [];
  for (let index = 0; index < tables.length; index += 1) {
    if (tables[index].header !== "[[skills.config]]") continue;
    const start = tables[index].start;
    const end = index + 1 < tables.length ? tables[index + 1].start : source.length;
    const block = source.slice(start, end);
    const pathMatch = block.match(/^\s*path\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);
    if (!pathMatch) continue;
    const normalizedPath = pathMatch[1].replace(/\\/g, "/");
    const skillMatch = normalizedPath.match(
      /\/u-foo\/(?:modules\/[^/]+\/)?SKILLS\/([^/]+)\/SKILL\.md$/
    );
    if (skillMatch && RETIRED_UFOO_SKILL_NAMES.has(skillMatch[1])) {
      ranges.push([start, end]);
    }
  }
  let next = source;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) {
    next = `${next.slice(0, start)}${next.slice(end)}`;
  }
  return next;
}

function renderCodexConfig(existing, connection) {
  const withoutManaged = removeManagedBlock(existing);
  const withoutLegacy = removeLegacyUfooTransportSections(withoutManaged);
  const withoutRetiredSkills = removeRetiredUfooSkillConfigBlocks(withoutLegacy);
  const trimmed = withoutRetiredSkills.trimEnd();
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
  CODEX_STANDARD_TOOL_TIMEOUT_SECONDS,
  CODEX_WAIT_TOOL_TIMEOUT_SECONDS,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  buildCodexManagedBlock,
  codexConfigPath,
  configureCodexMcp,
  findTomlSections,
  removeLegacyUfooTransportSections,
  removeManagedBlock,
  removeRetiredUfooSkillConfigBlocks,
  renderCodexConfig,
  runMcpConfigureCli,
};

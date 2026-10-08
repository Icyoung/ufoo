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

function buildCodexManagedBlock(connection, authentication = {}) {
  const authorization = tomlString(`Bearer ${connection.token}`);
  const authLines = (name) => authentication[name]?.lines
    || [`http_headers = { Authorization = ${authorization} }`];
  const authTables = (name) => (authentication[name]?.tables || []).flatMap((table) => [
    "",
    `[mcp_servers.${name}.${table.suffix}]`,
    table.body,
  ]);
  return [
    MANAGED_BLOCK_START,
    "[mcp_servers.ufoo]",
    `url = ${tomlString(connection.endpoint)}`,
    ...authLines("ufoo"),
    `tool_timeout_sec = ${CODEX_STANDARD_TOOL_TIMEOUT_SECONDS}`,
    'disabled_tools = ["wait_for_message"]',
    "enabled = true",
    ...authTables("ufoo"),
    "",
    "[mcp_servers.ufoo_wait]",
    `url = ${tomlString(connection.endpoint)}`,
    ...authLines("ufoo_wait"),
    `tool_timeout_sec = ${CODEX_WAIT_TOOL_TIMEOUT_SECONDS}`,
    'enabled_tools = ["wait_for_message"]',
    "enabled = true",
    ...authTables("ufoo_wait"),
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

// Split only outside strings, comments, arrays and inline tables. A table-like
// line inside a multiline value is data, not a configuration section boundary.
function tomlStatements(text = "") {
  const statements = [];
  let start = 0;
  let quote = "";
  let comment = false;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (quote[0] === '"' && char === "\\") { index += 1; continue; }
      if (text.startsWith(quote, index)) { index += quote.length - 1; quote = ""; }
      continue;
    }
    if (!comment) {
      if (char === "#") comment = true;
      else if (char === '"' || char === "'") {
        quote = text.startsWith(char.repeat(3), index) ? char.repeat(3) : char;
        index += quote.length - 1;
      } else if (char === "[" || char === "{") depth += 1;
      else if (char === "]" || char === "}") depth -= 1;
    }
    if (char === "\n") {
      comment = false;
      if (!quote && depth === 0) {
        statements.push({ start, end: index + 1, text: text.slice(start, index + 1) });
        start = index + 1;
      }
    }
  }
  if (start < text.length) statements.push({ start, end: text.length, text: text.slice(start) });
  return statements;
}

function findTomlSections(text = "") {
  const sections = [];
  for (const statement of tomlStatements(text)) {
    const match = statement.text.match(/^[ \t]*(\[\[?)([^\r\n]+?)(\]\]?)[ \t]*(?:#.*)?\r?\n?$/);
    if (!match || match[1].length !== match[3].length) continue;
    sections.push({
      header: match[2].trim(),
      array: match[1].length === 2,
      start: statement.start,
      contentStart: statement.end,
    });
  }
  return sections.map((section, index) => ({
    ...section,
    end: index + 1 < sections.length ? sections[index + 1].start : text.length,
  }));
}

function collectCodexAuthentication(text, name) {
  const prefix = `(?:mcp_servers\\.${name}|mcp_servers\\."${name}")`;
  const mainPattern = new RegExp(`^${prefix}$`);
  const tablePattern = new RegExp(`^${prefix}\\.((?:http_headers|env_http_headers|oauth)(?:\\..*)?)$`);
  const keyPattern = /^[ \t]*(?:"(http_headers|env_http_headers|http_headers_helper|bearer_token_env_var|auth)"|'(http_headers|env_http_headers|http_headers_helper|bearer_token_env_var|auth)'|(http_headers|env_http_headers|http_headers_helper|bearer_token_env_var|auth))[ \t]*=/;
  const lines = [];
  const tables = [];
  for (const section of findTomlSections(text)) {
    if (section.array) continue;
    const body = text.slice(section.contentStart, section.end);
    if (mainPattern.test(section.header)) {
      for (const statement of tomlStatements(body)) {
        if (keyPattern.test(statement.text)) lines.push(statement.text.trimEnd());
      }
    }
    const match = section.header.match(tablePattern);
    if (match) tables.push({ suffix: match[1], body: body.trimEnd() });
  }
  return lines.length || tables.length ? { lines, tables } : null;
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
      || /^(?:mcp_servers\.ufoo|mcp_servers\."ufoo")\.(?:http_headers|env_http_headers|oauth)(?:\.|$)/
        .test(section.header)
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
  const tables = findTomlSections(source);
  const ranges = [];
  for (let index = 0; index < tables.length; index += 1) {
    if (!tables[index].array || tables[index].header !== "skills.config") continue;
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
  // Authentication belongs to the existing server configuration. Preserve it
  // instead of redefining a nested header table as an inline value or replacing
  // a host-managed credential source with the daemon's current token.
  const ufoo = collectCodexAuthentication(existing, "ufoo");
  const ufooWait = collectCodexAuthentication(existing, "ufoo_wait") || ufoo;
  const withoutManaged = removeManagedBlock(existing);
  const withoutLegacy = removeLegacyUfooTransportSections(withoutManaged);
  const withoutRetiredSkills = removeRetiredUfooSkillConfigBlocks(withoutLegacy);
  const trimmed = withoutRetiredSkills.trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ""}${buildCodexManagedBlock(connection, {
    ...(ufoo ? { ufoo } : {}),
    ...(ufooWait ? { ufoo_wait: ufooWait } : {}),
  })}\n`;
}

function configureCodexMcp(options = {}) {
  const projectRoot = options.projectRoot || resolveGlobalControllerProjectRoot();
  const connection = options.connection || readConnectionFiles(projectRoot);
  const target = codexConfigPath(options);
  const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const next = renderCodexConfig(existing, connection);
  if (options.dryRun === true) {
    const ufoo = collectCodexAuthentication(existing, "ufoo");
    const ufooWait = collectCodexAuthentication(existing, "ufoo_wait") || ufoo;
    const redactAuth = (auth) => ({
      lines: auth.lines.map((statement) => {
        const key = statement.slice(0, statement.indexOf("=")).trim();
        const value = /^(?:["']?)(?:http_headers|env_http_headers)["']?$/.test(key)
          ? '{ "<redacted>" = "<redacted>" }' : '"<redacted>"';
        return `${key} = ${value}`;
      }),
      tables: auth.tables.map((table) => ({ ...table, body: "# Existing authentication retained; values redacted." })),
    });
    const managedBlock = buildCodexManagedBlock({
      ...connection,
      token: "<redacted>",
    }, {
      ...(ufoo ? { ufoo: redactAuth(ufoo) } : {}),
      ...(ufooWait ? { ufoo_wait: redactAuth(ufooWait) } : {}),
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

function inspectCodexMcpConfig(options = {}) {
  const target = codexConfigPath(options);
  if (!fs.existsSync(target)) return { configured: false, changed: false, target };
  const existing = fs.readFileSync(target, "utf8");
  const configured = findTomlSections(existing).some((section) => isUfooMainSection(section.header));
  if (!configured) return { configured: false, changed: false, target };
  const connection = options.connection || readConnectionFiles(options.projectRoot || resolveGlobalControllerProjectRoot());
  return { configured: true, changed: renderCodexConfig(existing, connection) !== existing, target };
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
  inspectCodexMcpConfig,
  findTomlSections,
  removeLegacyUfooTransportSections,
  removeManagedBlock,
  removeRetiredUfooSkillConfigBlocks,
  renderCodexConfig,
  runMcpConfigureCli,
};

"use strict";

const { readConnectionFiles } = require("./mcpStdioProxy");
const { resolveGlobalControllerProjectRoot } = require("../projects");

/**
 * Tools intentionally hidden from daemon-managed SDK/ACP workers.
 * Managed workers receive each turn directly from their host runtime and
 * should never block themselves calling wait_for_message or unregistering.
 */
const MANAGED_WORKER_HIDDEN_MCP_TOOLS = new Set([
  "register_agent",
  "poll_inbox",
  "wait_for_message",
  "ack_bus",
  "unregister_agent",
]);

function resolveManagedMcpConnection(controllerRoot = "") {
  try {
    const root = controllerRoot || resolveGlobalControllerProjectRoot();
    const conn = readConnectionFiles(root);
    if (!conn || !conn.endpoint || !conn.token) return null;
    return conn;
  } catch {
    return null;
  }
}

function buildManagedMcpHeaders({
  token = "",
  projectRoot = "",
  subscriber = "",
} = {}) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Ufoo-Launch-Mode": "internal",
  };
  if (projectRoot) headers["X-Ufoo-Project-Root"] = String(projectRoot);
  if (subscriber) headers["X-Ufoo-Subscriber"] = String(subscriber);
  return headers;
}

/**
 * Build ACP `session/new` `mcpServers` array for a managed ACP worker.
 */
function buildAcpMcpServers({
  projectRoot = "",
  subscriber = "",
  controllerRoot = "",
} = {}) {
  const conn = resolveManagedMcpConnection(controllerRoot);
  if (!conn) return [];
  const headerObj = buildManagedMcpHeaders({
    token: conn.token,
    projectRoot,
    subscriber,
  });
  return [{
    name: "ufoo",
    type: "http",
    url: conn.endpoint,
    headers: Object.entries(headerObj).map(([name, value]) => ({ name, value })),
  }];
}

/**
 * Build Claude Agent SDK `mcpServers` config map for a managed Claude worker.
 */
function buildClaudeMcpServers({
  projectRoot = "",
  subscriber = "",
  controllerRoot = "",
} = {}) {
  const conn = resolveManagedMcpConnection(controllerRoot);
  if (!conn) return null;
  return {
    ufoo: {
      type: "http",
      url: conn.endpoint,
      headers: buildManagedMcpHeaders({
        token: conn.token,
        projectRoot,
        subscriber,
      }),
    },
  };
}

/**
 * Build Codex SDK `config` object (`mcp_servers.ufoo`) for a managed Codex worker.
 * `@openai/codex-sdk` serializes `codexOptions.config` into `--config key=value`
 * TOML overrides for `codex exec`.
 */
function buildCodexMcpConfig({
  projectRoot = "",
  subscriber = "",
  controllerRoot = "",
} = {}) {
  const conn = resolveManagedMcpConnection(controllerRoot);
  if (!conn) return null;
  return {
    mcp_servers: {
      ufoo: {
        url: conn.endpoint,
        http_headers: buildManagedMcpHeaders({
          token: conn.token,
          projectRoot,
          subscriber,
        }),
        disabled_tools: [...MANAGED_WORKER_HIDDEN_MCP_TOOLS],
        enabled: true,
      },
    },
  };
}

module.exports = {
  MANAGED_WORKER_HIDDEN_MCP_TOOLS,
  resolveManagedMcpConnection,
  buildManagedMcpHeaders,
  buildAcpMcpServers,
  buildClaudeMcpServers,
  buildCodexMcpConfig,
};

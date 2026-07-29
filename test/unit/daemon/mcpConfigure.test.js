"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  configureCodexMcp,
  renderCodexConfig,
} = require("../../../src/runtime/daemon/mcpConfigure");

describe("MCP host configuration", () => {
  const connection = {
    endpoint: "http://127.0.0.1:47631/mcp",
    token: "local-test-token",
  };

  test("replaces a legacy Codex stdio section while preserving unrelated config", () => {
    const existing = [
      'model = "gpt-test"',
      "",
      "[mcp_servers.ufoo]",
      'command = "ufoo"',
      'args = ["mcp"]',
      "",
      "[mcp_servers.other]",
      'url = "https://example.test/mcp"',
      "",
    ].join("\n");

    const next = renderCodexConfig(existing, connection);
    expect(next).toContain('model = "gpt-test"');
    expect(next).toContain("[mcp_servers.other]");
    expect(next).toContain("[mcp_servers.ufoo]");
    expect(next).toContain('url = "http://127.0.0.1:47631/mcp"');
    expect(next).toContain('Authorization = "Bearer local-test-token"');
    expect(next).not.toContain('command = "ufoo"');
    expect((next.match(/\[mcp_servers\.ufoo\]/g) || [])).toHaveLength(1);
  });

  test("writes a private config, creates a backup, and is idempotent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-config-"));
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, 'model = "gpt-test"\n');
    try {
      const first = configureCodexMcp({ configPath, connection });
      expect(first.changed).toBe(true);
      expect(first.backup).toBeTruthy();
      expect(fs.existsSync(first.backup)).toBe(true);
      if (process.platform !== "win32") {
        expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      }

      const second = configureCodexMcp({ configPath, connection });
      expect(second.changed).toBe(false);
      expect(second.backup).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("redacts the bearer capability from dry-run output", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-config-dry-"));
    const configPath = path.join(root, "config.toml");
    try {
      const result = configureCodexMcp({
        configPath,
        connection,
        dryRun: true,
      });
      expect(result.content).toContain("Bearer <redacted>");
      expect(result.content).not.toContain(connection.token);
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

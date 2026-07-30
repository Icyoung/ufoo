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
    expect(next).toContain("[mcp_servers.ufoo_wait]");
    expect(next).toContain('url = "http://127.0.0.1:47631/mcp"');
    expect(next).toContain('Authorization = "Bearer local-test-token"');
    expect(next).toContain('disabled_tools = ["wait_for_message"]');
    expect(next).toContain('enabled_tools = ["wait_for_message"]');
    expect(next).toContain("tool_timeout_sec = 31536000");
    expect(next).toContain("[mcp_servers.ufoo_wait.tools.wait_for_message]");
    expect(next).not.toContain('command = "ufoo"');
    expect((next.match(/\[mcp_servers\.ufoo\]/g) || [])).toHaveLength(1);
    expect((next.match(/\[mcp_servers\.ufoo_wait\]/g) || [])).toHaveLength(1);
  });

  test("replaces a previous dedicated wait server without duplicating its tables", () => {
    const existing = [
      "[mcp_servers.ufoo_wait]",
      'url = "http://old.test/mcp"',
      "tool_timeout_sec = 999",
      "",
      "[mcp_servers.ufoo_wait.tools.wait_for_message]",
      'approval_mode = "prompt"',
      "",
    ].join("\n");

    const next = renderCodexConfig(existing, connection);

    expect(next).not.toContain("http://old.test/mcp");
    expect((next.match(/\[mcp_servers\.ufoo_wait\]/g) || [])).toHaveLength(1);
    expect((next.match(/\[mcp_servers\.ufoo_wait\.tools\.wait_for_message\]/g) || []))
      .toHaveLength(1);
    expect(next).toContain('approval_mode = "approve"');
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

  test("removes only retired u-foo package skill config blocks", () => {
    const existing = [
      'model = "gpt-test"',
      "",
      "[[skills.config]]",
      'path = "/opt/homebrew/lib/node_modules/u-foo/modules/bus/SKILLS/ubus/SKILL.md"',
      "enabled = false",
      "",
      "[[skills.config]]",
      'path = "/Users/test/.agents/skills/ubus/SKILL.md"',
      "enabled = false",
      "",
      "[[skills.config]]",
      'path = "/Users/test/.agents/skills/keep-me/SKILL.md"',
      "enabled = true",
      "",
      "[features]",
      "js_repl = true",
      "",
    ].join("\n");

    const next = renderCodexConfig(existing, connection);
    expect(next).not.toContain(
      "/opt/homebrew/lib/node_modules/u-foo/modules/bus/SKILLS/ubus/SKILL.md"
    );
    expect(next).toContain("/Users/test/.agents/skills/ubus/SKILL.md");
    expect(next).toContain("/Users/test/.agents/skills/keep-me/SKILL.md");
    expect(next).toContain("[features]");
  });

  test("dry-run returns only a redacted managed block, never existing config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-config-dry-"));
    const configPath = path.join(root, "config.toml");
    const unrelatedSecret = "third-party-secret-that-must-not-be-printed";
    fs.writeFileSync(
      configPath,
      [
        "[mcp_servers.other]",
        `http_headers = { Authorization = "Bearer ${unrelatedSecret}" }`,
        "",
      ].join("\n")
    );
    try {
      const result = configureCodexMcp({
        configPath,
        connection,
        dryRun: true,
      });
      expect(result.managed_block).toContain("Bearer <redacted>");
      expect(result.managed_block).not.toContain(connection.token);
      expect(result.managed_block).not.toContain(unrelatedSecret);
      expect(result).not.toHaveProperty("content");
      expect(fs.readFileSync(configPath, "utf8")).toContain(unrelatedSecret);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

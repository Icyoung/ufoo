"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  configureCodexMcp,
  renderCodexConfig,
  inspectCodexMcpConfig,
  findTomlSections,
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

  test("preserves nested headers without redefining them as an inline value", () => {
    const existing = [
      '[model_providers.custom.http_headers]',
      'Authorization = "provider-owned-key"',
      '[mcp_servers.ufoo]',
      'url = "http://old.test/mcp"',
      '[mcp_servers.ufoo.tools.dispatch_message]',
      'approval_mode = "prompt"',
      '[mcp_servers.ufoo.http_headers]',
      'Authorization = "host-owned-key"',
      '"X-Custom" = "keep-this-header"',
      '[[skills.config]]',
      'path = "/Users/test/.agents/skills/keep-me/SKILL.md"',
      'enabled = false',
      '',
    ].join("\n");

    const next = renderCodexConfig(existing, connection);

    expect(next).not.toContain("http_headers =");
    expect(next).not.toContain(connection.token);
    expect(next).toContain('[model_providers.custom.http_headers]\nAuthorization = "provider-owned-key"');
    expect(next).toContain('[mcp_servers.ufoo.tools.dispatch_message]\napproval_mode = "prompt"');
    expect(next).toContain('[[skills.config]]\npath = "/Users/test/.agents/skills/keep-me/SKILL.md"\nenabled = false');
    for (const name of ["ufoo", "ufoo_wait"]) {
      expect(next.split(`[mcp_servers.${name}.http_headers]`)).toHaveLength(2);
      expect(next).toContain(`[mcp_servers.${name}.http_headers]\nAuthorization = "host-owned-key"\n"X-Custom" = "keep-this-header"`);
    }
    expect(renderCodexConfig(next, connection)).toBe(next);
  });

  test("preserves multiline authentication and each server's own credential source", () => {
    const existing = [
      '[mcp_servers."ufoo"]',
      'url = "http://old.test/mcp"',
      'http_headers = {',
      '  Authorization = "host-owned-key",',
      '  "X-Custom" = "keep-this-header",',
      '}',
      '[mcp_servers.ufoo_wait]',
      'url = "http://old.test/mcp"',
      'bearer_token_env_var = "HOST_WAIT_TOKEN"',
      '',
    ].join("\n");
    const next = renderCodexConfig(existing, connection);
    expect(next).toContain('http_headers = {\n  Authorization = "host-owned-key",\n  "X-Custom" = "keep-this-header",\n}');
    expect(next).toContain('bearer_token_env_var = "HOST_WAIT_TOKEN"');
    expect(next).not.toContain(connection.token);
    expect(renderCodexConfig(next, connection)).toBe(next);
  });

  test("recognizes array table boundaries and ignores section text inside multiline strings", () => {
    const existing = [
      '[mcp_servers.ufoo]',
      'command = "ufoo"',
      '[[skills.config]]',
      'path = "/Users/test/keep/SKILL.md"',
      'description = """',
      '[mcp_servers.ufoo]',
      '[[skills.config]]',
      '"""',
      'enabled = false',
      '',
    ].join("\n");
    expect(findTomlSections(existing).map(({ header, array }) => ({ header, array })))
      .toEqual([{ header: "mcp_servers.ufoo", array: false }, { header: "skills.config", array: true }]);
    const next = renderCodexConfig(existing, connection);
    expect(next).toContain(existing.slice(existing.indexOf('[[skills.config]]')).trimEnd());
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
      expect(inspectCodexMcpConfig({ configPath, connection })).toMatchObject({ configured: true, changed: false });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects missing resident-wait configuration without returning secrets", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-drift-"));
    const configPath = path.join(root, "config.toml");
    try {
      fs.writeFileSync(configPath, '[mcp_servers.ufoo]\nurl = "http://127.0.0.1:47631/mcp"\n');
      const status = inspectCodexMcpConfig({ configPath, connection });
      expect(status).toMatchObject({ configured: true, changed: true });
      expect(JSON.stringify(status)).not.toContain(connection.token);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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

  test("dry-run shows retained nested authentication without printing its values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-mcp-auth-preview-"));
    const configPath = path.join(root, "config.toml");
    const existing = '[mcp_servers.ufoo]\nurl = "http://old.test/mcp"\n[mcp_servers.ufoo.http_headers]\nAuthorization = "host-owned-secret"\n';
    fs.writeFileSync(configPath, existing);
    try {
      const result = configureCodexMcp({ configPath, connection, dryRun: true });
      expect(result.managed_block).toContain("[mcp_servers.ufoo.http_headers]");
      expect(result.managed_block).toContain("[mcp_servers.ufoo_wait.http_headers]");
      expect(result.managed_block).not.toContain("http_headers =");
      expect(JSON.stringify(result)).not.toContain("host-owned-secret");
      expect(JSON.stringify(result)).not.toContain(connection.token);
      expect(fs.readFileSync(configPath, "utf8")).toBe(existing);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

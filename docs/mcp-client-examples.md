# External MCP Client Configuration Examples

Date: 2026-05-29
Status: reference
Scope: show how Claude Desktop and Codex connect to the `ufoo` global MCP bridge.

## Prerequisites

- `ufoo` installed globally (`npm i -g u-foo`)
- At least one project daemon running (`cd /path/to/project && ufoo daemon start`)

## Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ufoo": {
      "command": "ufoo",
      "args": ["mcp"]
    }
  }
}
```

The bridge auto-starts the home-scoped global controller daemon on first use.

## Claude Code (CLI)

Add to project `.claude/settings.json` or `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ufoo": {
      "command": "ufoo",
      "args": ["mcp"]
    }
  }
}
```

## Codex

Add to `codex.json` or pass via CLI:

```json
{
  "mcpServers": {
    "ufoo": {
      "command": "ufoo",
      "args": ["mcp"]
    }
  }
}
```

## Walkthrough: Register → Poll → Ack

Once the MCP bridge is configured, an external agent session can participate
in the ufoo bus with these tool calls:

### 1. Discover available projects

```json
{ "name": "read_project_registry" }
```

Returns a list of registered project roots with daemon status.

### 2. Register into a project

```json
{
  "name": "register_agent",
  "arguments": {
    "project_root": "/path/to/project",
    "agent_type": "claude",
    "nickname": "my-claude"
  }
}
```

Returns `subscriber_id` — use it for all subsequent calls.

### 3. Poll inbox for messages

```json
{
  "name": "poll_inbox",
  "arguments": {
    "project_root": "/path/to/project",
    "subscriber": "claude-code:abc123"
  }
}
```

### 4. Acknowledge processed messages

```json
{
  "name": "ack_bus",
  "arguments": {
    "project_root": "/path/to/project",
    "subscriber": "claude-code:abc123"
  }
}
```

### 5. Send a message to another agent

```json
{
  "name": "dispatch_message",
  "arguments": {
    "project_root": "/path/to/project",
    "subscriber": "claude-code:abc123",
    "target": "ucode-1",
    "message": "Please review the auth module."
  }
}
```

### 6. Unregister on exit

```json
{
  "name": "unregister_agent",
  "arguments": {
    "project_root": "/path/to/project",
    "subscriber": "claude-code:abc123"
  }
}
```

## Disabling auto-start

By default the bridge auto-starts the global controller daemon. To skip:

```bash
ufoo mcp --no-auto-start
```

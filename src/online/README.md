# ufoo-online (Phase 1)

Minimal WebSocket relay implementing the Phase 1 protocol.

- WebSocket path: `/ufoo/online`
- Handshake: `hello` → `hello_ack` → `auth_required` → `auth`
- Control: `join`, `leave`, `ping`, `pong`
- Routing: direct (`to`) or channel broadcast (`channel`)
- Wake: relay `payload.kind = "wake"` and emit `type = "wake"` notifications
- Bridge: local bus <-> online relay (message + decision sync)

See `docs/ufoo-online/PROTOCOL.md` for the draft protocol.

## Token auth

Phase 1 expects token auth. Tokens can be provided in one of three ways:

1. `new OnlineServer({ tokens: ["token-a", "token-b"] })`
2. `new OnlineServer({ tokens: { "token-a": "agent-1" } })`
3. `new OnlineServer({ tokenFile: "/path/to/tokens.json" })`

If no tokens are configured, the server accepts any token (development mode).

## Heartbeat / idle timeout

Defaults:
- `idleTimeoutMs`: 30000
- `sweepIntervalMs`: 10000

When a connection is idle longer than `idleTimeoutMs`, the server sends:
```json
{ "type": "error", "code": "IDLE_TIMEOUT", "error": "Disconnected due to inactivity" }
```

## Nickname scope

`nicknameScope` controls uniqueness enforcement:

- `global` (default): nickname must be unique across server
- `world`: nickname unique per `client.world`

Example:
```js
new OnlineServer({ nicknameScope: "world" })
```

### Token persistence (1:1 per agent)

Recommended storage (per machine): `~/.ufoo/online/tokens.json`

```json
{
  "agents": {
    "claude-code:abc123": { "token": "tok-1", "server": "wss://ufoo.online" },
    "codex:def456": { "token": "tok-2", "server": "wss://ufoo.online" }
  }
}
```

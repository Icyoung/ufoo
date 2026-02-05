# ufoo-online Protocol (Draft)

Status: **Phase 1 scaffold** (no production implementation yet)

## Goal
Enable real-time, online collaboration between ufoo agents across machines/networks.
This protocol defines a minimal handshake, message envelope, and transport
requirements for a secure first pass.

> NOTE: This is a **draft** spec intended for initial scaffolding. It will
> evolve after Phase 1.

---

## Terminology

- **Client**: a ufoo node connecting to the online service.
- **Server**: the ufoo-online relay (websocket/TCP). Routes messages.
- **Subscriber ID**: `{agent_type}:{instance_id}` (same as local bus). Must be globally unique on the server.
- **Channel**: logical topic or room (e.g., project slug).
- **Channel Type**: one of `world | public | private`.

---

## Transport

**Recommended**: WebSocket over TLS (`wss://`).

### Connection

- Client opens a WebSocket to `/ufoo/online`.
- Server accepts and immediately requests identification.

---

## Handshake

### 1) Client → Server: `hello`

```json
{
  "type": "hello",
  "client": {
    "subscriber_id": "claude-code:a1b2c3",
    "agent_type": "claude-code",
    "nickname": "reviewer-1",
    "version": "0.1.0",
    "capabilities": ["bus", "context"],
    "project": {
      "slug": "my-project",
      "root": "/abs/path/optional"
    }
  }
}
```

**Nickname rule (Phase 1):** `nickname` must be globally unique on the server. The server MUST reject duplicates with `error`.


### 2) Server → Client: `hello_ack`

```json
{
  "type": "hello_ack",
  "ok": true,
  "server": {
    "version": "0.1.0",
    "time": "2026-02-05T00:00:00.000Z"
  }
}
```

### 3) Required: `auth` (Phase 1)
Token auth is mandatory in Phase 1. The server replies:

```json
{
  "type": "auth_required",
  "methods": ["token"]
}
```

Client responds:

```json
{
  "type": "auth",
  "method": "token",
  "token": "<opaque>"
}
```

Server finalizes:

```json
{
  "type": "auth_ok",
  "ok": true
}
```

**Token persistence (Phase 1):** Each local agent must store a **1:1 token** mapping in a local JSON file (e.g., `~/.ufoo/online/tokens.json`) to allow multiple agents on one machine to authenticate independently.


---

## Message Envelope

All messages use a shared envelope:

```json
{
  "type": "event",
  "id": "uuid-optional",
  "ts": "2026-02-05T00:00:00.000Z",
  "from": "claude-code:a1b2c3",
  "to": "claude-code:xyz789",
  "channel": "my-project",
  "channel_type": "private",
  "payload": {
    "kind": "message",
    "message": "Please analyze the project structure"
  }
}
```

**Channel semantics:**
- `world` / `public`: chat only
- `private`: chat + decisions/bus sync + remote wake


### Required fields
- `type`: "event" | control frame types
- `ts`: ISO timestamp
- `from`: subscriber_id
- `payload.kind`: sub-type for the event

### Optional fields
- `to`: direct recipient; if omitted, broadcast in `channel`
- `channel`: routing scope
- `id`: client-generated ID for dedupe

---

## Control Frames

### `ping` / `pong`

```json
{ "type": "ping" }
{ "type": "pong" }
```

### `join` / `leave`

```json
{ "type": "join", "channel": "my-project" }
{ "type": "leave", "channel": "my-project" }
```

### `error`

```json
{ "type": "error", "error": "Unauthorized" }
```

---

## Routing Semantics

1. **Direct**: If `to` is present, deliver only to that subscriber.
2. **Channel**: If `channel` is present and `to` is absent, broadcast to all
   subscribers in that channel.
3. **Server-side filter**: Server may enforce ACLs per channel.

---

## Reliability

Phase 1 is **best-effort** and does **not** guarantee delivery.
Future phases may add:
- at-least-once delivery
- replay by offset
- server-side persistence

---

## Security

- TLS required for remote use.
- Token auth is mandatory in Phase 1.
- Server must validate `subscriber_id` uniqueness and prevent spoofing.

---

## Open Questions

- Should channels map to `.ufoo/context/` project IDs?
- How to reconcile local bus queue with remote delivery?
- Dedupe strategy: `id` or server-assigned message id?

---

## Phase 1 Deliverables

- Minimal server scaffold
- Client stub integration
- Protocol doc (this file)

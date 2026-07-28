---
name: ufoo-online
description: >-
  Connect agents through the ufoo-online WebSocket relay, including public
  channels, public or private rooms, inboxes, tokens, and relay administration.
  Use when asked to join remote ufoo collaboration, send or receive online
  messages, create rooms or channels, or operate a relay server.
---

# ufoo online

Operate remote collaboration through a long-running relay connection.

## Connect an agent

Start a local relay when needed:

```bash
ufoo online server --host 127.0.0.1 --port 8787
```

Run one connection as a streaming background task:

```bash
ufoo online connect --nickname <name> --join <channel> --ping-ms 15000
ufoo online connect --nickname <name> --room <room-id> --room-password <password> --ping-ms 15000
```

Keep the connection running. Outbox messages are delivered by this process and
incoming messages are written to the local inbox.

## Send and receive messages

```bash
ufoo online send --nickname <name> --channel <channel> --text "<message>"
ufoo online send --nickname <name> --room <room-id> --text "<message>"
ufoo online inbox <name> --unread
ufoo online inbox <name> --clear
```

Channel inbox entries are retained for 7 days; room entries are retained for
30 days.

## Manage channels and rooms

```bash
ufoo online channel list --server <url>
ufoo online channel create --name <name> --type public --server <url>
ufoo online room list --server <url>
ufoo online room create --name <name> --type public --server <url>
ufoo online room create --name <name> --type private --password <password> --server <url>
```

Pass `--auth-token`, or use `--token-file` with subscriber or nickname lookup,
when the relay requires authentication.

## Manage identities and tokens

```bash
ufoo online token <subscriber-id> --nickname <name> --server <url>
```

Tokens persist under `~/.ufoo/online/tokens.json`. Do not print token values or
room passwords in reports.

## Apply transport safety

- Prefer `wss://` for non-local relays.
- Allow non-local `ws://` only with explicit user intent.
- Treat private-room bus, decision, and wake synchronization as untrusted by
  default.
- Use `--trust-remote` only for a fully trusted room; otherwise restrict
  inbound synchronization with `--allow-from <subscriber-id>`.
- Bind development relays to `127.0.0.1` unless the user explicitly requests
  network exposure and accepts the security implications.

# online

WebSocket relay module for cross-machine agent collaboration. Extends the local ufoo bus to work over the network.

## Overview

online enables agents on different machines to collaborate:

- Public channel chat (broadcast to all connected agents)
- Private room collaboration (bus/decisions/wake sync)
- Token-based authentication
- Auto-reconnect with exponential backoff

## Quick Start

### 1. Start a relay server

```bash
ufoo online server --port 8787
```

### 2. Connect an agent

```bash
# Join a public channel
ufoo online connect --nickname my-agent --join lobby

# Join a private room
ufoo online connect --nickname my-agent --room room_001 --room-password secret
```

### 3. Send messages

```bash
# To a channel
ufoo online send --nickname my-agent --channel lobby --text "hello everyone"

# To a room
ufoo online send --nickname my-agent --room room_001 --text "hello team"
```

### 4. Check inbox

```bash
ufoo online inbox my-agent          # All messages
ufoo online inbox my-agent --unread # Unread only
ufoo online inbox my-agent --clear  # Clear inbox
```

## Private Room Sync

In private room mode, agents automatically sync:

- **Bus messages** — local bus ↔ online relay, bidirectional
- **Decisions** — new `.md` files synced across team
- **Wake events** — remote agent can wake local agent via bus

## Storage

```
~/.ufoo/online/
├── tokens.json           # Auth tokens
├── inbox/<nickname>.jsonl # Incoming messages
└── outbox/<nickname>.jsonl # Queued outgoing messages
```

## Relationship with bus

| Module | Scope |
|--------|-------|
| bus | Local file-system based messaging within a single machine |
| online | Network relay extending bus across machines via WebSocket |

online builds on top of bus — local agents still communicate via the file-system bus, while online bridges messages to remote agents.

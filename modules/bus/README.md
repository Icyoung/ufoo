# bus

File-system based Agent event bus for async communication between multiple AI Coding Agents.

## Overview

bus solves communication problems in multi-agent collaboration:

- Multiple Claude Code instances collaborating on the same project
- Communication between different AI tools (Claude Code, Cursor, Copilot)
- Task delegation and response
- Broadcast messages

## Installation

Initialize via ufoo:

```bash
ufoo init --modules context,bus
```

## Directory Structure

```
.bus/
├── bus.json      # Bus metadata + subscriber status
├── events/       # Event stream (JSONL, sharded by date)
├── offsets/      # Each Agent's consumption progress
└── queues/       # Targeted event queues
```

## Usage

### Join Bus

```bash
SUBSCRIBER=$(ufoo bus join | tail -n 1)
# Output: claude-code:a1b2c3
```

### Check Pending Messages

```bash
ufoo bus check "$SUBSCRIBER"
```

### Send Messages

```bash
# Send to specific instance
ufoo bus send "claude-code:abc123" "Please help me review"

# Send to all instances of same type
ufoo bus send "claude-code" "Everyone please review"

# Broadcast to all
ufoo bus broadcast "I completed feature-x"
```

### View Status

```bash
ufoo bus status
```

## Notifications/Alerts (no key injection, recommended)

If you want to receive "new message alerts" while running Codex/Claude in another terminal, use **agent-side alert/listen** (avoids IME/accessibility permission/window positioning fragmentation issues):

```bash
SUBSCRIBER=$(ufoo bus join | tail -n 1)

# Background alert: title badge + bell + optional macOS notification center
ufoo bus alert "$SUBSCRIBER" 1 --notify --daemon

# Or: foreground continuous print of new messages (suitable for a side terminal)
ufoo bus listen "$SUBSCRIBER" --from-beginning
```

## Unattended Auto-Execute (recommended)

If you need **Claude A to notify Claude B / Codex C and have the target auto-execute** (e.g., auto-trigger `/ubus`), use the bus daemon:

1) First `join` in each terminal session (records `tty`, also records `TMUX_PANE` if in tmux):

```bash
SUBSCRIBER=$(ufoo bus join | tail -n 1)
```

2) Start the bus daemon in the project (runs as background daemon):

```bash
ufoo bus daemon --interval 1 --daemon
```

3) After sending a message, the daemon injects `/ubus` into the target session and presses Enter:
- tmux: `send-keys`
- Terminal.app (pure Automation): `do script` (no Accessibility needed, but requires Automation authorization; compatibility depends on whether target program accepts input)
- Terminal.app (Accessibility): System Events (needs Accessibility), injection sequence is Escape + paste + Return (avoids IME issues)

Tips:
- Terminal.app backend depends on `tty` in `bus.json`. Execute `join` in the target terminal session (ensure `tty` is not `not a tty`).
- Pure Automation backend needs one-time authorization: System Preferences → Privacy & Security → Automation (allow script to control Terminal).
- Accessibility backend needs one-time authorization: System Preferences → Privacy & Security → Accessibility (for Terminal / script host).

Stop/view status:

```bash
ufoo bus daemon --status
ufoo bus daemon --stop
```

## Subscriber ID Format

```
{agent_type}:{instance_id}

Examples:
  claude-code:a1b2c3
  cursor-ai:main
  copilot:session1
```

## Relationship with context

| Module | Problem Solved |
|--------|----------------|
| context | Shared context, decision recording, knowledge persistence |
| bus | Real-time communication, task delegation, message passing |

Both are independent peer modules that can be used separately or together.

---
name: ubus
description: |
  Poll event bus, check pending messages.
  Use when: (1) check if other Agents sent messages, (2) view bus status, (3) periodic polling.
  If not yet joined bus, will auto-join.
---

# /ubus - Event Bus Polling

Check pending messages on the event bus.

## Arguments

- `/ubus` - Check messages and show status
- `/ubus watch` - Start background auto-notification (title badge + bell + notification center)
- `/ubus stop` - Stop background auto-notification
- `/ubus listen` - Foreground continuous listener, print new messages (suitable for side terminal)
- `/ubus auto` - Unattended auto-execute (auto-inject `/ubus` and press Enter)

## Execution Flow

### 1. Check if .ufoo/bus exists

```bash
if [[ ! -d ".ufoo/bus" ]]; then
  echo "Event bus not initialized, please run /uinit and select bus module"
  exit
fi
```

### 2. Get or create subscriber ID

**IMPORTANT**: Always check for existing subscriber ID first to avoid creating duplicates.

```bash
# Reuse existing subscriber first (env -> whoami), join only if missing
SUBSCRIBER="${UFOO_SUBSCRIBER_ID:-$(ufoo bus whoami 2>/dev/null || true)}"
if [ -n "$SUBSCRIBER" ]; then
  echo "Using existing subscriber ID: $SUBSCRIBER"
else
  # Not launched via uclaude/ucodex, need to join manually
  SUBSCRIBER=$(ufoo bus join | tail -n 1)
  echo "Joined event bus: $SUBSCRIBER"
  # Example output: codex:0e293156 (nickname: codex-1)
fi
```

**Why this matters**:
- `uclaude`/`ucodex` automatically set `UFOO_SUBSCRIBER_ID` during launch
- `ufoo bus whoami` can recover current ID even when env is missing
- Re-joining may create identity drift and message routing issues
- Always reuse existing ID when available

To join with a custom nickname:

```bash
ufoo bus join [session-id] [agent-type] "your-nickname"
# Example: ufoo bus join abc123 claude-code "architect"
```

### 3. Handle arguments

If argument is `watch`, use **Bash tool's `run_in_background: true`** to start background notification:

```bash
# Title badge + bell + notification center (no accessibility permission needed)
ufoo bus alert "$SUBSCRIBER" 2 --notify --daemon
```

If argument is `listen`, foreground blocking listener (no background task tool needed):

```bash
ufoo bus listen "$SUBSCRIBER" --from-beginning
```

If argument is `auto`, unattended auto-execute:

```bash
# Start daemon (background resident), auto-inject /ubus + Enter on new message
ufoo bus daemon --daemon
```

Tips:
- Need to use `uclaude`/`ucodex` wrapper to start Claude Code/Codex (auto-records tty)
- Terminal.app needs Accessibility permission (for keyboard input injection)

If argument is `stop`, stop background notification:

```bash
ufoo bus alert "$SUBSCRIBER" --stop
```

### 4. Check pending events

```bash
ufoo bus check "$SUBSCRIBER"
```

The system automatically prefixes each message with `[ufoo]<from:id(nickname)>` to identify the sender. You do not need to add this prefix yourself.

If pending events exist, output looks like:

```
[ufoo]<from:claude-code:abc123(architect)>
  Type: message/targeted/message
  Content: {"message":"review src/main.ts","injection_mode":"immediate"}
```

- The sender ID and nickname are in the `[ufoo]<from:...>` line — use the ID to reply
- The actual task is in `Content.message`

### 5. IMPORTANT: Acknowledge messages after handling

After you have read and processed the messages, you MUST acknowledge them to prevent repeated notifications:

```bash
ufoo bus ack "$SUBSCRIBER"
```

**This is critical** - if you don't ack, the daemon will keep injecting `/ubus` commands.

If there's nothing to do (no actionable task), just ack immediately without sending a reply.

### 6. Routing Override

If the message explicitly instructs you to report to a specific PM/DEV/TEST ID, **send the result to that ID instead of the publisher**.

### 5. Show bus status

```bash
ufoo bus status
```

Output (now includes nicknames):

```
=== Event Bus Status ===
My identity: claude-code:xyz789
Online agents: 2
  - claude-code:abc123 (architect)
  - claude-code:xyz789 (dev-lead)
Recent events: 5
```

## Managing Nicknames

### View and Change Nicknames

```bash
# Change an agent's nickname
ufoo bus rename <subscriber-id> "new-nickname"
# Example: ufoo bus rename claude-code:47b1d525 "backend-dev"

# Nickname alias command
ufoo bus nick <subscriber-id> "new-nickname"
```

**Important Notes:**
- Nicknames must be globally unique
- Cannot change nickname during join (use `rename` command instead)
- Re-joining with same subscriber ID will reuse existing nickname
- Auto-generated nicknames: `codex-1`, `codex-2`, `claude-1`, `claude-2`, etc.

## Handling Received Messages

When receiving targeted messages:

1. **Understand request** - Read message content
2. **Execute task** - If task delegation, execute it
3. **Reply to sender** - Send response after completion

```bash
ufoo bus send "<sender-id>" "<reply-content>"
```

## Sending Messages

### Smart Routing (when you don't know the target ID)

If the user says "notify codex to do X" without specifying an ID, use smart routing:

```bash
# Step 1: Find candidates
ufoo bus resolve "$SUBSCRIBER" codex

# Output shows:
# - If only 1 codex: directly shows the ID
# - If multiple: shows each with nickname and message history
```

Based on the output:
- **Single match**: Use that ID directly
- **Multiple matches**: Analyze the message history to find the right target
  - Look for context clues in previous conversations
  - If still unclear, ask the user which one, or send to all of that type

### Direct Send

```bash
# Send to specific Agent by full ID
ufoo bus send "claude-code:abc123" "message content"

# Send to specific Agent by nickname (NEW!)
ufoo bus send "architect" "message content"
ufoo bus send "backend-dev" "message content"

# Send to all Agents of same type
ufoo bus send "codex" "message content"

# Broadcast to everyone
ufoo bus broadcast "message content"
```

**Target Resolution Priority:**
1. Exact subscriber ID (e.g., `claude-code:abc123`)
2. Nickname match (e.g., `architect` → resolves to subscriber ID)
3. Agent type (e.g., `codex` → all codex agents)
4. Wildcard (`*` → all agents)

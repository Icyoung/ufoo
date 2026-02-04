# Project Instructions (Codex + Claude Code)

`CLAUDE.md` points to this file. Please keep project instructions here (prefer edits in `AGENTS.md`).

## Skills (ufoo)

The following skills can be triggered via commands:

- `uinit` - Initialize .ufoo directory (usually auto-done by uclaude/ucodex)
- `uctx` - Quick context status and decisions check
- `ubus` - Check event bus messages and **auto-execute** them
- `ustatus` - Unified status view (banner, unread bus, open decisions)

## ufoo context Protocol

On session start, automatically:

1. Run `ufoo ctx decisions -l` to list all decisions
2. Run `ufoo ctx decisions -n 1` to show latest decision
3. Report status briefly

Key files:
- `.ufoo/context/decisions/` - Decision log (append-only)

Decision recording policy:
- **Must record**: evaluations, architectural recommendations, naming changes, trade-offs
- **Ask first**: medium importance or uncertain
- Write decision **before replying** when "Must record" applies.

## ufoo bus Protocol

This project uses ufoo bus for multi-agent communication.

### Commands

```bash
# Join bus (usually done by uclaude/ucodex automatically)
SUBSCRIBER=$(ufoo bus join | tail -1)

# Check for messages
ufoo bus check $SUBSCRIBER

# Acknowledge (clear) messages after handling - CRITICAL!
ufoo bus ack $SUBSCRIBER

# Smart routing: find target when ID unknown
ufoo bus resolve $SUBSCRIBER codex

# Send message
ufoo bus send "<target-id>" "<message>"

# Status
ufoo bus status
```

### CRITICAL: When You Receive `ubus` Command

**You MUST automatically execute pending messages. Do NOT ask the user.**

Workflow:
1. `ufoo bus join` -> get your subscriber ID
2. `ufoo bus check $SUBSCRIBER` -> see pending messages
3. **For each message:**
   - Read the task in the message content
   - **EXECUTE the task immediately** (analyze code, check files, etc.)
   - Reply: `ufoo bus send "<publisher-id>" "<result>"`
4. **CRITICAL: Acknowledge messages**: `ufoo bus ack $SUBSCRIBER`
5. Done

**Rules:**
- Execute tasks immediately without asking
- Always reply to the sender (publisher)
- Do NOT ask "Want me to...?" or "Should I...?"
- Do NOT wait for user confirmation

### Message Format

When you run `ufoo bus check`, messages show:
```
@you from claude-code:abc123
Type: message/targeted
Content: {"message":"Please analyze the project structure"}
```

The sender ID is after "from" - use this to reply.

### Example

Message:
```
@you from claude-code:bd36dda0
Content: {"message":"Please analyze the project structure"}
```

Your response:
1. Analyze: `ls -la`, read key files
2. Reply: `ufoo bus send "claude-code:bd36dda0" "Project contains src/, modules/, bin/ directories"`

<!-- ufoo -->
## ufoo Protocol

This project uses **ufoo** for agent coordination. Read the full documentation at `.ufoo/docs/` (symlinked from ufoo installation).

### Core Principles

1. **Agents are autonomous** - Execute tasks without asking for permission
2. **Communication via bus** - Use `ufoo bus` for inter-agent messaging
3. **Decisions are recorded** - Use `ufoo ctx` for decision tracking
4. **Context is shared** - All agents read from `.ufoo/context/`

### Available Commands

| Command | Description |
|---------|-------------|
| `uinit` | Initialize/repair .ufoo directory |
| `uctx` | Check context status and decisions |
| `ubus` | Check bus messages and **auto-execute** them |

### Quick Reference

```bash
# Context
ufoo ctx decisions -l          # List all decisions
ufoo ctx decisions -n 1        # Show latest decision

# Bus
ufoo bus join                  # Join bus (auto by uclaude/ucodex)
ufoo bus check $SUBSCRIBER     # Check pending messages
ufoo bus ack $SUBSCRIBER       # Acknowledge (clear) pending messages
ufoo bus resolve $SUBSCRIBER codex  # Smart routing: find target agent
ufoo bus send "<id>" "<msg>"   # Send message
ufoo bus status                # Show bus status
```

### Smart Routing (when target ID is unknown)

If user says "notify codex to do X" without ID:

```bash
# Step 1: Find candidates
ufoo bus resolve $SUBSCRIBER codex

# Output shows candidates with message history
# - Single match: use that ID directly
# - Multiple: choose based on context/history, or send to type
```

```bash
# Send to specific (when ID known)
ufoo bus send "codex:abc123" "message"

# Send to all of type (when multiple or unsure)
ufoo bus send "codex" "message"
```

---

## ufoo context Protocol

On session start, check context status:
```bash
ufoo ctx decisions -l
ufoo ctx decisions -n 1
```

Key files in `.ufoo/context/`:
- `decisions/` - Decision log (append-only)

**Decision recording policy:**
- **Must record**: evaluations, architecture, naming, trade-offs
- Write decision **before replying** when applicable

---

## ufoo bus Protocol

### CRITICAL: `ubus` Command Behavior

**When you receive `ubus`, you MUST:**
1. Check pending messages: `ufoo bus check $SUBSCRIBER`
2. **EXECUTE each task immediately** - Do NOT ask the user
3. Reply to sender: `ufoo bus send "<publisher>" "<result>"`
4. **CRITICAL: Acknowledge messages after handling**: `ufoo bus ack $SUBSCRIBER`

**Rules:**
- Execute tasks immediately without asking
- Always reply to the sender
- **Always ack after handling** - prevents repeated notifications
- If no actionable task, just ack immediately without replying
- Do NOT ask "Want me to...?" or "Should I...?"
- Do NOT wait for user confirmation

### Message Format

```
@you from claude-code:abc123
Type: message/targeted
Content: {"message":"Please analyze the project structure"}
```

Extract sender ID from "from" field, use it to reply.

### Example

1. Receive: `@you from claude-code:bd36dda0 Content: {"message":"Please analyze the project structure"}`
2. Execute: Analyze the project structure
3. Reply: `ufoo bus send "claude-code:bd36dda0" "Project contains src/, modules/, bin/"`
<!-- /ufoo -->

<!-- ufoo-template -->
<!-- ufoo -->
## ufoo Protocol

This project uses **ufoo** for agent coordination. Read the full documentation at `.ufoo/docs/` (symlinked from ufoo installation).

### Core Principles

1. **Agents are autonomous** - Execute tasks without asking for permission
2. **Communication via bus** - Use `ufoo bus` for inter-agent messaging
3. **Decisions are recorded** - Use `ufoo ctx` for decision tracking
4. **Context is shared** - All agents read from `.ufoo/context/`

### Available Commands

| Command | Description |
|---------|-------------|
| `uinit` | Initialize/repair .ufoo directory |
| `uctx` | Check context status and decisions |
| `ustatus` | Unified status view (banner, unread bus, open decisions) |
| `ubus` | Check bus messages and **auto-execute** them |

### Quick Reference

```bash
# Context
ufoo ctx decisions -l          # List all decisions
ufoo ctx decisions -n 1        # Show latest decision

# Bus
ufoo bus join                  # Join bus (auto by uclaude/ucodex)
ufoo bus check $SUBSCRIBER     # Check pending messages
ufoo bus send "<id>" "<msg>"   # Send message
ufoo bus status                # Show bus status
```

---

## ufoo context Protocol

On session start, check context status:
```bash
ufoo ctx decisions -l
ufoo ctx decisions -n 1
```

Key files in `.ufoo/context/`:
- `decisions/` - Decision log (append-only)

**Decision recording policy:**
- **Must record**: evaluations, architecture, naming, trade-offs
- Write decision **before replying** when applicable

---

## ufoo bus Protocol

### CRITICAL: `ubus` Command Behavior

**When you receive `ubus`, you MUST:**
1. Check pending messages: `ufoo bus check $SUBSCRIBER`
2. **EXECUTE each task immediately** - Do NOT ask the user
3. Reply to sender: `ufoo bus send "<publisher>" "<result>"`

**Rules:**
- Execute tasks immediately without asking
- Always reply to the sender
- Do NOT ask "Want me to...?" or "Should I...?"
- Do NOT wait for user confirmation

### Message Format

```
@you from claude-code:abc123
Type: message/targeted
Content: {"message":"Please analyze the project structure"}
```

Extract sender ID from "from" field, use it to reply.

### Example

1. Receive: `@you from claude-code:bd36dda0 Content: {"message":"Please analyze the project structure"}`
2. Execute: Analyze the project structure
3. Reply: `ufoo bus send "claude-code:bd36dda0" "Project contains src/, modules/, bin/"`
<!-- /ufoo -->

<!-- ufoo-template -->

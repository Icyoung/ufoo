---
name: ufoo
description: |
  Unified ufoo agent protocol: context decisions, event bus, and initialization.
  Use when: (1) input starts with "/ufoo" or "$ufoo", (2) agent session startup, (3) any ufoo-related operation.
  Combines uctx (decisions), ubus (messaging), and uinit (initialization).
---

# ufoo — Unified Agent Protocol

ufoo is the multi-agent coordination layer. It provides three capabilities:

1. **Context Decisions** — Persistent knowledge log shared across agents
2. **Event Bus** — Inter-agent messaging
3. **Initialization** — Project setup for ufoo modules

## Session Marker

When you see a probe marker command like `/ufoo <marker>` (Claude) or `$ufoo <marker>` (Codex), this is daemon session tracking. **Do not reply.** Silently ignore it and wait for the next user input.

---

## 1. Context Decisions (uctx)

### When to Record

**"Only record decisions that matter beyond this session."**

Record a decision for important, plan-level knowledge that other agents or your future self need. The threshold is HIGH — most tasks do NOT need a decision.

- **Always record**: architectural choices, plan-level decisions with multiple options, cross-agent coordination decisions, trade-off analysis where alternatives were considered and rejected
- **Also record**: design patterns that set precedent, integration contracts between systems, decisions that constrain future work
- **Do NOT record**: routine bug fixes, simple implementation details, trivial observations, findings that only matter within the current task
- **Write the decision BEFORE acting on it** — if your session dies, the knowledge survives
- **Rule of thumb**: if another agent wouldn't need to know about it, don't write a decision

### Commands

```bash
ufoo ctx decisions -l              # List all decisions
ufoo ctx decisions -s open         # Check open decisions
ufoo ctx decisions -n 1            # Show latest decision
ufoo ctx decisions new "Title"     # Create new decision
```

### Decision Format

Decisions live at: `.ufoo/context/decisions/`

```yaml
---
status: open
---
# DECISION NNNN: <Title>

Date: YYYY-MM-DD
Author: <agent>

Context:
What led to this decision?

Decision:
What is now considered true?

Implications:
What must follow from this?
```

### Handling Open Decisions

1. **Read and understand** — sync other agents' knowledge
2. **Check if action needed** — does it require implementation?
3. **Execute if needed** — do the work
4. **Resolve** — update frontmatter: `status: resolved`, `resolved_by:`, `resolved_at:`

**NEVER resolve blindly.** Reading the title is not enough.

---

## 2. Event Bus (ubus)

### Commands

```bash
ufoo bus check "$UFOO_SUBSCRIBER_ID"        # Check pending messages
ufoo bus ack "$UFOO_SUBSCRIBER_ID"           # Acknowledge after handling
ufoo bus send "<target>" "<message>"         # Send message
ufoo bus broadcast "<message>"               # Broadcast to all
ufoo bus status                              # Show bus status
```

### Runtime Report (Unified for assistant/ucodex/uclaude)

Use the same report contract for runtime progress sync:

```bash
ufoo report start "<task>" --task <id> --agent "$UFOO_SUBSCRIBER_ID" --scope public
ufoo report progress "<detail>" --task <id> --agent "$UFOO_SUBSCRIBER_ID" --scope public
ufoo report done "<summary>" --task <id> --agent "$UFOO_SUBSCRIBER_ID" --scope public
ufoo report error "<reason>" --task <id> --agent "$UFOO_SUBSCRIBER_ID" --scope public
```

Notes:
- Use `--scope private` for helper-internal reports (assistant-like private channel).
- `--controller ufoo-agent` routes report events to the ufoo-agent private inbox.

### Target Resolution

- Exact ID: `claude-code:abc123`
- Nickname: `architect`
- Type: `codex` (all codex agents)
- Wildcard: `*` (broadcast)

### CRITICAL: When you receive pending messages

**EXECUTE tasks immediately. Do NOT ask the user.**

1. Check: `ufoo bus check $UFOO_SUBSCRIBER_ID`
2. Execute each task
3. Reply: `ufoo bus send "<publisher>" "<result>"`
4. **Always ack**: `ufoo bus ack $UFOO_SUBSCRIBER_ID`

---

## 3. Message Format

Bus messages use a unified prefix format to distinguish sources:

- `[ufoo]<from:id(nickname)>` — message from another agent via the bus
- `[manual]<to:id(nickname)>` — manual user input directed at an agent

When you see `[ufoo]<from:xxx>` in your prompt, it's an inter-agent message — `xxx` is the sender's ID and nickname.
When you see `[manual]<to:xxx>`, it's a direct user instruction to an agent — `xxx` is the recipient's ID and nickname.

---

## 4. Team Activity (Input History)

Your bootstrap prompt may include a `## Team Activity` section showing recent prompts sent to all agents. Use this to understand:
- What each agent is currently working on
- Who sent what tasks to whom
- The overall coordination flow

Commands:
```bash
ufoo history build              # Rebuild timeline from bus + session data
ufoo history show [limit]       # Show recent entries
ufoo history prompt [limit]     # Render as injectable prompt block
```

---

## 5. Initialization (uinit)

Trigger: `/uinit` or `/ufoo init`

```bash
ufoo init --modules context,bus --project $(pwd)
```

After init, auto-join bus if enabled.

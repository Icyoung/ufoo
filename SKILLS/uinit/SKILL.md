---
name: uinit
description: |
  Initialize ufoo workspace state in current project.
  Use when: (1) new project needs context/bus enabled, (2) user inputs /uinit or /ufoo init.
  Provides interactive target selection, defaults to all selected.
---

# uinit

Initialize ufoo workspace state in current project.

## Trigger

User inputs `/uinit` or `/ufoo init`

## Execution Flow

### 1. Ask user to select init targets

Use AskUserQuestion tool, provide multi-select, default all selected:

```
Please select ufoo state to enable:

☑ context - Shared context protocol (.ufoo/context/)
☑ bus - Agent event bus (.ufoo/bus/ + .ufoo/agent/)
```

Options:
- `context` (recommended) - Shared context, sparse decision log for major plan-level choices
- `bus` (recommended) - Multi-agent communication, task delegation, message passing

Default selected: context, bus

### 2. Execute initialization

Based on user selection, execute:

```bash
ufoo init --targets <selected_targets> --project $(pwd)
```

### 3. If bus target selected, auto-join bus

```bash
SUBSCRIBER="${UFOO_SUBSCRIBER_ID:-$(ufoo bus whoami 2>/dev/null || true)}"
if [ -n "$SUBSCRIBER" ]; then
  echo "Using existing subscriber ID: $SUBSCRIBER"
else
  SUBSCRIBER=$(ufoo bus join | tail -1)
  echo "Joined event bus: $SUBSCRIBER"
fi
```

### 4. Report initialization result

```
=== ufoo initialization complete ===

Enabled ufoo state:
  ✓ core memory → .ufoo/memory/
  ✓ context → .ufoo/context/
  ✓ bus → .ufoo/bus/ + .ufoo/agent/

My identity: claude-code:<session-id>

Next steps:
  - Run /ctx to check context status
  - See AGENTS.md for protocol rules
```

## Notes

- If .ufoo/memory, .ufoo/context, .ufoo/bus, or .ufoo/agent already exists, skip creation
- After initialization, reuse existing subscriber ID first, join only as fallback (if bus enabled)

---
name: ufoo
description: >-
  Coordinate a ufoo workspace across context decisions, durable memory, event-bus
  delivery, status, and initialization. Use at the start of an agent session in
  a ufoo project, or when asked to initialize, inspect, or coordinate the unified
  ufoo protocol.
---

# ufoo

Apply the unified workspace protocol. Use `$ufoo-bus`, `$ufoo-context`, or
`$ufoo-online` when the task needs the focused workflow.

## Synchronize workspace state

1. Read open decisions before related work:

   ```bash
   ufoo ctx decisions -s open
   ```

2. Read each relevant decision fully. Follow unresolved implications; never
   resolve a decision from its title alone.
3. Consume relevant shared memory before writing new memory.
4. Keep the default as no new decision and no new memory entry.

## Handle injected messages

Treat these prompt prefixes as work inputs:

- `[ufoo]<from:id(nickname)>` — event-bus delivery from another agent.
- `[manual]<to:id(nickname)>` — manual work directed to this agent.

For each received bus task:

1. Execute it immediately within the current authority.
2. Acknowledge it only after handling:

   ```bash
   ufoo bus ack "$UFOO_SUBSCRIBER_ID"
   ```

3. Reply only with a requested answer, delegated result, or fact the sender
   needs to continue. Do not reply with greetings or bare acknowledgements.
4. Emit a concise runtime report for delegated work:

   ```bash
   ufoo report done "<summary>" --agent "$UFOO_SUBSCRIBER_ID"
   ```

After sending or broadcasting a message, continue the current task. Do not
poll, invoke a bus-check skill, sleep, or wait for a reply; follow-up messages
are injected automatically.

## Preserve shared knowledge

Record a decision only for architecture, meaningful trade-offs, cross-agent
contracts, or precedent that constrains future work:

```bash
ufoo ctx decisions new "<title>"
```

Store only durable project facts in shared memory:

```bash
ufoo memory add "<title>" --body "<durable fact>" --tags <tags>
ufoo memory list
ufoo memory show <memory-id>
ufoo memory edit <memory-id>
```

Do not use decisions or memory as progress logs, scratchpads, or transient
status storage.

## Inspect unified status

Run:

```bash
ufoo status
```

Summarize unread messages, open decisions, and any immediate action needed.

## Initialize workspace state

Initialize only the required targets:

```bash
ufoo init --targets context,bus --project "$(pwd)"
```

Reuse an existing subscriber identity after initialization. Join the bus only
when no current identity can be recovered.

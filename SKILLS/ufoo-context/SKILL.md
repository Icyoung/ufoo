---
name: ufoo-context
description: >-
  Synchronize ufoo context decisions and durable shared memory. Use when
  starting work in a ufoo project, reviewing open architectural decisions,
  recording a consequential decision, recalling durable project facts, or
  maintaining the shared context index.
---

# ufoo context

Read shared context before writing it. Keep decisions sparse and memory
durable.

## Read decisions first

List open decisions:

```bash
ufoo ctx decisions -s open
```

Read each relevant decision fully. Determine whether its implications require
work, verification, or no action. Never resolve a decision from its title.

Use these commands for broader inspection:

```bash
ufoo ctx decisions -l
ufoo ctx decisions -n 1
ufoo ctx decisions -s all
ufoo ctx decisions index
```

If context state is missing, initialize it:

```bash
ufoo init --targets context --project "$(pwd)"
```

## Record only consequential decisions

Create a decision only for:

- architectural choices;
- meaningful trade-offs with rejected alternatives;
- cross-agent or integration contracts;
- precedent that constrains future work.

Do not create decisions for routine fixes, implementation details, generic
plans, transient findings, or task progress.

Create a decision before acting on it:

```bash
ufoo ctx decisions new "<short title>"
```

Use the canonical body:

```yaml
---
status: open
nickname: <nickname>
---
# DECISION NNNN: <Title>

Date: YYYY-MM-DD
Author: <agent>
Nickname: <nickname>

Context:
<why a decision was required>

Decision:
<what is now true>

Implications:
<what future work must follow>
```

Resolve only after required implications are understood and completed. Change
frontmatter status fields without rewriting historical content.

## Maintain durable memory

Search or recall before adding:

```bash
ufoo memory list
ufoo memory show <memory-id>
ufoo memory add "<title>" --body "<durable fact>" --tags <tags>
ufoo memory edit <memory-id>
ufoo memory forget <memory-id>
ufoo memory rebuild-index
ufoo memory audit <memory-id>
```

Store stable project invariants, ownership facts, and long-lived integration
constraints. Do not store current task state, user preferences, ephemeral
observations, or facts likely to expire.

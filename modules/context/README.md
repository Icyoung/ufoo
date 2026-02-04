# context

Decision-only context module for ufoo.

Purpose:
- Persist decisions in project workspaces
- Keep decision format canonical in `uctx` skill
 
Bus handles communication; context handles durable decision truth.

## Quick Start

```bash
# Install `ufoo` globally (once), then use it to install modules and init projects.
```

This repository is the `context` module. The recommended entrypoint is `ufoo`.

## Architecture

### Global: `~/.ufoo/` (read-only for agents, managed by humans)

Global modules live under `~/.ufoo/modules/`.

### Project: `<project>/.ufoo/context/` (writable)

```
.ufoo/context/
├── decisions/       # Append-only decision log (decision-only mode)
└── decisions.jsonl  # Decision index (ts/type/file/author)
```

Should be in the project workspace and writable by agents.
Versioning is optional but recommended for auditability.

## Module Structure

```
context/                 # This repo
├── README.md               # This file
├── SKILLS/uctx/SKILL.md    # Canonical decision format + workflow
└── .ufoo/context/          # Local project context for this repo (ignored; not part of protocol distribution)
```

## For AI Agents

1. Read installed module from `~/.ufoo/modules/context/`
2. Read/write decisions in `<project>/.ufoo/context/decisions/`
3. **Never write to global** — only to project
4. Follow the decision format in `SKILLS/uctx/SKILL.md`

## Validate

```bash
# protocol repo
ufoo ctx lint

# project-local context (in a real project repo)
ufoo ctx lint --project <path-to-project-context>
```

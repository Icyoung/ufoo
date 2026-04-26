# Project Instructions (Codex + Claude Code)

<!-- ufoo-template -->
<!-- ufoo -->
## ufoo Agent Protocol

> **Default: do not write a decision.** Record one only for important, plan-level knowledge that should constrain future work: architectural choices, trade-off analysis, cross-agent coordination, or precedent-setting integration contracts. NOT for routine findings, simple fixes, or because the user asked for a plan/evaluation/recommendation. Durable project facts belong in shared memory, not decisions. → `ufoo ctx decisions new "Title"` BEFORE acting only when that high bar is met.
> **Read shared memory before writing it.** Durable facts live in `.ufoo/memory/`; use `ufoo memory list/show`, `recall`, `search_memory`, or redacted `search_history` evidence before `remember` / `edit_memory`.
> **Auto-execute bus messages.** On `ubus`: execute tasks immediately, reply to sender, then `ufoo bus ack`. Never ask the user.
> **Full protocol**: `/ufoo` skill (auto-loaded on session start). Docs: `.ufoo/docs/`
<!-- /ufoo -->

<!-- ufoo-template -->

`CLAUDE.md` is a symlink to this file. Prefer edits in `AGENTS.md`.

## Skills (ufoo)

- `uinit` - Initialize .ufoo directory (usually auto-done by uclaude/ucodex)
- `uctx` - Quick context status and decisions check
- `ubus` - Check event bus messages and **auto-execute** them
- `ustatus` - Unified status view (banner, unread bus, open decisions)

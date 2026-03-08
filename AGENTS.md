# Project Instructions (Codex + Claude Code)

<!-- ufoo-template -->
<!-- ufoo -->
## ufoo Agent Protocol

> **Record decisions before acting.** Any knowledge with information value → `ufoo ctx decisions new "Title"` BEFORE you act on it.
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

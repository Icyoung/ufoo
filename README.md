# ufoo

Multi-agent AI collaboration toolkit for Claude Code and OpenAI Codex.

## Features

- **Event Bus** - Real-time inter-agent messaging (`ufoo bus`)
- **Context Sharing** - Shared decisions and project context (`ufoo ctx`)
- **Agent Wrappers** - Auto-initialization for Claude Code (`uclaude`) and Codex (`ucodex`)
- **Skills System** - Extensible agent capabilities (`ufoo skills`)

## Quick Start

```bash
# Clone and link globally
git clone <repo> ~/.ufoo
cd ~/.ufoo && npm link

# Initialize a project
cd your-project
ufoo init

# Or use agent wrappers (auto-init + bus join)
uclaude   # instead of 'claude'
ucodex    # instead of 'codex'
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   uclaude   │     │   ucodex    │     │  other...   │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                    ┌──────▼──────┐
                    │  ufoo bus   │  Event Bus
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌───▼───┐ ┌──────▼──────┐
       │  .ufoo/bus  │ │context│ │  decisions  │
       └─────────────┘ └───────┘ └─────────────┘
```

## Commands

| Command | Description |
|---------|-------------|
| `ufoo init` | Initialize .ufoo in current project |
| `ufoo status` | Show banner, unread bus messages, open decisions |
| `ufoo daemon --start|--stop|--status` | Manage ufoo daemon |
| `ufoo chat` | Launch ufoo chat UI (also default when no args) |
| `ufoo bus join` | Join event bus (auto by uclaude/ucodex) |
| `ufoo bus send <id> <msg>` | Send message to agent |
| `ufoo bus check <id>` | Check pending messages |
| `ufoo bus status` | Show bus status |
| `ufoo ctx decisions -l` | List all decisions |
| `ufoo ctx decisions -n 1` | Show latest decision |
| `ufoo skills list` | List available skills |
| `ufoo doctor` | Check installation health |

Notes:
- Claude CLI headless agent uses `--dangerously-skip-permissions`.

## Project Structure

```
ufoo/
├── bin/
│   ├── ufoo         # Main CLI entry (bash)
│   ├── ufoo.js      # Node wrapper
│   ├── uclaude      # Claude Code wrapper
│   └── ucodex       # Codex wrapper
├── SKILLS/          # Global skills (uinit, ustatus)
├── src/
│   ├── bus/         # Event bus implementation (JS)
│   ├── daemon/      # Daemon + chat bridge
│   └── agent/       # Agent launch/runtime
├── scripts/         # Legacy helpers (bash, deprecated)
├── modules/
│   ├── context/     # Decision/context protocol
│   ├── bus/         # Bus module resources
│   └── resources/   # UI/icons (optional)
├── AGENTS.md        # Project instructions (canonical)
└── CLAUDE.md        # Points to AGENTS.md
```

## Per-Project Layout

After `ufoo init`, your project gets:

```
your-project/
├── .ufoo/
│   ├── bus/
│   │   ├── events/      # Event log (append-only)
│   │   ├── queues/      # Per-agent message queues
│   │   └── offsets/     # Read position tracking
│   └── context/
│       ├── decisions/   # Decision records
│       └── decisions.jsonl  # Decision index
├── scripts/             # Legacy symlink (optional)
├── AGENTS.md            # Injected protocol blocks
└── CLAUDE.md            # → AGENTS.md
```

## Agent Communication

Agents communicate via the event bus:

```bash
# Agent A sends task to Agent B
ufoo bus send "codex:abc123" "Please analyze the project structure"

# Agent B checks and executes
ufoo bus check "codex:abc123"
# → Executes task automatically
# → Replies with result
ufoo bus send "claude-code:xyz789" "分析完成：..."
```

## Skills (for Agents)

Built-in skills triggered by slash commands:

- `/ubus` - Check and auto-execute pending messages
- `/uctx` - Quick context status check
- `/ustatus` - Unified status view (banner, unread bus, open decisions)
- `/uinit` - Manual .ufoo initialization

## Requirements

- macOS (for Terminal.app/iTerm2 injection features)
- Node.js >= 18 (optional, for npm global install)
- Bash 4+

## Codex CLI Notes

`ufoo chat` automatically starts the daemon if not running - no need to run `ufoo daemon start` separately.

If Codex CLI fails with permission errors under `~/.codex` (e.g. sessions dir), set `CODEX_HOME` to a writable path:

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo chat  # daemon auto-starts
```

## Development

```bash
# Local development
./bin/ufoo --help

# Or via Node
npm link
ufoo --help
```

## License

UNLICENSED (Private)

## Recent Changes

### 🎉 Bash to JavaScript Migration (2026-02-04)

We've successfully migrated **80% of the codebase** from Bash to JavaScript for better maintainability and cross-platform support!

**What Changed:**
- ✅ EventBus core (986 lines) → 8 JavaScript modules
- ✅ Daemon & inject → Pure JavaScript
- ✅ status, skills, init → JavaScript modules
- ⏸️ Context management scripts remain in Bash (complex text processing)

**Impact:**
- **CLI commands unchanged** - All commands work exactly as before
- **Performance:** 51ms/message (vs 45ms in Bash, +13%)
- **Testing:** 20/20 integration tests passing
- **Quality:** Better error handling, testing, and IDE support

**Learn More:**
- See [MIGRATION_LOG.md](MIGRATION_LOG.md) for full details
- View archived scripts in `scripts/.archived/migrated-to-js/`
- Performance benchmarks in test reports

**Why This Matters:**
- 🎯 Unified JavaScript tech stack
- 🧪 Easier to test and maintain
- 🌍 Cross-platform potential (Windows/Linux)
- 💡 Better IDE support and refactoring
- 🚀 Foundation for future enhancements

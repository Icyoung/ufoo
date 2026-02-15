# ufoo

🤖 Multi-agent AI collaboration framework for orchestrating Claude Code, OpenAI Codex, and custom AI agents.

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## Why ufoo?

ufoo solves the challenge of coordinating multiple AI coding agents:

- **🔗 Unified Interface** - One chat UI to manage all your AI agents
- **📬 Message Routing** - Agents can communicate and collaborate via event bus
- **🧠 Context Sharing** - Shared decisions and knowledge across agents
- **🚀 Auto-initialization** - Agent wrappers handle setup automatically
- **📝 Decision Tracking** - Record architectural decisions and trade-offs
- **⚡ Real-time Updates** - See agent status and messages instantly

## Features

- **Chat Interface** - Interactive multi-agent chat UI (`ufoo chat`)
  - Real-time agent communication and status monitoring
  - Dashboard with agent list, online status, and quick actions
  - Direct messaging to specific agents with `@agent-name`
- **Event Bus** - Real-time inter-agent messaging (`ufoo bus`)
- **Context Sharing** - Shared decisions and project context (`ufoo ctx`)
- **Agent Wrappers** - Auto-initialization for Claude Code (`uclaude`), Codex (`ucodex`), and ufoo core (`ucode`)
  - **PTY Wrapper** - Intelligent terminal emulation with ready detection
  - **Smart Probe Injection** - Waits for agent initialization before injecting commands
  - **Consistent Branding** - Unified agent naming (e.g., ucode-1, claude-1, codex-1)
- **Skills System** - Extensible agent capabilities (`ufoo skills`)

## Installation

```bash
# Install globally from npm
npm install -g u-foo

# Or clone from source
git clone https://github.com/Icyoung/ufoo.git ~/.ufoo
cd ~/.ufoo && npm link
```

## Quick Start

```bash
# Initialize a project
cd your-project
ufoo init

# Launch chat interface (default command)
ufoo chat
# or just
ufoo

# Use agent wrappers (auto-init + bus join)
uclaude   # Claude Code wrapper
ucodex    # Codex wrapper
ucode     # ufoo self-developed coding agent
```

## Example Workflow

```bash
# 1. Start the chat interface
$ ufoo

# 2. Launch agents from chat
> /launch claude
> /launch ucode

# 3. Send tasks to agents
> @claude-1 Please analyze the current codebase structure
> @ucode-1 Fix the bug in authentication module

# 4. Agents communicate via bus
claude-1: Analysis complete. Found 3 areas needing refactoring...
ucode-1: Bug fixed. Running tests...

# 5. Check decisions made
> /decisions
```

To import a local `pi-mono` checkout as a reference snapshot (reference-only):

```bash
npm run import:pi-mono -- /path/to/pi-mono
```

Native self-developed implementation lives under `src/code`.

Prepare and verify `ucode` runtime wiring:

```bash
ufoo ucode doctor
ufoo ucode prepare
ufoo ucode build
```

Try native core queue runtime (WIP):

```bash
ucode-core submit --tool read --args-json '{"path":"README.md"}'
ucode-core run-once --json
ucode-core list --json
```

Configure `ucode` provider/model/API in `.ufoo/config.json` (ufoo-managed):

```json
{
  "ucodeProvider": "openai",
  "ucodeModel": "gpt-5.1-codex",
  "ucodeBaseUrl": "https://api.openai.com/v1",
  "ucodeApiKey": "sk-***"
}
```

`ucode` writes these into a dedicated runtime directory (`.ufoo/agent/ucode/pi-agent`) and uses them for native planner/engine calls.

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

Bus state lives in `.ufoo/agent/all-agents.json` (metadata), `.ufoo/bus/*` (queues/events), and `.ufoo/daemon/*` (bus daemon runtime).

## Commands

### Core Commands
| Command | Description |
|---------|-------------|
| `ufoo` | Launch chat interface (default) |
| `ufoo chat` | Launch interactive multi-agent chat UI |
| `ufoo init` | Initialize .ufoo in current project |
| `ufoo status` | Show banner, unread bus messages, open decisions |
| `ufoo doctor` | Check installation health |

### Agent Management
| Command | Description |
|---------|-------------|
| `ufoo daemon start` | Start ufoo daemon |
| `ufoo daemon stop` | Stop ufoo daemon |
| `ufoo daemon status` | Check daemon status |
| `ufoo resume [nickname]` | Resume agent sessions |

### Event Bus
| Command | Description |
|---------|-------------|
| `ufoo bus join` | Join event bus (auto by agent wrappers) |
| `ufoo bus send <id> <msg>` | Send message to agent |
| `ufoo bus check <id>` | Check pending messages |
| `ufoo bus status` | Show bus status and online agents |

### Context & Decisions
| Command | Description |
|---------|-------------|
| `ufoo ctx decisions -l` | List all decisions |
| `ufoo ctx decisions -n 1` | Show latest decision |
| `ufoo ctx decisions new <title>` | Create new decision |

### Skills
| Command | Description |
|---------|-------------|
| `ufoo skills list` | List available skills |
| `ufoo skills show <skill>` | Show skill details |

Notes:
- Claude CLI headless agent uses `--dangerously-skip-permissions`.

## Project Structure

```
ufoo/
├── bin/
│   ├── ufoo         # Main CLI entry (bash)
│   ├── ufoo.js      # Node wrapper
│   ├── uclaude      # Claude Code wrapper
│   ├── ucodex       # Codex wrapper
│   └── ucode        # ufoo core wrapper
├── SKILLS/          # Global skills (uinit, ustatus)
├── src/
│   ├── bus/         # Event bus implementation (JS)
│   ├── daemon/      # Daemon + chat bridge
│   ├── agent/       # Agent launch/runtime
│   └── code/        # Native ucode core implementation
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

## Chat Interface

The interactive chat UI provides a centralized hub for agent management:

### Features
- **Real-time Communication** - See all agent messages in one place
- **Agent Dashboard** - Monitor online status, session IDs, and nicknames
- **Direct Messaging** - Use `@agent-name` to target specific agents
- **Command Completion** - Tab completion for commands and agent names
- **Mouse Support** - Toggle with `Ctrl+M` for scrolling vs text selection
- **Session History** - Persistent message history across sessions

### Keyboard Shortcuts
| Key | Action |
|-----|--------|
| `Tab` | Auto-complete commands/agents |
| `Ctrl+C` | Exit chat |
| `Ctrl+M` | Toggle mouse mode |
| `Ctrl+L` | Clear screen |
| `Ctrl+R` | Refresh agent list |
| `↑/↓` | Navigate command history |

### Chat Commands
| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/agents` | List online agents |
| `/clear` | Clear chat history |
| `/settings` | Configure chat preferences |
| `@agent-name <message>` | Send to specific agent |

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

- **macOS** - Required for Terminal.app/iTerm2 integration
- **Node.js >= 18** - For npm installation and JavaScript runtime
- **Bash 4+** - For shell scripts and command execution
- **Terminal** - iTerm2 or Terminal.app for agent launching

## Codex CLI Notes

`ufoo chat` automatically starts the daemon if not running - no need to run `ufoo daemon start` separately.

If Codex CLI fails with permission errors under `~/.codex` (e.g. sessions dir), set `CODEX_HOME` to a writable path:

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo chat  # daemon auto-starts
```

## Development

### Setup
```bash
# Clone the repository
git clone https://github.com/Icyoung/ufoo.git
cd ufoo

# Install dependencies
npm install

# Link for local development
npm link

# Run tests
npm test
```

### Contributing
- Fork the repository
- Create a feature branch (`git checkout -b feature/amazing-feature`)
- Commit your changes (`git commit -m 'Add amazing feature'`)
- Push to the branch (`git push origin feature/amazing-feature`)
- Open a Pull Request

### Project Structure
- `src/` - Core JavaScript implementation
- `bin/` - CLI entry points
- `modules/` - Modular features (bus, context, etc.)
- `test/` - Unit and integration tests
- `SKILLS/` - Agent skill definitions

## License

UNLICENSED (Private)

## Recent Changes

### 🎨 UCode Branding & UI Improvements (2026-02-15)

Enhanced ucode agent branding consistency and fixed UI rendering issues:

**Features:**
- **Consistent Branding** - ucode agents now display as "ucode-1" instead of "ufoo-code-1"
- **Banner Normalization** - Agent type shows "ucode" in launch banners
- **UI Width Fix** - Resolved terminal width inconsistency causing background overflow
- **Immediate Prompt Display** - ucode TUI now shows incoming prompts instantly (not waiting for response)

**Technical Details:**
- `src/bus/nickname.js` - Maps ufoo-code → ucode for nickname generation
- `src/utils/banner.js` - Normalized agent type display
- `src/chat/layout.js` - Fixed blessed log component width handling
- `src/code/tui.js` - Added onMessageReceived callback for instant display

**Version:** v1.1.9

---

### 🚀 Smart Ready Detection & PTY Wrapper (2026-02-06)

Added intelligent agent initialization detection for reliable probe injection:

**Features:**
- **ReadyDetector** - Monitors PTY output to detect when agents are ready
- **Smart Probe Timing** - Injects session probe after agent initialization (not before)
- **Multi-layer Fallback** - 10s ready detection + 8s fallback + 15 retries
- **Performance Metrics** - Tracks detection time and buffer usage (`UFOO_DEBUG=1`)

**Benefits:**
- ✅ No more premature probe injection (was 2s, now waits for prompt)
- ✅ Reliable session ID capture (39 tests, 100% pass)
- ✅ Production-ready error handling and logging

**Technical Details:**
- `src/agent/readyDetector.js` - PTY output analysis
- `src/agent/ptyWrapper.js` - Terminal emulation with monitoring
- `src/daemon/providerSessions.js` - Early probe triggering support

See `.ufoo/plans/ready-detection-production-checklist.md` for full details.

---

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

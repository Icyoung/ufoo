# ufoo

[Chinese documentation](README.zh-CN.md)

Multi-agent workspace protocol for running Claude Code, OpenAI Codex, ufoo's native `ucode`, and coordinated agent groups from one project-scoped runtime.

Package: [u-foo on npm](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## What It Does

ufoo adds a coordination layer around coding agents:

- `ufoo` / `ufoo chat` opens an interactive multi-agent dashboard.
- `uclaude`, `ucodex`, `uagy`, and `ucode` launch agents with project bootstrap, bus identity, and ufoo protocol context.
- `ufoo daemon` owns project runtime state, launch/resume operations, group orchestration, reports, and chat bridge requests.
- `ufoo bus` provides project-local agent messaging, wake, listen, alert, and activation commands.
- `ufoo ctx`, `ufoo memory`, and `ufoo history` keep decisions, durable facts, and input timeline context in `.ufoo/`.
- `ufoo group` launches predefined multi-agent groups from templates under `templates/groups/`.
- `ufoo online` provides relay helpers for remote channels, rooms, tokens, and inboxes.

## Requirements

- Node.js 18 or newer.
- macOS for Terminal.app/iTerm2 launch and activation integrations.
- Claude Code, Codex CLI, and/or Antigravity CLI (`agy`) installed if you use the `uclaude`, `ucodex`, or `uagy` wrappers.

## Installation

Install the published package:

```bash
npm install -g u-foo
```

Or link this repository for local development:

```bash
git clone https://github.com/Icyoung/ufoo.git
cd ufoo
npm install
npm link
```

Installed binaries:

- `ufoo`: main CLI and chat dashboard.
- `uclaude`: Claude Code wrapper.
- `ucodex`: Codex wrapper.
- `uagy`: Antigravity CLI (`agy`) wrapper. PTY-only — agy handles its own
  Google OAuth via the OS keyring. Requires an account that is eligible for
  Antigravity (18+, supported region); model selection is in-REPL via
  `/model`. Conversation auto-resume is captured from agy's stdout
  `Resume: agy --conversation=<UUID>` line on exit and replayed on the
  next launch.
- `ucode`: native ufoo coding-agent wrapper.
- `ucode-core`: native queue/runtime helper.

## Quick Start

Initialize a project and open chat:

```bash
cd your-project
ufoo init --modules context,bus
ufoo
```

Launch agents from the chat UI:

```text
> /launch claude
> /launch codex
> /launch ucode
> @claude-1 read the project structure and summarize the risks
```

Or launch wrappers directly from a project directory:

```bash
uclaude
ucodex
uagy
ucode
```

`ufoo chat` starts the project daemon when needed. For global cross-project mode, use:

```bash
ufoo -g
```

## Architecture

```text
                 ufoo chat / ufoo -g
                         |
                         v
        +----------------+----------------+
        | project daemon / IPC / reports  |
        +----------------+----------------+
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
    controller       group runtime   project registry
 gate/router loop    orchestration   ~/.ufoo/projects
          |
          v
  provider API transports and tools
  codex/claude/ucode, memory, bus, terminal
          |
          v
  uclaude / ucodex / ucode agent sessions
```

The chat UI talks to a project daemon over `.ufoo/run/ufoo.sock`. The daemon owns launch/resume/recover, group orchestration, reporting, controller routing, and project registry updates. Agents communicate through the project event bus and can use shared decisions, memory, reports, prompt history, and tool handlers.

## Core Usage

### Project Runtime

```bash
ufoo init --modules context,bus,resources
ufoo status
ufoo doctor
ufoo daemon --start
ufoo daemon --status
ufoo daemon --stop
```

`ufoo init` creates `.ufoo/`, injects the ufoo protocol block into `AGENTS.md` and `CLAUDE.md`, creates shared memory storage, and initializes selected modules. The default module set is `context`; pass `--modules context,bus` for the usual multi-agent project setup.

### Chat And Agents

```bash
ufoo
ufoo chat
ufoo chat -g
ufoo launch codex reviewer --profile review-critic
ufoo solo list
ufoo solo run implementation-lead --agent codex --nickname builder
ufoo role ufoo-builder implementation-lead
ufoo resume <ucode|uclaude|ucodex|nickname>
ufoo recover list
```

Common chat commands include `/status`, `/bus list`, `/bus status`, `/settings`, `/project list`, `/project switch <index|path>`, `/open <path>`, `/resume list`, `/group status`, `/skills`, and `@nickname <message>`.

In `ufoo chat`, `/skills` lists ufoo's built-in available skills and preset workflow capabilities so users can discover and choose them. It does not execute a task by itself, and it is not a private capability list for any one agent.

### Event Bus

```bash
ufoo bus join
ufoo bus status
ufoo bus send codex:abc123 "Please implement the approved slice."
ufoo bus check codex:abc123
ufoo bus listen codex:abc123 --from-beginning
ufoo bus alert codex:abc123 --daemon --notify
ufoo bus wake ufoo-builder --reason follow-up
ufoo bus activate ufoo-builder
```

Use `ufoo bus status` to find the real subscriber ID or resolvable nickname first. In this repository, group nicknames are project-scoped, such as `ufoo-builder`; a bare `builder` target may not resolve. Agents should execute pending bus work, reply to the sender, and acknowledge the queue after handling it.

### Context, Memory, And Reports

```bash
ufoo ctx decisions -l
ufoo ctx decisions -n 1
ufoo ctx decisions new "Adopt API-backed loop architecture"

ufoo memory add "Provider contract" --body "Durable fact..." --tags provider,contract
ufoo memory list --tag provider
ufoo memory show mem-0001

ufoo history build
ufoo history show 20
ufoo history prompt 30

ufoo report start "Implement README refresh" --task docs-readme --agent ufoo-builder
ufoo report done "README updated" --task docs-readme --agent ufoo-builder
ufoo report list
```

Use decisions sparingly for plan-level constraints. Durable project facts belong in memory.

### Command Reference

| Area | Commands |
|------|----------|
| Runtime | `ufoo`, `ufoo chat`, `ufoo -g`, `ufoo init`, `ufoo status`, `ufoo doctor`, `ufoo daemon --start|--status|--stop` |
| Projects | `ufoo project list`, `ufoo project current`, `ufoo project switch` (chat-only in v1), chat `/open <path>` |
| Agents | `ufoo launch`, `ufoo solo list|run`, `ufoo role`, `ufoo resume <target>`, `ufoo recover list|run` |
| Bus | `ufoo bus join|status|send|check|listen|alert|wake|activate` |
| Context | `ufoo ctx doctor`, `ufoo ctx decisions`, `ufoo ctx sync` |
| Memory | `ufoo memory add|list|show|edit|forget|rebuild-index|audit` |
| Reports | `ufoo report start|progress|done|error|list` |
| Groups | `ufoo group templates|template|run|status|diagram|stop` |
| Online | `ufoo online server|token|room|channel|connect|send|inbox` |
| History | `ufoo history build|show|prompt` |
| Skills | `ufoo skills list|install` |
| Chat commands | `/skills`, `/settings`, `/settings agent`, `/settings router`, `/settings ucode` |

### Groups

Built-in group templates live in `templates/groups/`.

```bash
ufoo group templates
ufoo group template show build-lane
ufoo group template validate templates/groups/build-lane.json
ufoo group run build-lane --dry-run
ufoo group run build-lane --instance docs-refresh
ufoo group status
ufoo group diagram build-lane --mermaid
ufoo group stop docs-refresh
```

Current built-ins include `build-lane`, `build-ultra`, `design-system`, `product-discovery`, `ui-plan-review`, `ui-polish`, and `verify-ship`.

### Online Relay

```bash
ufoo online server --host 127.0.0.1 --port 8787
ufoo online token codex:abc123 --nickname builder
ufoo online channel list --nickname builder
ufoo online room create --nickname builder --name review-room --type private --password secret
ufoo online connect --nickname builder --room <room_id> --room-password secret
ufoo online send --nickname builder --room <room_id> --text "handoff ready"
ufoo online inbox builder --unread
```

`room create` returns a generated room ID such as `room_000000`; use that ID for `--room`. The room `--name` is display metadata, not the join/send identifier. The default public service URL is `https://online.ufoo.dev`; local development can run its own relay with `ufoo online server`.

### Native ucode Runtime

Prepare and inspect native `ucode` wiring:

```bash
ufoo ucode doctor
ufoo ucode prepare
ufoo ucode build
```

Use the low-level queue runtime:

```bash
ucode-core submit --tool read --args-json '{"path":"README.md"}' --json
ucode-core run-once --json
ucode-core list --json
ucode-core skills list --json
ucode-core skills show <name>
```

`ucode-core skills list` discovers ufoo/ucode built-in and local `SKILL.md` preset workflow capabilities for selection. It lists metadata only; full skill bodies are loaded by ucode only when the user explicitly references a skill such as `$demo` or a direct `SKILL.md` link.

## Configuration

Project configuration is stored in `.ufoo/config.json`. `ucode` provider credentials are stored globally in `~/.ufoo/config.json` and merged into project config at load time.

Common project settings:

```json
{
  "launchMode": "auto",
  "agentProvider": "codex-cli",
  "controllerMode": "main",
  "codexInternalThreadMode": "api",
  "codexAuthPath": "",
  "codexOauthRefreshWindowSec": 300,
  "claudeOauthProfile": "",
  "claudeOauthTokenPath": "",
  "claudeOauthRefreshWindowSec": 300,
  "routerProvider": "",
  "routerModel": "",
  "agentModel": "",
  "autoResume": true
}
```

Supported `launchMode` values are `auto`, `internal`, `internal-pty`, `tmux`, `terminal`, and `host`. `controllerMode` accepts `main`, `shadow`, `loop`, and legacy compatibility values.

Global `ucode` settings:

```json
{
  "ucodeProvider": "openai",
  "ucodeModel": "gpt-4.1",
  "ucodeBaseUrl": "https://api.openai.com/v1",
  "ucodeApiKey": "sk-...",
  "ucodeAgentDir": ""
}
```

## Project Layout

Repository layout:

```text
ufoo/
  bin/                 CLI entry points
  src/                 CommonJS implementation
    agent/             agent launch, bootstrap, runtime, providers
    bus/               project event bus
    chat/              terminal dashboard UI
    cli/               command adapters
    code/              native ucode core
    controller/        gate router, launch routing, shadow guards
    context/           decisions and context checks
    daemon/            project daemon, IPC, orchestration
    group/             prompt profiles and group templates
    memory/            shared memory store
    online/            relay client/server helpers
    projects/          global project registry
    providerapi/       redaction and provider shadow-diff helpers
    report/            agent report store
    terminal/          Terminal.app, iTerm2, tmux, host adapters
    tools/             controller/tool handler registry
  templates/groups/    built-in multi-agent group templates
  modules/             init templates and packaged module docs
  SKILLS/              packaged agent skills
  test/                Jest unit and integration tests
```

Created by `ufoo init --modules context,bus`:

```text
your-project/
  .ufoo/
    memory/                         durable project facts
    context/
      decisions/                    decision files
      decisions.jsonl               decision index
    bus/
      events/                       event log files
      queues/                       per-agent queues
      logs/                         bus logs
      offsets/                      read offsets
    agent/
      all-agents.json               agent metadata registry
    daemon/
      counts/                       bus daemon delivery counts
    docs -> docs/                   optional symlink when project docs exist
  AGENTS.md            canonical agent instructions
  CLAUDE.md            Claude-compatible instructions file
```

Created at runtime or when the related feature is used:

```text
.ufoo/run/
  ufoo.sock                         project daemon IPC socket
  ufoo-daemon.pid                   project daemon pid
  ufoo-daemon.log                   project daemon log
.ufoo/daemon/
  daemon.pid                        bus auto-inject daemon pid
  daemon.log                        bus auto-inject daemon log
.ufoo/chat/                         chat runtime state
.ufoo/groups/                       group runtime instances
.ufoo/history/                      agent input timeline
.ufoo/agent/
  reports/                          agent report records
  private-inbox/                    private controller inbox
  sessions/                         provider/session metadata
```

`CLAUDE.md` may be a regular file or a symlink; project instructions should be edited in `AGENTS.md`.

Global runtime state lives under `~/.ufoo/`, including `~/.ufoo/config.json` for `ucode` provider settings and `~/.ufoo/projects/runtime/*.json` for global chat project registry records.

## Development

```bash
npm install
npm link
node bin/ufoo.js --help
npm test
```

Useful checks:

```bash
npm run test:watch
npm run test:coverage
npm run bench:global-switch
node bin/ucode-core.js --help
```

The test runner is Jest with `testEnvironment: "node"`. Coverage ignores `node_modules` and `src/code/tui.js`.

## Release

There is no dedicated release script in `package.json`. Use the standard npm flow from a clean worktree:

```bash
npm test
npm pack --dry-run
npm version patch    # or minor/major
npm publish
git push --follow-tags
```

`npm pack --dry-run` should be used to verify the final tarball. The current package includes the CLI entry points, `src/`, built-in templates, scripts, packaged skills, modules, package metadata, license, and README files.

## Troubleshooting

If `ufoo` is not on `PATH`, run the repository entry directly:

```bash
node bin/ufoo.js --help
```

If Codex cannot write under its default home, point it at a project-local directory before launching chat or agents:

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo
```

For Codex-friendly notifications, prefer foreground or daemon bus helpers instead of terminal text injection:

```bash
ufoo bus alert codex:abc123 --daemon
ufoo bus listen codex:abc123
```

## License

UNLICENSED. See [LICENSE](LICENSE).

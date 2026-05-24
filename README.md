# ufoo

[中文](README.zh-CN.md)

ufoo is a project-scoped multi-agent workspace runtime. It wraps Claude Code,
OpenAI Codex, Antigravity, and ufoo's native `ucode` agent with a shared chat
dashboard, daemon, event bus, memory, reports, group orchestration, and terminal
launch modes.

Package: [u-foo on npm](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## Highlights

- One TUI dashboard for launching, watching, messaging, and resuming agents.
- Project daemon over `.ufoo/run/ufoo.sock` for launch/resume, reports, groups,
  cron, and controller routing.
- Project-local event bus for agent-to-agent messages, wakeups, queue checks,
  and activation.
- Shared context primitives: decisions, durable memory, prompt history, reports,
  and agent registry state.
- Launch modes for internal, tmux, host, Terminal.app, and iTerm2 workflows.
- Built-in group templates for launching and orchestrating multi-agent workflows.
- `ucode`, a native ufoo coding-agent runtime.

## Requirements

- Node.js 18 or newer.
- macOS for Terminal.app/iTerm2 integration.
- Claude Code, Codex CLI, or Antigravity CLI installed when using the matching
  wrappers: `uclaude`, `ucodex`, or `uagy`.

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

| Binary | Purpose |
|---|---|
| `ufoo` | Main CLI, chat dashboard, daemon, groups, bus, context, memory, reports, and online helpers. |
| `uclaude` | Claude Code wrapper with ufoo bootstrap and bus identity. |
| `ucodex` | Codex wrapper with ufoo bootstrap and bus identity. |
| `uagy` | Antigravity wrapper with ufoo bootstrap and bus identity. |
| `ucode` | Native ufoo coding-agent CLI/TUI. |

## Quick Start

Initialize a project and open the chat dashboard:

```bash
cd your-project
ufoo init --modules context,bus
ufoo
```

Launch agents from chat:

```text
> /launch codex reviewer
> /launch claude builder
> /launch ucode fixer
> @reviewer inspect the current diff and list release risks
```

Or launch wrappers directly inside a project:

```bash
uclaude
ucodex
uagy
ucode
```

Use global chat mode to switch between registered projects:

```bash
ufoo -g
```

## Runtime Model

```text
ufoo / ufoo chat
  -> src/app/chat + src/ui/ink
  -> project daemon over .ufoo/run/ufoo.sock
  -> runtime daemon launch/resume/recover/reports/cron/groups
  -> orchestration router, group templates, solo roles
  -> agents launch/providers/internal/controller/activity
  -> coordination bus/context/memory/history/report/state/status
  -> shared controller/worker tools and native ucode tools
```

Chat is a UI client. The daemon owns project runtime state. Agents communicate
through bus queues, prompt injection, shared memory, reports, and tool handlers
instead of importing chat UI code.

## Daily Usage

The normal workflow is to enter chat first, then launch agents and run project
commands inside the dashboard:

```bash
ufoo
ufoo -g
```

`ufoo` opens the current project chat. `ufoo -g` opens global chat for switching
between registered projects. The project daemon is started as needed.

### Chat Commands

```text
/launch codex reviewer
/launch claude builder
/launch ucode fixer
@reviewer inspect the current diff and list release risks

/status
/settings
/multi
/resume list
/project list
/project switch 2
/open /path/to/project
```

Direct wrapper commands such as `uclaude`, `ucodex`, `uagy`, and `ucode` are
still available, but the normal ufoo workflow is to work from chat.

### Initialization And Maintenance

These are setup or troubleshooting commands. In chat, use slash commands:

```text
/init context bus resources
/doctor
/status
/daemon status
/daemon restart
/daemon stop
/daemon start
```

`ufoo init` creates `.ufoo/`, ensures `AGENTS.md` and `CLAUDE.md`, initializes
selected modules, and prepares shared storage. `CLAUDE.md` may be a symlink;
edit project instructions in `AGENTS.md`.

Before a project has been initialized, the equivalent CLI form is also useful:
`ufoo init --modules context,bus`.

### Event Bus

```text
/bus list
/bus status
/bus send codex:abc123 Please implement the approved slice.
/bus activate reviewer
/bus rename codex:abc123 reviewer
```

Use `/bus status` to find the real subscriber ID or resolvable nickname
before sending. Agents should handle pending work, reply to the sender, and
acknowledge their queue.

### Context, Memory, History, Reports

Inside chat:

```text
/ctx status
/ctx doctor
/ctx decisions
```

Memory, history, and report management are CLI utilities:

```bash
ufoo memory add "Provider contract" --body "Durable fact..." --tags provider,contract
ufoo memory list --tag provider
ufoo memory show mem-0001

ufoo history build
ufoo history show 20
ufoo history prompt 30

ufoo report start "Implement README refresh" --task docs-readme --agent builder
ufoo report done "README updated" --task docs-readme --agent builder
ufoo report list
```

Use decisions only for plan-level constraints. Durable project facts belong in
memory.

### Groups

Built-in group templates live in `templates/groups/`.

```text
/group templates
/group template show build-lane
/group template validate templates/groups/build-lane.json
/group run build-lane dry_run=true
/group run build-lane instance=docs-refresh
/group status
/group diagram build-lane mermaid
/group stop docs-refresh
```

### Online Relay

```bash
ufoo online server --host 127.0.0.1 --port 8787
ufoo online token codex:abc123 --nickname builder
ufoo online room create --nickname builder --name review-room --type private --password secret
ufoo online connect --nickname builder --room <room_id> --room-password secret
ufoo online send --nickname builder --room <room_id> --text "handoff ready"
ufoo online inbox builder --unread
```

The default public service URL is `https://online.ufoo.dev`. Local development
can run its own relay with `ufoo online server`.

### Native ucode Runtime

```bash
ufoo ucode doctor
ufoo ucode prepare
ufoo ucode build
```

`ucode` can discover built-in and local `SKILL.md` workflow capabilities. Full
skill bodies are loaded only when explicitly referenced.

## Configuration

Project configuration is stored in `.ufoo/config.json`. `ucode` provider
credentials are stored globally in `~/.ufoo/config.json` and merged at load time.

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

Supported `launchMode` values: `auto`, `internal`, `tmux`, `terminal`, and
`host`. `controllerMode` accepts `main`, `shadow`, `loop`, and legacy
compatibility values.

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

## Source Layout

```text
src/
  app/            chat client state and CLI command entry
  ui/             Ink components and pure formatting helpers
  runtime/        daemon, projects, terminal adapters, contracts, privacy, process helpers
  coordination/   bus, context, memory, history, reports, state, status
  orchestration/  router/controller logic, groups, solo roles
  agents/         launchers, providers, prompts, internal runner, activity, controller
  code/           native ucode runtime, launcher, skills, file/shell tools
  tools/          shared controller/worker tool registry and handlers
  online/         relay client/server/runner/token helpers
```

See [PROJECT.md](PROJECT.md) for the maintainer-facing map and
[docs/source-structure.md](docs/source-structure.md) for detailed package
ownership.

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
```

The repository is CommonJS, targets Node.js 18+, and has no build step.

## Release

Use the standard npm flow from a clean worktree:

```bash
npm test
npm pack --dry-run
npm version patch
npm publish --access public
git push --follow-tags
```

`npm pack --dry-run` should be used to verify the final tarball. Publishing
requires an npm account/token with permission for `u-foo`.

## Troubleshooting

Run a local entry directly if the linked binary is not on `PATH`:

```bash
node bin/ufoo.js --help
```

If Codex cannot write under its default home, point it at a project-local
directory before launching chat or agents:

```bash
export CODEX_HOME="$PWD/.ufoo/codex"
ufoo
```

For Codex-friendly notifications, prefer bus helpers over raw terminal text
injection:

```bash
ufoo bus alert codex:abc123 --daemon
ufoo bus listen codex:abc123
```

## License

UNLICENSED. See [LICENSE](LICENSE).

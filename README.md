# ufoo

[中文](README.zh-CN.md)

ufoo is a project-scoped multi-agent workspace runtime. It wraps Claude Code,
OpenAI Codex, Antigravity, Grok Build, Kimi Code, and ufoo's native `ucode`
agent with a shared chat dashboard, daemon, event bus, memory, reports, group
orchestration, and terminal launch modes.

Package: [u-foo on npm](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## Highlights

- One TUI dashboard for launching, watching, messaging, and resuming agents.
- One user-scoped daemon over `~/.ufoo/run/ufoo.sock`, hosting isolated project
  runtimes for launch/resume, reports, groups, cron, and controller routing.
- Project-local event bus for agent-to-agent messages, wakeups, queue checks,
  and activation.
- Shared context primitives: decisions, durable memory, prompt history, reports,
  and agent registry state.
- Launch modes for internal, tmux, host, Terminal.app, and iTerm2 workflows.
- Built-in group templates for launching and orchestrating multi-agent workflows.
- `ucode`, a native ufoo coding-agent runtime.
- One loopback Streamable HTTP MCP server inside the home-scoped global
  controller daemon, plus a disposable `ufoo mcp` stdio compatibility proxy.

## Requirements

- Node.js 18 or newer.
- macOS for Terminal.app/iTerm2 integration.
- Claude Code, Codex CLI, Antigravity CLI, Grok Build, or Kimi Code installed
  when using the matching wrappers: `uclaude`, `ucodex`, `uagy`, `ugrok`, or
  `ukimi`.

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
| `ufoo` | Main CLI, chat dashboard, daemons, global MCP server/proxy, groups, bus, context, memory, reports, and online helpers. |
| `uclaude` | Claude Code wrapper with ufoo bootstrap and bus identity. |
| `ucodex` | Codex wrapper with ufoo bootstrap and bus identity. |
| `uagy` | Antigravity wrapper with ufoo bootstrap and bus identity. |
| `ugrok` | Grok Build wrapper with ufoo bootstrap and bus identity. |
| `ukimi` | Kimi Code wrapper with ufoo bootstrap and bus identity. |
| `ucode` | Native ufoo coding-agent CLI/TUI. |

## Quick Start

Initialize a project and open the chat dashboard:

```bash
cd your-project
ufoo init --targets context,bus
ufoo
```

Launch agents from chat:

```text
> /launch codex reviewer
> /launch claude builder
> /launch grok explorer
> /launch ucode fixer
> @reviewer inspect the current diff and list release risks
```

Or launch wrappers directly inside a project:

```bash
uclaude
ucodex
uagy
ugrok
ukimi
ucode
```

Use global chat mode to switch between registered projects:

```bash
ufoo -g
```

For Codex App, Codex CLI, and the Codex IDE extension, start global mode once
and install the shared direct HTTP configuration:

```bash
ufoo -g
ufoo mcp configure codex
```

The configuration points all three Codex surfaces at the same authenticated
loopback endpoint. Restart the Codex surface after configuring it.

For a host that has not been verified with direct HTTP, keep the compatible
stdio configuration:

```bash
ufoo mcp
```

This command is a stateless transport proxy into the same global server. It
does not own Agent registrations or project state. Inspect or restart the
singleton listener with `ufoo mcp status` and `ufoo mcp restart`.

## Runtime Model

```text
ufoo / ufoo chat
  -> src/app/chat + src/ui/rustChatHost + crates/ufoo-tui
  -> global daemon over ~/.ufoo/run/ufoo.sock
  -> isolated ProjectRuntime selected by project_root
  -> runtime launch/resume/recover/reports/cron/groups
  -> orchestration router, group templates, solo roles
  -> agents launch/providers/internal/controller/activity
  -> coordination bus/context/memory/history/report/state/status
  -> shared controller/worker tools and native ucode tools

Codex App / CLI / IDE -> Streamable HTTP --+
ufoo mcp stdio proxy ----------------------+
                                           -> home-scoped global controller daemon
                                              (one MCP listener and tool router)
  -> ~/.ufoo/projects/runtime
  -> managed ProjectRuntimeGateway
  -> selected in-process ProjectRuntime for bus/report/activity/wait state
```

Global topology is the default. `ufoo daemon --topology hybrid` temporarily
enables project compatibility sockets, and `--topology project` selects the
legacy per-project daemon rollback path.

### Agent Delivery Modes

ufoo supports two Agent delivery modes, selected only from the host Agent's
inherited `UFOO_SUBSCRIBER_ID` before any helper terminal is started:

- Wrapper-managed Agents start through `ucodex`, `uclaude`, `uagy`, `ugrok`, `ukimi`, or
  `ucode`. The wrapper provides `UFOO_SUBSCRIBER_ID`; ufoo monitors the shell
  activity and injection endpoint, so bus messages can be injected directly.
  These Agents reuse the environment identity and do not register through MCP
  or run a resident bus poll.
- Externally hosted Agents have no wrapper-provided subscriber environment.
  They register themselves once through MCP `register_agent`, retain the
  returned subscriber plus opaque `agent_handle`, and select the host App's
  native no-token wait:
  Codex App keeps MCP `wait_for_message` pending, while Cursor monitors
  `ufoo bus poll --follow` background output with `notify_on_output`.

Agent type names and subscriber prefixes are routing metadata, not capability
signals. After an external Cursor Agent registers through MCP, its dedicated
listener terminal may export the returned subscriber as
`UFOO_SUBSCRIBER_ID` so CLI operations share one identity. That child-shell
binding does not alter the host Agent's already selected external mode and is
not evidence of wrapper injection.

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
between registered projects. The global daemon starts once and project runtimes
activate lazily.

### Chat Commands

```text
/launch codex reviewer
/launch claude builder
/launch grok explorer
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

Direct wrapper commands such as `uclaude`, `ucodex`, `uagy`, `ugrok`, `ukimi`, and
`ucode` are still available, but the normal ufoo workflow is to work from chat.

### Initialization And Maintenance

These are setup or troubleshooting commands. In chat, use slash commands:

```text
/init context bus
/doctor
/status
/daemon status
/daemon restart
/daemon stop
/daemon start
```

`ufoo init` creates `.ufoo/`, ensures `AGENTS.md` and `CLAUDE.md`, initializes
selected workspace state, and prepares shared storage. `CLAUDE.md` may be a
symlink; edit project instructions in `AGENTS.md`.

Before a project has been initialized, the equivalent CLI form is also useful:
`ufoo init --targets context,bus`.

The default agent skill set is intentionally limited to `ufoo`, `ufoo-bus`,
`ufoo-context`, and `ufoo-online`. They are installed only as skills, not as a
second command catalog. Initialization and unified status are handled by
`ufoo`.

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

Externally hosted Agents with no `UFOO_SUBSCRIBER_ID` use the opt-in
`ufoo-bus-poll` skill to select their host App's queue-read-only wait and
self-wake mechanism:

```bash
ufoo skills list --optional
ufoo skills install ufoo-bus-poll --target /path/to/that/agent/skills
```

Register once through MCP `register_agent` and retain its returned subscriber
and `agent_handle`. Include the handle in heartbeat, activity, send, receive,
acknowledgement, report, and unregister calls. The handle is an ownership
capability: do not send it to peers or print it in reports.

- **Codex App:** call MCP `wait_for_message` in the foreground with
  the registered subscriber and handle, `after_seq: 0`, and
  `timeout_seconds: 0`. The tool call stays pending inside the dedicated
  `ufoo_wait` MCP connection until a message arrives or the caller cancels it;
  idle time produces no periodic model wake or token consumption. A message
  returns immediately and wakes the task without shell stdout. After handling
  a message response, call MCP `ack_bus` with the same handle and its
  `last_seq` as `through_seq`, then re-arm with that `last_seq` when the Agent
  is idle again.
- **Cursor:** bind the MCP subscriber and run
  `export UFOO_SUBSCRIBER_ID="<subscriber-id>"; exec ufoo bus poll
  "$UFOO_SUBSCRIBER_ID" --follow --interval 30` through the monitored
  background shell with `block_until_ms: 0`, and configure
  `notify_on_output` to match `\[ufoo\]`. Startup and empty intervals are
  silent; only ufoo-delivered messages wake the model.

Both paths keep idle queue checks outside the LLM. A background PTY alone is
not a wake mechanism in Codex App.

The poll skill is not installed by postinstall or `skills install all`.
Wrapper-managed Agents skip MCP registration and external waiting when
`UFOO_SUBSCRIBER_ID` was present in the Agent's inherited launch environment.
A value exported later inside a Cursor listener terminal does not rerun this
classification. Receive-path selection depends on host App capabilities, never
on whether the external Agent calls itself Codex, Claude, Cursor, or another
type.

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
  ui/             Rust TUI hosts + pure formatting helpers
  crates/ufoo-tui Rust ratatui child (required for chat/ucode)
  runtime/        daemon, projects, terminal adapters, contracts, privacy, process helpers
  coordination/   bus, context, memory, history, reports, state, status
  orchestration/  router/controller logic, groups, solo roles
  agents/         launchers, providers, prompts, internal runner, activity, controller
  code/           native ucode runtime, launcher, skills, file/shell tools
  tools/          shared controller/worker tool registry and handlers
  online/         relay client/server/runner/token helpers
```

See [PROJECT.md](PROJECT.md) for the maintainer-facing map and detailed package
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
```

The repository is CommonJS, targets Node.js 18+, and ships a Rust TTY UI
(`crates/ufoo-tui`) as platform binaries under `dist/tui/`.

## Release

Releases are published by GitHub Actions (`.github/workflows/release.yml`).
The workflow builds `ufoo-tui` for `darwin-arm64`, `darwin-x64`, `linux-x64`,
and `linux-arm64`, stages them under `dist/tui/<platform>/`, then runs
`npm publish`.

1. Bump the version and push a matching tag:

```bash
npm test
npm version patch   # commits package.json + creates tag vX.Y.Z
git push --follow-tags
```

2. Ensure the repo secret `NPM_TOKEN` is set (npm automation token with
   publish rights for `u-foo`).
3. The `Release` workflow runs on the `v*` tag. Use **Actions → Release →
   Run workflow** for a manual dry-run (`dry_run=true` packs but does not publish).

Local one-platform staging (dev only):

```bash
npm run pack:tui          # cargo build + copy into dist/tui/$PLATFORM
npm pack --dry-run        # requires at least one staged binary (prepack check)
```

Publishing without the GitHub workflow still requires an npm account/token with
permission for `u-foo`, plus staged `dist/tui/` binaries.
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

# ufoo Project Guide

This file is the maintainer-facing map for the ufoo repository. The public
user guide lives in [README.md](README.md).

## Purpose

ufoo is a multi-agent workspace runtime. It gives a project one shared daemon,
chat dashboard, event bus, memory/context system, reports, group orchestration,
terminal launch layer, and tool registry for Claude Code, Codex, Antigravity,
and native `ucode` agents.

The core design rule is simple: chat is a client, the daemon owns runtime state,
and agents coordinate through `.ufoo/` state plus bus/tool contracts.

## Entry Points

Published binaries are defined in `package.json`.

| Binary | Main file | Responsibility |
|---|---|---|
| `ufoo` | `bin/ufoo.js` | Main CLI, chat dashboard, daemons, global MCP server/proxy, project commands, bus/context/memory/report/group/online commands. |
| `uclaude` | `bin/uclaude.js` | Claude Code wrapper with bootstrap, identity, bus registration, and resume metadata. |
| `ucodex` | `bin/ucodex.js` | Codex wrapper with bootstrap, identity, bus registration, and resume metadata. |
| `uagy` | `bin/uagy.js` | Antigravity wrapper with bootstrap, identity, and conversation resume capture. |
| `ukimi` | `bin/ukimi.js` | Kimi Code wrapper with bootstrap, identity, bus registration, and resume metadata. |
| `ucode` | `bin/ucode.js` | Native ufoo coding-agent CLI/TUI. |

## Runtime Shape

```text
ufoo / ufoo chat
  -> src/app/chat + src/ui/rustChatHost + crates/ufoo-tui
  -> project daemon over .ufoo/run/ufoo.sock
  -> src/runtime/daemon owns launch/resume/recover/reports/cron/groups
  -> src/orchestration routes controller, group, and solo behavior
  -> src/agents runs launchers, providers, prompts, internal runners, controller loop
  -> src/code runs native ucode
  -> src/coordination stores bus/context/memory/history/report/state/status
  -> src/tools exposes shared controller/worker tools

Codex App / CLI / IDE -> Streamable HTTP --+
ufoo mcp stdio proxy ----------------------+
                                           -> home-scoped global controller daemon
  -> one MCP listener and tool router
  -> ~/.ufoo/projects/runtime registry
  -> ProjectRuntimeGateway over correlated daemon IPC
  -> selected project daemon and project-local bus/report/activity/wait state
```

Important boundaries:

- UI code may render state and call injected callbacks; it should not directly
  write bus queues, launch processes, or own daemon state.
- Runtime code may call orchestration, coordination, and agent launchers; it
  should not import TUI render components (`crates/ufoo-tui` is a separate process).
- Prompt builders should not import UI or daemon implementations.
- Provider adapters should not know about chat commands.
- Runtime contracts should not import CLI features.

### Agent Delivery Modes

The bus protocol has exactly two Agent delivery branches. The sole branch
signal is the host Agent's inherited launch environment before any helper
terminal is created, never `agent_type` or a subscriber prefix:

1. A nonempty `UFOO_SUBSCRIBER_ID` identifies a wrapper-managed launch
   (`ucodex`, `uclaude`, `uagy`, `ukimi`, or `ucode`). The wrapper/daemon owns
   registration, monitors shell activity, retains the injection endpoint, and
   delivers bus messages by direct prompt injection. The Agent must not call
   MCP `register_agent`, bare `ufoo bus join`, or resident `ufoo bus poll`.
2. An absent `UFOO_SUBSCRIBER_ID` identifies an externally hosted Agent. It
   self-registers once through MCP, retains the returned subscriber and opaque
   `agent_handle`, then
   selects one receive wait from the host App's wake capability:
   - Codex App keeps one MCP `wait_for_message` tool call pending for up to 600
     seconds and re-arms it with the returned sequence cursor.
   - Cursor may export the returned subscriber as `UFOO_SUBSCRIBER_ID` inside
     its dedicated listener terminal, keeps one host-monitored
     `ufoo bus poll --follow` process, and wakes on `notify_on_output`.

Both external paths are queue readers, not injection-capability detectors, and
share one receive lease per subscriber. Agent type values remain routing
metadata and must not be used as an admission denylist. Codex App waits remain
inside the MCP call; Cursor hosts match the general `[ufoo]` delivery prefix,
and shell poll startup/idle paths remain output-silent. A helper-terminal
export happens only after external registration and must not be reused as
evidence that the host Agent was wrapper-launched.

## Source Ownership

| Package | Owner concept | Notes |
|---|---|---|
| `src/app/chat/` | Chat client | Slash commands, daemon connection, multi-window panes, agent selection, `ChatController`, history/stream helpers. |
| `src/app/cli/` | CLI entry | Main command runner and command groups. |
| `src/app/cli/features/` | CLI features | Init, doctor, and skill installation logic used by CLI/chat/daemon entry paths. |
| `src/ui/format/` | Pure display helpers | Width, markdown, status, input, and banner formatting. |
| `src/ui/tuiLauncher.js` | Rust TUI launch plan | `UFOO_TUI=auto\|rust`; binary resolve. |
| `src/ui/uiHostServer.js` | UI socket host | Node side of `ufoo-ui/1` (hello/welcome/events/commands). |
| `src/ui/rustChatHost.js` | Rust chat composition | Daemon + history + spawn `ufoo-tui --surface chat`. |
| `src/ui/rustUcodeHost.js` | Rust ucode composition | Session/runner ports + spawn `ufoo-tui --surface ucode`. |
| `src/ui/scrollbackReplay.js` | Scrollback replay harness | Fixture-driven cap/stream replay (Phase 2). |
| `src/ui/toolMergeBridge.js` | Tool-merge → UI events | Collapsed `tool.*` publisher for Rust hosts. |
| `src/ui/ptyHandoff.js` | Stdin restore helper | After any fullscreen handoff; PTY mirror removed. |
| `crates/ufoo-tui/` | Rust TTY UI | Required `ufoo-ui/1` child process (ratatui). |
| `src/runtime/daemon/` | Project/global daemon and MCP control plane | Global Streamable HTTP listener, stateless stdio proxy, ProjectRuntime gateway/IPC, MCP leases/configuration, prompt routing, launch/resume/close, cron, reports, status, group orchestration. |
| `src/runtime/projects/` | Project registry | Project identity and runtime registry. |
| `src/runtime/terminal/` | Terminal adapters | Host, tmux, internal, external, Terminal.app, iTerm2. |
| `src/runtime/contracts/` | Runtime contracts | Daemon IPC, PTY socket, MCP/JSON-RPC, and `ufoo-ui/1` host↔TUI protocol. |
| `src/runtime/privacy/` | Privacy helpers | Secret redaction and shadow-diff helpers. |
| `src/runtime/process/` | Process helpers | Node executable resolution and similar runtime process utilities. |
| `src/coordination/bus/` | Event bus | Queues, envelopes, injection helpers, nicknames, and subscribers. |
| `src/coordination/context/` | Decisions | Decision files, sync, and context doctor. |
| `src/coordination/memory/` | Memory | Durable memory and history search. |
| `src/coordination/history/` | Prompt timeline | Input/prompt history. |
| `src/coordination/report/` | Reports | Agent report store and controller inbox records. |
| `src/coordination/state/` | `.ufoo` state | Path resolution, agent registry persistence, registry diagnostics. |
| `src/coordination/status/` | Status | Project and coordination status summaries. |
| `src/orchestration/controller/` | Router/controller policy | Gate/main/global/loop routing, flags, launch routing, finalization, shadow guard. |
| `src/orchestration/groups/` | Groups | Templates, diagrams, validation, prompt profiles, bootstrap planning. |
| `src/orchestration/solo/` | Solo roles | Solo role command helpers. |
| `src/agents/prompts/` | Prompts | Bootstrap prompts, group prompts, profile prompts, native `ucode` prompt sections. |
| `src/agents/providers/` | Provider adapters | Claude/Codex thread providers, event translators, credentials, direct auth, upstream transports. |
| `src/agents/launch/` | Agent launch | External CLI launchers, PTY runner/wrapper, notifier, ready detection, environment setup. |
| `src/agents/internal/` | Internal agents | SDK/API-backed embedded internal runner. |
| `src/agents/activity/` | Activity tracking | Ready/activity detectors and state publishing. |
| `src/agents/controller/` | `ufoo-agent` | Controller loop runtime, observability, tool executor. |
| `src/code/` | Native `ucode` | Native agent loop, provider runner, session store, skills, TUI, `UcodeController`, launcher helpers. |
| `src/tools/` | Shared tool registry | Controller/worker tool definitions, schemas, handlers, tier permissions. |
| `src/online/` | Online relay | Relay client/server/runner and token helpers. |
| `src/config.js` | Config | Project/global config loading and normalization. |
| `SKILLS/` | Default agent skills | The focused `ufoo`, `ufoo-bus`, `ufoo-context`, and `ufoo-online` set installed by package postinstall and by `ufoo skills install all`. |
| `OPTIONAL_SKILLS/` | Opt-in agent skills | Discoverable with `ufoo skills list --optional`; installed only by explicit name. |

## Dependency Direction

Preferred flow:

```text
app -> ui
app -> runtime -> coordination
app -> orchestration -> agents
runtime -> orchestration -> agents/providers
agents -> coordination
agents -> runtime/contracts
coordination -> runtime/privacy
ui -> ui/format
```

Allowed practical exceptions should stay narrow and documented near the import.
Do not recreate compatibility directories for old paths.

## Local State

`ufoo init --targets context,bus` creates the project-local runtime root:

```text
.ufoo/
  memory/
  context/
    decisions/
    decisions.jsonl
  bus/
    events/
    queues/
    logs/
    offsets/
  agent/
    all-agents.json
  daemon/
  run/
```

Global state lives under `~/.ufoo/`, including `~/.ufoo/config.json`, the
home-scoped global controller daemon state, and global project registry records
under `~/.ufoo/projects/runtime`.

## Development Commands

```bash
npm install
npm test
npm run test:watch
npm run test:coverage
```

Useful smoke checks after source moves:

```bash
node -e "require('./src/app/chat'); require('./src/ui/rustChatHost'); require('./src/code/tui'); console.log('ok')"
node -e "require('./src/app/cli/run'); require('./src/runtime/daemon'); require('./src/runtime/daemon/mcpServer'); require('./src/tools'); console.log('ok')"
git diff --check
```

There is no build step. The package is CommonJS and targets Node.js 18+.

## Test Guidance

| Change type | Minimum checks |
|---|---|
| Source package move | `npm test` |
| Chat/UI behavior | `npm test -- --runTestsByPath test/unit/ui/tuiLauncher.test.js test/unit/chat/commandExecutor.test.js` |
| Runtime daemon behavior | `npm test -- --runTestsByPath test/unit/daemon/run.test.js test/unit/daemon/promptRequest.test.js` |
| MCP control-plane behavior | `npm test -- --runTestsByPath test/unit/daemon/mcpHttpServer.test.js test/unit/daemon/mcpStdioProxy.test.js test/unit/daemon/mcpServer.test.js test/unit/daemon/mcpIntegration.test.js test/unit/daemon/projectRuntimeGateway.test.js test/unit/daemon/projectRuntimeControlPlane.test.js test/unit/tools/registry.test.js test/unit/shared/eventContract.test.js` |
| Agent launch/provider code | `npm test -- --runTestsByPath test/unit/agent/launcher.test.js test/unit/agent/internalRunner.test.js test/unit/agent/ufooAgent.test.js` |
| Tool registry/handlers | `npm test -- --runTestsByPath test/unit/tools/registry.test.js test/unit/tools/handlers.test.js` |
| Native `ucode` | `npm test -- --runTestsByPath test/unit/code/ucodeTui.test.js test/unit/code/nativeRunner.test.js` |
| Documentation text | `git diff --check` |

## Documentation Rules

- Keep README user-facing. Keep PROJECT maintainer-facing.
- `CLAUDE.md` is a symlink to `AGENTS.md`; prefer edits in `AGENTS.md`.

## Release Flow

Releases go through GitHub Actions (`.github/workflows/release.yml`):

1. `npm version patch` (or minor/major) and `git push --follow-tags`
2. Tag `v*` triggers multi-platform `ufoo-tui` builds → `dist/tui/<plat>/`
3. Workflow publishes `u-foo` to npm (`NPM_TOKEN` secret required)

Local staging helper: `npm run pack:tui` (current host only).
`prepack` fails if `dist/tui/` has no binaries.

CI (`.github/workflows/ci.yml`) runs `npm test` and a release `ufoo-tui` build
on pushes/PRs to `master`.

# ufoo Project Guide

This file is the maintainer-facing map for the ufoo repository. The public
user guide lives in [README.md](README.md).

## Purpose

ufoo is a multi-agent workspace runtime. One user-scoped global daemon hosts
isolated project runtimes for chat dashboards, event buses, memory/context,
reports, group orchestration, terminal launch, and tool routing across Claude
Code, Codex, Antigravity, Grok Build, Kimi Code, and native `ucode` agents.

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
| `ugrok` | `bin/ugrok.js` | Grok Build wrapper with bootstrap, identity, and bus registration. |
| `ukimi` | `bin/ukimi.js` | Kimi Code wrapper with bootstrap, identity, bus registration, and resume metadata. |
| `ucode` | `bin/ucode.js` | Native ufoo coding-agent CLI/TUI. |

Grok/xAI provider work beyond the CLI wrapper is tracked in
[GROK_PROVIDER_V2.md](GROK_PROVIDER_V2.md).

The layered, pluggable runtime migration is documented in
[AGENT_RUNTIME_REFACTOR.md](AGENT_RUNTIME_REFACTOR.md). Native `ucode` uses the
shared capability-composed loop alongside the project main agent and controller
JSON adapter. The project main agent can code, delegate, manage independent tasks,
and use group/cron services; the global profile only selects projects. The
document records implemented APIs and conservative recovery boundaries.

## Runtime Shape

```text
ufoo / ufoo chat
  -> src/app/chat + src/ui/rustChatHost + crates/ufoo-tui
  -> global daemon over ~/.ufoo/run/ufoo.sock
  -> ProjectRuntimeManager selects an isolated project runtime
  -> src/runtime/daemon owns launch/resume/recover/reports/cron/groups
  -> src/runtime/daemon/agentHost composes project main and global-router profiles
  -> src/orchestration retains controller compatibility, group, and solo policy
  -> src/agents runs launchers, providers, prompts, internal runners, controller loop
  -> src/code composes native ucode using src/agents/runtime + capabilities
  -> src/coordination stores bus/context/memory/history/report/state/status
  -> src/tools exposes shared controller/worker tools

Codex App / CLI / IDE -> Streamable HTTP --+
ufoo mcp stdio proxy ----------------------+
                                           -> home-scoped global controller daemon
  -> one MCP listener and tool router
  -> ~/.ufoo/projects/runtime registry
  -> managed ProjectRuntimeGateway
  -> selected in-process ProjectRuntime and project-local bus/report/activity/wait state
```

`daemonTopology=global` is the default. `hybrid` temporarily exposes
project-local compatibility sockets, while `project` retains the legacy
per-project daemon path as a rollback mode. Global project runtimes never own
project PID/lock files. Idle runtimes without clients, Agents, or cron work can
be suspended and lazily reactivated.

Important boundaries:

- A persistent dashboard socket subscribes to its selected project runtime.
  Global routing moves that subscription between projects and the controller;
  project event streams and status pushes must reach the selected client without
  leaking another runtime's status into its agent panes.
- UI code may render state and call injected callbacks; it should not directly
  write bus queues, launch processes, or own daemon state.
- The ufoo dashboard and main-agent roster manage only explicitly internal
  children. Wrapper/MCP agents remain in the shared registry for cooperation,
  but cannot enter dashboard lists, panes, watches, or automatic main-agent
  messages. Dashboard and main-agent launches force internal mode independently
  of wrapper launch settings. The welcome banner reuses the compact CLI logo
  and appears only when a project has no chat or input history.
- Internal Codex, Claude and ucode use a shared transcript and status surface.
  One bottom input follows the selected agent; each draft stays independent.
  Each agent's status is embedded in its own pane's bottom border.
  The main input is labelled `main`; child activity and focus changes do not
  replace the main agent's status. Footer selection and provider settings stay
  available with an internal child focused.
  Native ucode's headless thread calls the same coding runner, tools, context and
  session code as standalone ucode. Presentation adapters
  live in `src/ui/agentSurface.js` and `src/ui/agentPresentation.js`.
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
   (`ucodex`, `uclaude`, `uagy`, `ugrok`, `ukimi`, or `ucode`). The wrapper/daemon owns
   registration, monitors shell activity, retains the injection endpoint, and
   delivers bus messages by direct prompt injection. The Agent must not call
   MCP `register_agent`, bare `ufoo bus join`, or resident `ufoo bus poll`.
   Current wrappers also inherit `UFOO_AGENT_HANDLE` for the same MCP send,
   acknowledgement, and report tools used by external Agents. The handle hash
   is persisted; the raw capability stays in the child environment. MCP
   resident waits, activity updates, and unregister are rejected for managed
   identities so they cannot compete with their host. Older wrappers retain
   the CLI fallback.
2. An absent `UFOO_SUBSCRIBER_ID` identifies an externally hosted Agent. It
   self-registers once through MCP, retains the returned subscriber and opaque
   `agent_handle`, and may provide a stable `client_instance_id` to recover that
   server-assigned subscriber after transport restarts. New external subscriber
   session suffixes use the same eight-character server-generated shape as
   wrapper registrations, and automatic nicknames use the same
   `<agent-prefix>-<number>` allocator. Thus a Cursor MCP Agent registers as
   `cursor:<8-hex>` with `cursor-N`; its potentially UUID-shaped
   `client_instance_id` remains recovery metadata and never becomes the suffix.
   A legacy UUID-suffix registration is superseded on its next registration.
   MCP Agents cannot provide or update either identity field; explicit operator
   renames use the controller/CLI rename path. The Agent then
   selects one receive wait from the host App's wake capability:
   - Codex App keeps one MCP `wait_for_message` tool call pending until a
     message arrives or the caller cancels it. A dedicated `ufoo_wait` MCP
     connection isolates the session-lifetime client timeout from normal ufoo
     tools, so idle time produces no periodic model wake.
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

`dispatch_message` confirms queue persistence, with `delivery_status=queued`,
`queued=<target count>`, and `delivered=0` in both injection modes. It does not
confirm host delivery or task completion. `read_project_registry` defaults to
100 rows and hides deleted workspace paths; follow `next_offset` for another
page, filter by `project_root`, or use `include_missing` for diagnostics.
`ufoo project prune` previews old deleted-workspace registrations without live
processes or sockets; `--apply` moves them into `~/.ufoo/projects/archive/`
for recovery. Reads never prune registrations.

The stdio compatibility proxy refreshes its HTTP session after listener
restarts. Concurrent recovery shares one handshake. It only replays reads
after an uncertain disconnect; a write returns `UFOO_MCP_OUTCOME_UNKNOWN` so
the caller can inspect persisted state before retrying. Resident receive calls
have no proxy or HTTP transport idle timer, and disconnect/cancellation releases
the receive lease. Expired HTTP sessions return 404 for native client recovery.

Codex rollout discovery reads the full first metadata record (bounded to 2 MB)
and requires a unique match after launch, or an exact known provider session id.
Multiple active same-project Codex Agents require exact binding; ambiguous
discovery stays unresolved rather than attaching another Agent's conversation.
PTY readiness requires an actual prompt line and is never manufactured merely
because ten seconds elapsed. Interactive Codex/Claude launches use native
messages by default on macOS/Linux; `--no-native-messages` or
`UFOO_NATIVE_MESSAGES=0` opts out. Headless/meta commands and internal agents
retain their existing behavior. Launchers probe installed CLI versions and Codex remote support; versions older than the verified baselines use legacy delivery unless native mode was explicitly required. `src/agents/launch/nativeMessages.js` observes
the real Codex TUI's thread response through a private app-server transport and
queues bus work through `thread/queue/add`; it never precreates an empty thread
for TUI resume. `src/runtime/daemon/claudeChannel.js` implements a bound stdio MCP
channel and requires an acknowledged native startup probe. Native delivery can
queue while busy, retains uncertain receipts, and never falls back to keyboard
injection. Configuration is launch-local; global host settings and credentials
remain intact. Wrappers still own terminal rendering, activity, and lifecycle.

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
| `src/ui/agentSurface.js` | Shared agent presentation state | Ordered text/thinking/tool blocks for standalone ucode and all internal panes. |
| `src/ui/rustMultiSession.js` | Embedded agent host | Internal-only surfaces, drafts, durable observation replay, split layout protocol. |
| `crates/ufoo-tui/src/agent_surface.rs` | Shared agent renderer | Transcript blocks, tool/thinking expansion and multiline input chrome for standalone and embedded agents. |
| `src/code/internalThread.js` | Embedded native coding thread | Adapts the same native ucode runner to internal tasks, streaming, sessions and user replies. |
| `src/coordination/history/agentSurface.js` | Internal display observations | Redacted ordered provider events, independent of inbox delivery and reply targets. |
| `src/ui/toolMergeBridge.js` | Tool-merge → UI events | Collapsed `tool.*` publisher for Rust hosts. |
| `crates/ufoo-tui/` | Rust TTY UI | Required `ufoo-ui/1` child process (ratatui). |
| `src/runtime/daemon/` | Global daemon and project runtime control plane | `GlobalDaemon`, immutable `ProjectContext`, `ProjectRuntimeManager`, global Streamable HTTP listener, stateless stdio proxy, endpoint routing, MCP leases/configuration, prompt routing, launch/resume/close, cron, reports, status, group orchestration. |
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
| `src/agents/runtime/` | Shared native execution | Capability composition, injected model/tool loop, tool registration/schema/host-grant checks, generic protocol helpers, durable request/command journals, namespaced snapshots, cancellation, and resource-aware scheduling. No coding/daemon/UI implementation imports in the core. |
| `src/agents/capabilities/` | Business capabilities | Coding, planning/interaction, skills, agent management/routing, discovery, memory, reports, independent tasks, groups, and scheduling. Business policy stays outside the shared core. |
| `src/agents/profiles/` | Agent combinations | Declarative coding, project main, and read-only global-router capability selections; host grants remain authoritative. |
| `src/code/` | Native `ucode` host | Native entry composition, coding tools, coding context/task state, session codecs/metadata/GC, skills, TUI, `UcodeController`, launcher helpers. Existing protocol/provider entries forward to shared implementations where extracted. |
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
agents/runtime/core -> generic protocol/context helpers and injected interfaces
agents/capabilities -> business packages
code -> agents/runtime + agents/capabilities + agents/providers
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
    ucode/
      journal/       # append-only native ucode conversation events
      sessions/      # metadata/projection checkpoints, not message truth
  daemon/
  run/
```

Global state lives under `~/.ufoo/`, including `~/.ufoo/config.json`, the
home-scoped global controller daemon state, and global project registry records
under `~/.ufoo/projects/runtime`.
`UFOO_PROJECT_RUNTIME_DIR` overrides the registry directory for isolated test
and diagnostic environments. Jest uses a temporary registry per test suite,
including child CLI processes, and removes it afterwards so tests cannot grow
the user's project registry.

Shared native provider requests and wire adapters live in
`src/agents/providers/nativeTransport.js` and `transports/`; configuration/URL
resolution lives in `src/agents/providers/runtimeConfig.js`. The controller's
upstream transport no longer imports the coding runner. Existing `ucode`
session paths and snapshot codecs remain compatible through namespaced storage
adapters. `createAgentRuntime().run()` supports the existing ucode host; hosts
with a runtime store also expose durable `submit`, `resume`, `cancel`, `snapshot`,
`events`, `wait`, and `close`. `agentHost.js` binds these to project IPC and the
chat/TUI. Main conversations and child tasks have separate scheduler budgets.
Directory leases are shared with native ucode; verified worktrees can run
independently. Accepted requests and paused interactions recover after restart;
a running round becomes interrupted and uncertain effects are never replayed.

New conversations default to the main runtime. Existing controller conversations
retain their recorded executor, and `/session new` starts a conversation with
current settings. Provider/model bindings survive restart; provider credentials
are resolved through their own adapters without borrowing MCP handles or an
unrelated ucode gateway key. Old controller history is read only as a bounded,
untrusted summary; old ucode files are not rewritten.

The project daemon delegates bus observation and report consumption to
`src/runtime/daemon/busBridge.js`. Native tool schemas live in
`src/code/tools/specs.js`; execution lives in `src/code/tools/executor.js`, and
`nativeRunner` keeps its existing exported builders.
CLI report transport/formatting lives in `src/app/cli/reportCoreCommands.js`.
Chat launch environment parsing lives in `src/app/chat/launchRequestContext.js`.

Project registry updates and pruning share per-record locks. Memory writes use
the shared expiring lock mechanism, including recovery of crash leftovers.

Shared file mutations use `src/coordination/state/fileLock.js`: only synchronous
local file work belongs inside a transaction. `agentsStore` tracks loaded
snapshot baselines so stale writers apply only their own changes; hot activity,
heartbeat and session writers use `updateAgentsData`. Do not write the registry
directly. Report controls acknowledge after successful persistence and reuse a
stable task ID across start/progress/done/error. Native receipts live in
`src/coordination/bus/nativeReceipts.js`; uncertain outcomes require explicit
operator resolution through `ufoo bus deliveries`, never automatic replay.

## Development Commands

```bash
npm install
npm run pack:tui
cargo test -p ufoo-tui
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

JavaScript is CommonJS and needs no transpilation. Node.js 18.17+ is required.
The Rust renderer does require a build: `npm run pack:tui` builds and stages the
current platform binary before source installs can open chat or ucode.

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

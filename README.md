# ufoo

[中文](README.zh-CN.md)

ufoo is a project-scoped multi-agent workspace runtime with two ways to work.
Keep using Claude Code, OpenAI Codex, and other supported CLIs through wrappers
and MCP for messages and shared context. Or open the ufoo dashboard to work with
a main agent and internal Codex, Claude, and `ucode` agents in one terminal.
Both share a daemon, event bus, memory, reports, and group orchestration.

Package: [u-foo on npm](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS-blue.svg)](https://www.apple.com/macos)

## Highlights

- One TUI dashboard for a main agent and internal child agents, with shared input,
  live output, status, and three layouts.
- One user-scoped daemon over `~/.ufoo/run/ufoo.sock`, hosting isolated project
  runtimes for launch/resume, reports, groups, cron, and controller routing.
- Project-local event bus for agent-to-agent messages, wakeups, queue checks,
  and activation.
- Shared context primitives: decisions, durable memory, prompt history, reports,
  and agent registry state.
- Wrappers and MCP keep external CLI workflows connected; dashboard child agents
  run internally without opening external terminals.
- Built-in group templates for launching and orchestrating multi-agent workflows.
- `ucode`, a native ufoo coding-agent runtime.
- One loopback Streamable HTTP MCP server inside the home-scoped global
  controller daemon, plus a disposable `ufoo mcp` stdio compatibility proxy.

## Requirements

- Node.js 18.17 or newer.
- macOS for Terminal.app/iTerm2 integration.
- Claude Code, Codex CLI, Antigravity CLI, Grok Build, or Kimi Code installed
  when using the matching wrappers: `uclaude`, `ucodex`, `uagy`, `ugrok`, or
  `ukimi`.

## Installation

Install the published package:

```bash
npm install -g u-foo
ufoo setup
```

`ufoo setup` lets you choose whether to install the optional **ufoo Browser**
component (`ufoo setup --browser=install` or `--browser=skip`). Non-interactive
installs skip optional browser components by default.

Or link this repository for local development:

```bash
git clone https://github.com/Icyoung/ufoo.git
cd ufoo
npm install
npm run pack:tui
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

`ucode` has no tool-call count limit by default. Set an optional per-run cap with
`ucode --max-tool-calls 200`, or `UFOO_UCODE_MAX_TOOL_CALLS=200 ucode`.
`ucode --max-tool-calls none` explicitly disables the cap, including an environment
override. The CLI option takes precedence. Limits count individual tool calls,
not model turns; timeouts and the tool-error budget still apply.
Consecutive identical tool batches trigger a model reminder, then stop the run
if repetition continues: read/plan-only batches warn at 4 steps and stop at 8;
other batches warn at 8 and stop at 12. Comparison uses tool names and arguments,
ignoring JSON key order and parallel call order. A different batch resets the
streak; this is not a semantic check of tool results or alternating loops.

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
loopback endpoint. Existing ufoo authentication fields and headers are retained.
Use `ufoo mcp configure codex --dry-run` to preview the change with credentials
redacted. Restart the Codex surface after configuring it.

For Cursor and any other host that has not been verified with direct HTTP,
keep the compatible stdio configuration:

```bash
ufoo mcp
```

This command is a stateless transport proxy into the same global server. It
accepts both newline-delimited JSON and standard `Content-Length` frames, and
answers in the framing that client used. Cursor can keep `command: ufoo` and
`args: ["mcp"]`. The proxy does not own Agent registrations or project state.
Inspect or restart the singleton listener with `ufoo mcp status` and
`ufoo mcp restart`.

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
  Current wrappers also provide `UFOO_AGENT_HANDLE` so the Agent can use the
  shared MCP `dispatch_message`, `ack_bus`, and `report_agent_status` tools.
  The CLI remains available when MCP is not configured. Receive, activity,
  and shutdown stay with the wrapper.
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

MCP sends confirm durable queue persistence, not delivery or task completion.
The result reports `delivery_status: "queued"`, `queued: <target count>`, and
`delivered: 0`. Registry reads return up to 100 existing project paths per page;
follow `next_offset` for more, or set `include_missing: true` for diagnostics.
To archive abandoned records for deleted workspaces, preview with
`ufoo project prune`, then run `ufoo project prune --apply`. Original JSON
records remain recoverable under `~/.ufoo/projects/archive/`.

The stdio proxy reconnects after listener restarts and preserves the Agent's
registration. It automatically replays reads; an uncertain write returns
`UFOO_MCP_OUTCOME_UNKNOWN` so its persisted result can be checked before retrying.
Run `ufoo doctor` to detect outdated Codex MCP configuration, and
`ufoo mcp configure codex` to refresh it with a backup.

Codex and Claude Code wrappers use native incoming-message transports by
default for interactive launches on macOS/Linux:

```bash
ucodex
uclaude
```

Codex connects its TUI to a private local app-server. ufoo observes the TUI's
exact thread response, preserves its requests and approvals, and sends bus
work through `thread/queue/add`. Claude uses a launch-local stdio MCP channel
and retains Claude's development-channel confirmation. Its startup probe must
arrive through the native channel before any bus work is sent. Channels are a
[Claude research preview](https://code.claude.com/docs/en/channels); account and
organization availability rules still apply. Existing MCP configuration and
credentials remain intact; these launches do not write global host settings.

Native receivers admit work while busy. A queue receipt confirms transport
acceptance, not task completion. Stable delivery IDs and project-local native
receipts prevent duplicate retries; uncertain writes retain the bus event for
inspection rather than falling back to keyboard injection. The wrapper still
owns terminal rendering, identity, activity, and shutdown. Use
`--no-native-messages` or `UFOO_NATIVE_MESSAGES=0` to select the existing delivery
path; `--native-messages` explicitly overrides that environment setting.
Headless commands such as `ucodex exec` and `uclaude --print`, help/version,
internal agents, and other providers keep their existing launch behavior.
Launchers check CLI versions against the tested baselines (Codex 0.160.1 and
Claude Code 2.1.204), and check Codex remote support. Older CLIs use legacy
delivery with a diagnostic; explicit `--native-messages` requires compatibility.
`ufoo doctor` shows versions, receiver readiness, and uncertain receipts.

Inspect or explicitly resolve an uncertain receipt:

```bash
ufoo bus deliveries <subscriber>
ufoo bus deliveries <subscriber> <receipt-id> accepted
ufoo bus deliveries <subscriber> <receipt-id> retry
```

Use `accepted` after verifying the receiving session got the work. `retry`
allows another submission and can duplicate work if the first submission
succeeded. A live in-flight submission cannot be resolved.

Codex resume pickers and `resume --last` bind the exact session returned by the
TUI after selection.

The integration tests use real Unix sockets, WebSockets, and stdio MCP. Optional
vendor CLI smoke tests use isolated homes and a fake local model endpoint:
`node scripts/smoke-native-messages.js codex` and
`node scripts/smoke-native-messages.js claude`. Verified locally with Codex
0.160.1 and Claude Code 2.1.204.

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

The project main agent shares a composable runtime with `ucode`. It can read and
edit code, run validation, delegate to internal agents, or start independent
tasks. The global profile selects projects before coding begins. Long tasks run
in the daemon; disconnecting chat does not cancel them, and reconnecting replays
runtime events.

All main conversations use the shared runtime. Use `/session new` to start a
conversation with current settings; existing provider/model bindings stay pinned.
A crash during an active round marks it interrupted: inspect actual
effects before resubmitting. Writes, shell commands, launches, and uncertain
deliveries are not automatically replayed. Managed writers share directory
leases; verified git worktrees can run independently. These checks are not an OS
sandbox for shell commands. See the [runtime implementation record](docs/archive/AGENT_RUNTIME_REFACTOR.md).

### Chat Commands

```text
/launch codex reviewer
/launch claude builder
/launch grok explorer
/launch ucode fixer
@reviewer inspect the current diff and list release risks

/status
/task list
/task inspect <run-id>
/task cancel <run-id>
/answer <interaction-id> <reply>
/session show
/session new
/settings
/window main
/window side
/window multi
/resume
/project list
/project switch 2
/open /path/to/project
```

The dashboard keeps three layouts: `main` (main agent only), `side` (main plus
one selected internal agent), and `multi` (main plus all internal agents). Active
wrapper and MCP agents appear in the communication directory and `@` completion;
selecting one targets messages without opening a pane. Their detailed output
and process lifecycle stay with their own host. Dashboard child launches use internal mode and never
open an external terminal. A project with no chat or input history shows the
existing compact ufoo banner as its welcome screen.
`Ctrl+W` cycles `main → side → multi → main`.
`/window main`, `/window side` and `/window multi`
select each layout directly. The one-child layout selects the most recently
activated live internal agent, or the first agent when none has been activated.
With no children, split modes remain selected while showing only the full-width
main pane; new children appear automatically when they become available.
When an internal child owns the shared input, editing keys and shortcuts belong
to that child. `Ctrl+C` cancels only its current task, preserving its draft,
process and queued messages. `Esc` returns focus to the main input without
cancelling work; popup menus close before returning focus. `Ctrl+W` edits the
child's previous word and `Tab` inserts indentation. From the main input,
`Ctrl+W` cycles layouts and `Ctrl+Q` closes the split; main-only `Ctrl+C` clears
a nonempty draft before cancelling or exiting. `Esc` at the ufoo root preserves
the application and draft.
Standalone `ucode` uses the same side-pane implementation: clicking a footer
agent selects an `@` message target, and clicking it again opens an internal
agent on the right. Repeated selection of an external agent stays message-only.
Keyboard selection followed by empty Enter uses the same internal activation.
With focus on the Agents footer, `Ctrl+X` closes the selected internal agent
through its project daemon in both ufoo and ucode. External agents cannot be
closed from this menu. This differs from `Ctrl+C` in a child's input, which
cancels its current task while keeping the worker alive.
Restart existing internal workers to enable the per-task cancellation channel.
Drag over visible text in the main or an internal agent pane to select it;
releasing the mouse copies it to the clipboard. Selection stays within that pane,
excluding its border and adjacent agents. Local macOS uses the system clipboard;
other terminals use OSC 52 and require terminal clipboard support.
`/resume` opens a second-level menu of recoverable internal sessions. Independent
agents appear individually; group members appear together as `group:<group-id>`.
Selecting a group resumes its inactive members with saved sessions, skips members
that are already active, and updates the group's member identities. Native
coding agents register as `agent_type: ucode` with `ucode:<session>` identities;
their saved conversations remain under `.ufoo/agent/ucode/`.
From main in a split layout, `Tab` enters a visible child. Once activated, only
`Esc` leaves its input. All agents share one bottom input, which follows the selected agent while
preserving each draft. Each agent's live status sits in its pane's bottom border;
the main agent's input is labelled `main`, and its status stays independent of
child selection, focus changes and child activity.
Internal Codex defaults to full host access without approval prompts, including
local services such as ADB and Gradle. Peer replies contain the final answer;
progress and tool output stay visible in the agent's pane. Reports and handoffs
default to 1-4 short lines with checks and blockers; longer evidence is saved in
a referenced workspace file.
The selected pane's body uses the terminal's default foreground. In the main-only
layout, `Tab` selects the first agent in the bottom bar, then advances through
the agents and wraps to the first. `Esc` returns to
the main input. Command completion keeps its existing `Tab` behavior in the
main-only layout. An open completion menu also owns `Tab` in split layouts.
Layout commands also work from an internal child's input. Switching layouts
keeps unsent child drafts and does not stop running agents.
With a child active, a footer click opens the Agents selector in ufoo;
`Down` remains an editing key in the child input. In the footer selector,
`Down` advances to provider settings and cron controls; `Esc` returns to
the same agent's input. In the selector, `Enter` opens the selected internal
agent. The provider caption in the footer also opens its settings directly.

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

External HTTP agents can register a wake endpoint, including `grok-bot`:

```bash
ufoo bus join my-session grok-bot --wake-url https://agent.example/wake --wake-key-file /path/to/wake-key
```

The `bearer-json` adapter sends a bearer-authenticated JSON request containing
`project_root`, `subscriber`, `seq`, `publisher`, and `message`. The endpoint
must return HTTP 200 after accepting the work. The receiver acknowledges its
queue with `ufoo bus ack <subscriber> --through <seq>` after handling it; later
messages wait for that acknowledgement. Failed requests remain queued for retry.
Requests have a ten-second deadline and do not follow redirects. HTTPS is
required except for loopback HTTP. Endpoint keys stay in a mode-600 local file.
Wake registrations have no local PID or terminal ownership.

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

For a new external registration, ufoo assigns both the subscriber's
eight-character session suffix and its automatic `<agent-prefix>-<number>`
nickname on the server, using the same identity generators as wrapper launches.
A Cursor MCP registration with `agent_type: "cursor"`, for example, receives
`cursor:<8-hex>` and `cursor-N`; the model selected inside Cursor does not
replace the Cursor Agent type.
A stable `client_instance_id` recovers that same identity after a transport
restart; even when that value is a UUID, it is not used as the subscriber
suffix. Legacy MCP subscribers whose suffix is the client UUID are superseded
by the short server-assigned identity on their next registration. MCP Agents
cannot self-assign or update these identity fields; an explicit operator rename
remains available through the controller/CLI rename path.

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

The poll skill is opt-in. Postinstall refreshes only verified ufoo-owned links;
user directories, files, and foreign links are preserved. `skills install all`
refreshes an already-installed optional skill with a backup, but does not
install it for a new host. Explicit skill installs retain previous contents in
a sibling `.backup-*` path.
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

ufoo trace <task-id> --json
ufoo trace --agent <id-or-nickname> --follow
ufoo trace --details --limit 2000
```

Use decisions only for plan-level constraints. Durable project facts belong in
memory.

`trace` links parent/worker model and tool events, reports, queue claims and
context compression without starting a daemon or calling a model. MCP exposes
the same read-only view as `read_agent_trace`. Parameters and results are
redacted; bounded or incomplete source reads are explicitly marked in JSON.

`ufoo metrics --json` summarizes observed outcomes, latency, tokens, tool
errors/repetition, report size and delegation acceptance. Save a report and use
`ufoo metrics --baseline baseline.json --json` to compare later samples. MCP
provides `read_agent_metrics`; metric definitions and an optimization workflow
are in [OBSERVABILITY.md](docs/OBSERVABILITY.md). Missing evidence stays unknown,
and execution completion is separate from acceptance.

### Groups

Built-in group templates live in `templates/groups/`.

Every member in all seven built-in groups includes three provider defaults plus a
manual override in `model_config`:

| Role | Codex model / reasoning effort | Claude model | agy model |
|---|---|---|---|
| Architect | `gpt-6-astra` / `high` | `claude-fable-5-2` | `gemini-4-carbon-high` |
| Builder | `gpt-6.1-sol` / `high` | `claude-opus-5-5` | `gemini-4-hydrogen-high` |
| Reviewer | `gpt-6.1-sol` / `xhigh` | `claude-opus-5-5` | `gemini-4-argon-high` |
| Design consultant, discovery facilitator, debugger | `gpt-6-astra` / `high` | `claude-fable-5-2` | `gemini-4-carbon-high` |
| PMO | `gpt-6-astra` / `high` | `claude-fable-5-2` | `gemini-4-argon-high` |
| Frontend refiner | `gpt-6.1-sol` / `high` | `claude-opus-5-5` | `gemini-4-hydrogen-high` |
| Scope challenger, UI plan critic, design critic, release coordinator | `gpt-6.1-sol` / `xhigh` | `claude-opus-5-5` | `gemini-4-argon-high` |
| QA | `gpt-6.1-sol` / `xhigh` | `claude-opus-5-5` | `gemini-4-hydrogen-high` |

Settings follow each member's prompt-profile role, including numbered builders.
Claude reasoning effort is left unset. All 24 built-in members have an empty
manual override ready to customize.
agy's selected model IDs include the thinking tier, so their separate
`reasoning_effort` defaults are empty. Carbon is reserved for architectural and
root-cause work, Argon for coordination and critical review, and Hydrogen for
implementation and verification.

For example, an architect member contains:

```json
"model_config": {
  "codex": { "model": "gpt-6-astra", "reasoning_effort": "high" },
  "claude": { "model": "claude-fable-5-2", "reasoning_effort": "" },
  "agy": { "model": "gemini-4-carbon-high", "reasoning_effort": "" },
  "override": { "model": "", "reasoning_effort": "" }
}
```

A nonempty `override.model` replaces the entire selected provider configuration;
an empty override effort does not inherit effort from any provider default.
Otherwise the member's provider selects `codex`, `claude` or `agy`. Empty model
settings keep the existing project/provider defaults. Overrides select a model,
not a different provider. Internal auto members under the agy provider run as
native ucode workers with explicit agy provider/model settings; external agy
members use the CLI's `--model` and optional `--effort` flags. Other native
provider settings remain unchanged when no matching model setting exists. Explicit
`type: "ucode"` members select defaults using their effective native provider
(`UFOO_UCODE_PROVIDER`, global `ucodeProvider`, then project `agentProvider`).
Codex maps to `codex`, Anthropic to `claude`, and agy to `agy`; manual overrides
also work with other native providers. Model, provider and effort are carried
through launch and resume. Project/global custom templates remain
authoritative over built-ins.
Dry runs and group state expose the selected model, effort and source. Recovery
preserves the saved selection; edits affect newly launched groups, not live workers.

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

Internal Codex, Claude Code and ucode panes share the standalone ucode TUI's
transcript renderer and one bottom multiline input. Submitting immediately shows
loading; waiting, thinking, generating, tool execution, user interaction, errors,
elapsed time, context usage and plans follow the selected agent's actual events.
Provider-specific retry, compaction and background task events use the same status
surface. Text, thinking and tool
results update from provider events; Ctrl+O expands the newest thinking/tool
block in the focused pane. Display observations are separate from agent inboxes,
so peer-routed tasks remain visible without waking the main agent. Output and
drafts survive switching between main-only, focused-child and all-child layouts.

### Native ucode Runtime

```bash
ufoo ucode doctor
ufoo ucode prepare
ufoo ucode build
```

`ucode` can discover built-in and local `SKILL.md` workflow capabilities. Full
skill bodies are loaded only when explicitly referenced.

### Background Command Notifications

Native ufoo and ucode can continue automatically when a background command exits
or a condition is met. For example, the agent can start a development server with:

```json
{
  "command": "npm run dev",
  "background": true,
  "wake": {
    "conditions": [{ "type": "log_contains", "text": "ready" }]
  }
}
```

Supported conditions are `log_contains` (literal `text`), `file_exists`
(workspace `path`), and `port_open` (a `port` on `127.0.0.1`). Each fires once;
exit notification is enabled by default and can be disabled with
`wake.onExit: false`. `wake.timeoutMs` bounds the subscription (default and
maximum 12 hours). Expiry sends one notification without stopping the command.

The host watches without model polling. Notifications continue the same session
after its current turn and any pending user question. Stopping the command or
cancelling its task revokes its watches. Pending watches survive host restart;
ucode must reopen the original session to resume delivery. Interrupted wake
invocations with uncertain effects are not automatically replayed. Inspect
`bash` with `action: "status"` and its `backgroundId` for delivery status.
One-shot command-line runs without a resident host do not provide auto-wake.

### Your Everyday Chrome

The native project main agent, writable native child tasks, and `ucode` have a
shared `browser` tool powered by Playwright. It connects to an existing browser
and preserves its signed-in sessions; it never falls back to launching a fresh
profile. SDK-managed Codex/Claude wrappers keep their own tool configuration.

Browser automation requires Node.js 20 or newer (the ufoo core still supports
Node.js 18.17+).

ufoo Browser is an optional user-level component managed outside individual
projects (`~/.ufoo/browser/` and `~/.ufoo/config.json`):

```bash
ufoo setup --browser=install   # or interactive `ufoo setup`
ufoo browser status --json
ufoo browser doctor
ufoo browser enable | disable
ufoo browser update
ufoo browser uninstall
```

During developer preview (before the Chrome Web Store listing is published),
register developer mode and load the unpacked extension from
`extensions/ufoo-browser/`:

```bash
ufoo browser install --dev
```

Once installed and enabled, the extension connects automatically via Chrome
Native Messaging to the user-scoped broker (`ufoo` and `ucode` share one
broker). Agents list tabs with `browser_tabs` (`action=list`) and claim tabs by
`tabId`; a tab already in use by another agent returns `browser_tab_busy`
without preemption. You can release individual tabs or pause all control from
the extension popup at any time.

Compatibility modes remain supported: set `backend: "playwright-extension"`
(with `UFOO_BROWSER_PROFILE` if needed) for the official
[Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm),
or use Chrome 144+ remote debugging (`chrome://inspect/#remote-debugging`):

```bash
UFOO_BROWSER_CDP_ENDPOINT=chrome ucode
```

You can also supply an existing `http://127.0.0.1:9222` or WebSocket endpoint.
An already-running daily Chrome does not automatically expose that port.
For the project main agent, set this environment variable when starting the
ufoo daemon; an existing daemon must be restarted to pick up changed settings.
CDP mode grants one ufoo/ucode session exclusive control until it disconnects,
because multiple clients would otherwise manipulate the same tabs. Other
applications and manual browser use are not covered by this lease.

The agent can list/select tabs, navigate, inspect snapshots, click/type, fill
forms, upload workspace files, handle dialogs, and take screenshots. Tool
operations also include screenshot-guided mouse clicks, dragging and scrolling
for canvas-based pages. Plan mode allows inspection only; browser actions run
through the direct capability, not synchronous `plan_graph` tool nodes. Tool
schemas are discovered on demand behind one stable model-facing tool. Page
content is data, not instructions; external actions stay within the user's
authorized task. Screenshot images are delivered to the model and saved under
`.ufoo/browser/`; long results include an `outputPath` for further reading.

`browser` supports `status`, `connect`, `tools`, `call`, and `disconnect`.
`tools` with a `tool` name returns its argument schema. A lost connection or
an action with an unknown outcome requires explicit reconnection and inspection,
not an automatic repeated click. Idle connections disconnect after ten minutes.
Disconnect releases control without closing Chrome or its existing tabs.

Browser setup instructions: [Playwright existing-browser connections](https://playwright.dev/mcp/configuration/browser-extension).
Developers can run the optional real-Chrome fixture with
`UFOO_TEST_BROWSER=1 npm test -- --runTestsByPath test/integration/browser-existing-chrome.test.js`;
it uses a disposable profile and a local test page, never the user's profile.

## Configuration

Project configuration is stored in `.ufoo/config.json`. `ucode` provider
credentials are stored globally in `~/.ufoo/config.json` and merged at load time.

Common project settings:

```json
{
  "launchMode": "auto",
  "agentProvider": "codex-cli",
  "codexAuthPath": "",
  "codexOauthRefreshWindowSec": 300,
  "claudeOauthProfile": "",
  "claudeOauthTokenPath": "",
  "claudeOauthRefreshWindowSec": 300,
  "agentModel": "",
  "autoResume": false
}
```

Internal Codex and Claude always use their SDKs; there is no thread-mode setting.
Internal Codex currently defaults to full host access (`danger-full-access`),
network enabled, and no approval prompts (`approvalPolicy: never`). It can access
simulators, system services and build caches outside the project with the current
OS user's permissions. Granular permissions and approval controls are deferred;
explicit SDK thread options still override these defaults. Relaunch existing
internal Codex workers after updating to apply the new policy.

Supported `launchMode` values: `auto`, `internal`, `tmux`, `terminal`, and
`host`. Dashboard panes and process management support internal Codex, Claude and ucode workers; provider selections remain independent. The `@` directory and main-agent communication also include active external agents. External agents receive messages through their own host and can return replies/reports, without exposing their terminal or detailed output in ufoo.

The dashboard always uses internal children and has no `/mode` command;
the binary has no `ufoo mode` command either.
Manual `ucodex` and `uclaude` wrappers detect tmux, host sessions, Terminal.app
and iTerm2 from their environment, then register the actual terminal type, TTY
and delivery channels with the daemon. Their event-bus communication works
without a dashboard. MCP agents communicate through MCP message interfaces
without requiring a terminal adapter.
With the project daemon running, a registered worker can initiate contact with
`ufoo-agent` using `dispatch_message` or `ufoo bus send ufoo-agent "<message>"`
from its project and inherited worker identity. No prior delegation or open
chat window is required: the daemon durably accepts the message and wakes the
main runtime. Use this for substantive results, questions or changed blockers;
assigned task completion still requires a lifecycle report with its task ID.
The main agent uses one runtime for coding and routing, configured by
`agentProvider` and `agentModel`. `/settings agent` manages these settings;
`/settings ucode` manages the independent ucode gateway settings.

The bottom Settings bar includes `custom`, `model`, and `thinking`. Select
`custom` to enter an API URL and hidden API key, then choose its model and
thinking intensity. `/settings agent custom`, `/settings agent model`, and
`/settings agent thinking` open the same controls. Model menus fetch the current
provider's complete selectable catalog, including paginated results; Codex
menus omit entries marked hidden by the provider. Endpoints without a
models route also allow a manually entered model ID. Changing model or thinking
applies to the next request and keeps the current conversation. Changing provider
starts a new conversation, retaining the old one in runtime storage.
OpenAI thinking choices include separate `xhigh` and `max` values, preserved in
requests. When a provider uses a configured gateway, the model list comes from
that gateway; upgrading an agent SDK does not change the gateway's catalog.

Custom main-agent settings use `agentProvider: "custom"`, `agentBaseUrl`,
`agentApiKey`, `agentModel`, and `agentThinking` in `.ufoo/config.json`.
Custom APIs use OpenAI Chat Completions by default, or Responses when the URL
ends in `/responses`. There is no Anthropic protocol selector for custom APIs.
Internal Claude retains its native provider transport and credentials.

#### Antigravity

Select `/provider agy` for the main agent, or run `ucode --provider agy` for
standalone coding. The default model is `gemini-4-carbon-high` and the
default auxiliary model is `gemini-4-hydrogen-high`. The native provider uses
the Antigravity Cloud Code API for streaming, tool calls, and
the `/model` catalog. Select a text model available to your account with
`/model`. If a session was created with the earlier `agy` setting, start a
fresh session to bind the Antigravity transport.

Sign in with `agy` once. ufoo reuses the local Antigravity login from the
macOS Keychain, Linux Secret Service, or the CLI's fallback auth file. macOS
may ask for permission to read the existing Keychain item. ufoo discovers
the Cloud Code project and asks `agy` to renew an expiring login.

To choose credentials explicitly, set `UFOO_AGY_AUTH_PATH` to your Antigravity
auth JSON from CLIProxyAPI, or set `UFOO_AGY_ACCESS_TOKEN`. Set
`UFOO_AGY_PROJECT_ID` to override project discovery. For the main agent, these
variables must be available to the ufoo daemon when it starts.
`UFOO_AGY_BASE_URL` overrides the Cloud Code base URL. `UFOO_AGY_USER_AGENT`
overrides the Antigravity client header if the endpoint requires a newer version.

Ordinary provider sessions authenticate through their provider-owned adapters;
MCP `agent_handle` is never model authentication. Standalone and internal ucode
use the independent gateway settings below.

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
  agents/         shared runtime, capabilities, profiles, providers, launchers, prompts
  code/           native ucode host, launcher, skills, file/shell tools
  tools/          shared controller/worker tool registry and handlers
  online/         relay client/server/runner/token helpers
```

See [PROJECT.md](docs/PROJECT.md) for the maintainer-facing map and detailed package
ownership.

Reports share one task ID across lifecycle phases. Pass `--task <id>` to
`ufoo report`, or `task_id` to MCP `report_agent_status`. Without an explicit ID,
CLI progress/done/error attach to the agent's single active task; multiple
active tasks require an ID. Reports are acknowledged after persistence, and
ordinary bus replies do not imply task completion. `autoResume` defaults to
`false` consistently before and after partial configuration updates.

## Development

```bash
npm install
npm run pack:tui
npm link
node bin/ufoo.js --help
npm test
```

Useful checks:

```bash
npm run test:watch
npm run test:coverage
```

The repository is CommonJS, targets Node.js 18.17+, and ships a Rust TTY UI
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

# ufoo Project Guide

This file is the maintainer-facing map for the ufoo repository. The public
user guide lives in [README.md](../README.md).

## Purpose

ufoo is a multi-agent workspace runtime. One user-scoped global daemon hosts
isolated project runtimes for chat dashboards, event buses, memory/context,
reports, group orchestration, terminal launch, and tool routing across Claude
Code, Codex, Antigravity, Grok Build, Kimi Code, and native `ucode` agents.

The core design rule is simple: chat is a client, the daemon owns runtime state,
and agents coordinate through `.ufoo/` state plus bus/tool contracts.

## Entry Points

The optional installation and automatic connection flow for the
ufoo-owned Chrome extension is documented in
[BROWSER_EXTENSION_PLAN.md](archive/BROWSER_EXTENSION_PLAN.md). Users choose whether to
install `ufoo Browser` via `ufoo setup` (or `ufoo browser install`) into
`~/.ufoo/browser/`, and connect via Chrome Native Messaging (`com.ufoo.browser`)
and the user-scoped broker (`~/.ufoo/browser/private/broker.sock`), while
retaining official extension and explicit CDP compatibility paths.

Published binaries are defined in `package.json`.

| Binary | Main file | Responsibility |
|---|---|---|
| `ufoo` | `bin/ufoo.js` | Main CLI, chat dashboard, Desktop App launcher, ACP Server (`ufoo acp`), daemons, global MCP server/proxy, project commands, bus/context/memory/report/group/online commands. |
| `ucode` | `bin/ucode.js` | Native ufoo coding-agent CLI/TUI and standalone ACP Server (`ucode --acp`). |

### v5 Three-Layer Agent Interop (SDK + ACP + MCP)

PTY CLI wrappers (`uclaude`, `ucodex`, `uagy`, `ugrok`, `ukimi`) and `node-pty` have been removed. Agent interoperability now follows a clean three-layer contract:

- **Native SDK Workers**: Claude Agent SDK (`src/agents/providers/claudeThreadProvider.js`) and Codex SDK (`src/agents/providers/codexThreadProvider.js`), plus bundled native `ucode` (`src/code/internalThread.js`).
- **Bidirectional ACP Layer**:
  - **ACP Client** (`src/agents/providers/acpRegistry.js`, `acpThreadProvider.js`, `acpEventTranslator.js`, `src/agents/acp/jsonRpcStdio.js`): connects any ACP-compliant CLI (`gemini`, `opencode`, `kimi`, `goose`, `grok`, or custom `acpAgents`) as a first-class managed worker with unified permission gating and automatic `ufoo` MCP injection.
  - **ACP Server** (`src/agents/acp/acpServer.js`, exposed via `ufoo acp` and `ucode --acp`): lets external ACP hosts (Zed, JetBrains, Neovim, T3 Code) drive `ufoo` directly.
- **Focused MCP Cooperation Layer** (`src/runtime/daemon/workerMcpInjection.js`, `mcpHttpServer.js`, `mcpServer.js`): auto-injected into managed SDK/ACP workers with external polling/lifecycle tools hidden (`register_agent`, `poll_inbox`, `wait_for_message`, `ack_bus`, `unregister_agent`), while external native CLIs connect via Skill + MCP without wrappers.
- **Shared Workspace & Model-Managed Worktrees** (`src/code/tools/common.js`, `src/runtime/worktree/worktreeManager.js`): framework-level automatic worktree isolation and agent-to-worktree binding are disabled by default so agents and groups share live code directly. Models decide on demand whether to create git worktrees, and `resolveWorkspacePath` allows free cross-worktree read/write access across all registered git worktrees of the same repository while still rejecting paths outside the repo.

Grok/xAI provider work beyond the CLI wrapper is tracked in
[GROK_PROVIDER_V2.md](archive/GROK_PROVIDER_V2.md).

The layered, pluggable runtime migration is documented in
[AGENT_RUNTIME_REFACTOR.md](archive/AGENT_RUNTIME_REFACTOR.md). Native `ucode` uses the
shared capability-composed loop alongside the project main agent. The project
main agent can code, delegate tasks to workers,
and use group/cron services; the global profile only selects projects. The
document records implemented APIs and conservative recovery boundaries.

The main agent and native `ucode` share execution
budgets from `src/agents/runtime/core/executionBudget.js`. Model rounds and tool
calls are unlimited by default, with a 12-hour task deadline. Recoverable tool
errors warn at 3 consecutive failures and stop at 5, or at 12 failures in the
last 20 calls. Successful calls reset the streak but retain the rolling window.
All tool rejection paths share these checks. After a failure stop, remaining
calls in the batch receive explicit non-execution results, and at most one
tool-free model turn may explain the blocker; it cannot restart execution. `UFOO_UCODE_MAX_TOOL_CALLS`, `UFOO_UCODE_MAX_TOOL_ERRORS` and
`UFOO_UCODE_TASK_TIMEOUT_MS` configure those shared limits (the error setting now controls consecutive failures;
the 12-of-20 window remains active); standalone ucode's
explicit CLI options take precedence.
Decomposed coding tasks inherit that same timeout and share one deadline across
all steps; each step receives only the remaining time, including context setup.
Native provider HTTP connections allow ten minutes to establish instead of
Undici's implicit ten seconds. Task deadlines and explicit cancellation still
bound requests; SSE headers/body idle timeouts remain disabled.
Transient connection failures and HTTP 408/429/500/502/503/504/529 retry up to
three times with exponential backoff and bounded `Retry-After`, within the
original request deadline. Retries stop once a protocol event has been consumed,
so partial streams and completed tools are never replayed by this transport.
Native inference and `/model` discovery share refreshed credential resolution,
including the Codex subscription token and account header.

The main agent and standalone/internal ucode expose the
shared `browser` capability (`src/agents/capabilities/browser/`). Its fixed tool
schema discovers the pinned Playwright MCP tools on demand through
`src/runtime/browser/playwrightSession.js`; no external tool schemas or live tab
state are injected into the system prefix. The adapter requires `browser.control`
and is excluded from read-only children and the global router. When `browser`
is disabled or not installed, `status` reports setup state and non-status
operations return `browser_disabled`/`not_installed` without loading optional
dependencies. Optional runtime components live in `~/.ufoo/browser/runtime/` and
are managed by `src/runtime/browser/` (`componentInstaller.js`, `nativeHost.js`,
`broker.js`). In `ufoo-extension` mode, each session connects over a
token-authenticated per-session CDP relay (`/cdp/<sessionId>`) managed by the
user-scoped `BrowserBroker`, with per-tab ownership (`browser_tab_busy` on
contention); explicit `UFOO_BROWSER_CDP_ENDPOINT` retains a per-OS-user
exclusive lease and `playwright-extension` compatibility remains available.
Neither mode may fall back to launching Chrome. Disconnect/idle expiry disposes
the client without closing the user's browser; runtime disposal releases any
touched connections. Large text and screenshot artifacts live in
`.ufoo/browser/<session-hash>/`; screenshots use the shared provider vision
result shape. Unknown action outcomes are returned explicitly and are never
automatically replayed. Plan mode permits inspection only. A paused runtime may
add this stateless capability without changing or replaying its existing pending
work.

The main agent and standalone/internal ucode also expose
the shared `mac-app` capability (`src/agents/capabilities/mac/`, tool `mac_app`,
permission `mac.control`), excluded from read-only children and the global
router. On macOS it compiles and caches a self-contained Swift helper
(`src/runtime/mac/native/ufoo_mac_helper.swift` -> `~/.ufoo/mac/bin/`) served
over a private Unix domain socket (`~/.ufoo/mac/private/helper.sock`). It
combines structured Accessibility (`AXUIElement`) snapshots (`@e1..@eN` element
refs + `ax_action`), shadowless window/region/display screenshots scaled to 1:1
logical points (`screenshotId` coordinate mapping, `.ufoo/mac/<session-hash>/`),
and window-targeted `NSEvent`/`CGEvent.postToPid` input with a non-capturable
(`sharingType = .none`) Agent Mouse HUD (`AgentHudController`). Each session
tracks its own pointer; no input is posted to the global HID stream and no
physical cursor warp is performed. Cross-process hit-testing uses the dynamically
resolved `CGEventSetWindowLocation` macOS SPI to stamp window-local coordinates;
if unavailable, operations fail with `independent_input_unavailable` rather than
switching to the physical mouse. Explicit refs/window IDs are preserved for
move, click, drag, scroll and keyboard operations; unqualified screen coordinates
hit-test a window. Window activation requires explicit `focusApp=true`.
Ordinary user movement remains independent; deliberate mouse shake, a physical
click inside the target window, or `Esc` causes `user_takeover`. The OS-user
input lease serializes agents. Background event posting is not an acknowledgment
that the application acted; verify results. Cross-window dragging is rejected.
The opt-in `UFOO_TEST_MAC_POINTER=1` integration test sends input only to a
disposable AppKit window and checks event delivery, physical cursor displacement,
and foreground ownership.
`ufoo mac` (`src/app/cli/macCommands.js`) provides `status`, `doctor`,
`permissions`, `enable`, `disable`, `hud`, and `stop`. Non-macOS hosts report
`unsupported_platform` without spawning helper processes.

The main agent and native/internal `ucode` share Context Engine V2 in
`src/agents/runtime/context/` (`turnIndexStore`, `turnAnalyzer`, `topicSelector`,
and `slidingWindowManager`). Each settled turn writes an append-only Phase A
deterministic turn record to `.ufoo/agent/<namespace>/context/<sessionId>.turns.jsonl`
(plus projection state in `<sessionId>.window.json`); when `agentAuxModel` or
`ucodeAuxModel` is configured, an optional bounded Phase B background enricher
refines turn summaries without blocking the foreground loop, and Tier 2 topic
selection activates only for ambiguous off-window queries (both make zero extra
model calls when unconfigured). Before each model call, `slidingWindowManager`
keeps a Step=2 aligned raw turn window (default 5 turns, expanding up to 10 on
hot topics within a 45% history cap, excluding `system_wake` turns from the user
turn quota) so the System prefix and older raw turns remain KV-cache stable,
while injecting a compact, per-turn cached ephemeral `<turn_context>` block
(`<topic_map>` + `<relevant_turns>`)
onto the current turn's user message only; this wrapper is stripped before
indexing, persisting to journals, or counting against history. Overflow or
tight budgets use a deterministic Level 1–3 eviction ladder instead of inline
tool-less LLM summarization calls, and the `turn-recall` capability
(`src/agents/capabilities/turnRecall/`, `recall_turn`) lets `main` and `ucode`
search off-window turns or paginate full raw transcripts on demand.
Emergency eviction refreshes summaries against the retained window and pins
that projection, including tool-result truncation limits, for subsequent calls
in the same logical turn. Further budget pressure may shrink it again; ordinary
tool rounds do not restore evicted content and rewrite the prefix. Latest tool
results are truncated only when necessary, and irreducible oversized inputs
stop before the provider call while retaining the original transcript.
`UFOO_CONTEXT_LIMIT_TOKENS` overrides model context estimates, while Codex/Claude
SDK worker sessions retain their SDK-managed context behavior.

Native ucode commits each complete model/tool batch through the shared loop's
awaited `onConversationUpdate` port before requesting another model turn.
Incremental and final journal writes share turn/scope idempotency keys. Provider
failure, cancellation and tool-budget errors retain completed conversation units;
an interrupted tool batch retains its ledger without inventing tool results.
Plan Graph commands reject misspelled `arguments` fields and missing required
tool parameters before execution; failed-node inspection includes errors and
recovery guidance.

Native background command notifications use the shared durable hook inbox in
`src/agents/runtime/tasks/hooks.js`. Host-injected sources own detection; the
core owns one-shot subscriptions, deduplication, cancellation and delivery state.
The coding adapter observes process exit, literal log matches, workspace file
existence and IPv4 loopback port readiness. Bash defaults to exit notification
on supported hosts, with optional `wake.conditions` and a bounded lifetime.
Polling never invokes the model. Main/coding-child runtimes submit idempotent
wake requests; standalone TUI/readline and internal ucode keep a host-owned
inbox across per-turn executors via `src/code/runtime/backgroundWakeHost.js`.
Delivery waits for a turn boundary and pending user interaction to finish.
User cancellation revokes subscriptions; a stopped host preserves them for
session recovery. A claimed non-durable invocation interrupted by a crash is
marked uncertain and never automatically replayed. `bash action=status` exposes
notification delivery states. Active or pending hooks prevent project suspension.
The detached `src/code/tools/backgroundProcess.js` supervisor records exit
outcomes even when its original host has exited. Notifications do not replay
commands, kill processes on watch expiry, or launch a closed ucode application.

Agent execution is observable through `ufoo trace [task-id] --json`,
`ufoo trace --agent <id-or-nickname> --follow`, the read-only MCP tool
`read_agent_trace`, and the `agent_runtime` IPC `trace` operation. The history
reader in `src/coordination/history/agentTrace.js` combines main/control/native
runtime journals, SDK worker surface events, reports and live queue claims.
Task, run, request, attempt, session, parent and tool-call IDs follow a delegated
message through the runner. Model events record timing, provider/model,
usage and provider-exposed thinking summaries; context events record topic
selection latency/tier, sliding-window projection/eviction levels, and turn indexing. The query includes tool pairing and
error counts. SDK lifecycle events are labelled `sdk-turn` and counted separately
from direct API calls; SDK-internal requests are not inferred. Default output is
concise; `--details` includes redacted arguments
and results. Explicit `--offset` pages from the oldest retained event; otherwise
the latest page is returned. Reads are bounded to 200 runtime journals, 14 bus
days, 2 MiB per file and 32 MiB total; truncation, unavailable sources and torn
records are reported in `warnings`/`incomplete`, never treated as complete
evidence. Observation neither acknowledges delivery nor accepts a task.

`ufoo metrics [task-id] --json` and read-only MCP `read_agent_metrics` derive
performance summaries from those same sources. They report execution outcomes,
latency/first output, model and tool usage, retries/repetition, context selection/projection,
report size and delegation acceptance, with coverage for missing evidence.
`--since`/`--until` select run starts without clipping their observed lifecycles;
`--baseline <metrics.json>` compares saved samples. New runs record hashed
prompt/tool/engine configuration and request kind for provider/model cohorts.
API calls and SDK turns remain separate, and execution completion never implies
acceptance. See [OBSERVABILITY.md](OBSERVABILITY.md) for metric definitions,
privacy boundaries and a repeatable optimization workflow.

New delegation omits `target`; an existing target must resolve to a live worker.
Responses tools explicitly use `strict: false` unless their schema opts into
strict mode, preserving optional fields. Correctable delegation/acceptance
errors return tool results, while unknown side effects retain their uncertain
receipts. Runners emit private framework start/error reports for assigned tasks
even if provider initialization or execution fails. Worker done reports still
require independent evidence and explicit acceptance by the parent.

## Runtime Shape

```text
ufoo / ufoo chat
  -> src/app/chat + src/ui/rustChatHost + crates/ufoo-tui
  -> global daemon over ~/.ufoo/run/ufoo.sock
  -> ProjectRuntimeManager selects an isolated project runtime
  -> src/runtime/daemon owns launch/resume/recover/reports/cron/groups
  -> src/runtime/daemon/agentHost composes project main and global-router profiles
  -> src/orchestration owns launch routing, group, and solo policy
  -> src/agents runs launchers, providers, prompts, internal runners, shared runtime
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

- Runtime response-language guidance lives in
  `src/agents/runtime/prompts/responseLanguage.js`. Main/global, native ucode,
  and SDK worker prompts follow the user's task language for replies, progress,
  reports, and delegated handoffs. `src/agents/prompts/cooperation.js` provides
  shared loop prevention: acknowledgement-only inputs produce no peer reply,
  lifecycle report, or final text. Stored SDK bootstraps receive both rules on
  launch/resume, and only substantive tasks or changes require reports.
- A persistent dashboard socket subscribes to its selected project runtime.
  Global routing moves that subscription between projects and the controller;
  project event streams and status pushes must reach the selected client without
  leaking another runtime's status into its agent panes.
- UI code may render state and call injected callbacks; it should not directly
  write bus queues, launch processes, or own daemon state.
- The dashboard communication directory and main-agent tools include all active
  registered agents: internal children, terminal wrappers and MCP agents can be
  addressed with `@`, routed to, and delegated work; their replies/reports can
  wake the main agent. Only explicitly internal Codex, Claude and ucode children
  get panes, detailed output watches or managed lifecycle operations. External
  agents keep their own receive path and host. Unassigned external agents do
  not block the main workspace; delegated external writers do. Dashboard and
  main-agent launches still force internal mode. The welcome banner reuses the
  compact CLI logo and appears only when a project has no chat or input history.
- `Ctrl+W` cycles the dashboard through main-only, main plus one internal child,
  and main plus all children. `/window main`, `/window side` and
  `/window multi` select those modes. A split mode stays selected with
  zero children and shows the main pane at full width. The one-child mode uses
  the most recently activated live child, or the first child. `window.set` and
  `app.snapshot.window` carry explicit `main|side|multi` modes over `ufoo-ui/1`;
  `window.cycle` is evaluated by the host, independently of stale session IDs.
  While an internal child owns input, all editing keys stay with that child:
  `Ctrl+C` cancels its current turn without clearing drafts, terminating the
  worker or draining queued messages; only `Esc` returns to main. `Tab` indents
  and `Ctrl+W` deletes the previous word in the child draft. Main input retains
  its layout shortcuts and draft-clear/cancel/exit layers. Footer and popup
  navigation remain separate from activated child input.
  Standalone ucode reuses `rustMultiSession` through `ucodeAgentSession`: first
  footer selection targets a message; repeated selection opens an internal
  agent in the right-hand pane. External targets remain message-only. New
  internal runners expose a private local task-control socket that aborts a
  fresh per-turn signal; old workers require relaunch to support Ctrl+C.
  Native ucode confirms wrapper readiness through the shared agent registry
  after the Rust client's authenticated UI handshake. After ten minutes,
  slow-start diagnostics go to the wrapper's IO JSONL rather than the terminal
  owned by the child TUI, without cancelling startup or consuming queued work.
  Native ucode loads bootstrap through its system prompt and discards inherited
  CLI-wrapper startup text; it never types that text into the user's input.
- Internal Codex, Claude and ucode use a shared transcript and status surface.
  Their runner owns inbox claims and confirms each claim after execution.
  Model-issued CLI/MCP acknowledgements cannot consume later queued tasks.
  Codex and Claude always use their SDK thread runtimes, with no thread-mode
  setting or environment switch. Initialization
  failures retain the underlying provider error for the agent surface.
  One bottom input follows the selected agent; each draft stays independent.
  Internal Codex defaults to `danger-full-access`, `approvalPolicy: never`,
  and network access enabled on both new and resumed SDK threads. This temporary
  host-access policy supports simulators, system services and build caches;
  granular permission controls and approval flows are deferred. Explicit caller
  `threadOptions` override these defaults. Existing loaded workers must be
  relaunched to adopt the policy. Host access remains bounded by the OS user's
  permissions, not root privileges.
  Child drafts update locally and carry per-agent input revisions and explicit
  identities over `multi.raw`; stale output frames cannot clear newer edits.
  Client ready/resync replays all visible transcripts, including quiet agents.
  The UI socket coalesces pending frames per agent under backpressure. A false
  socket write has already queued its frame: drain sends only unsent frames so
  a large transcript cannot be repeated indefinitely or starve another pane.
  Successful window/focus switches update UI state without main-log messages.
  Main history replay retains whole transcript blocks and their speaker/tool
  metadata. Limits count messages rather than physical lines, and restored
  tool/thinking blocks start folded, preserving live paragraph/code layout.
  Each agent's status is embedded in its own pane's bottom border.
  `crates/ufoo-tui/src/selection.rs` owns pane-local mouse text selection;
  mouse release copies visible transcript cells through `clipboard.rs` (local
  macOS system clipboard, OSC 52 elsewhere). Selection excludes pane chrome and
  freezes only the selected transcript during dragging while streams keep updating.
  The main input is labelled `main`; child activity and focus changes do not
  replace the main agent's status. The footer omits the fixed internal launch
  mode and has no `/mode` command or launch-mode settings protocol. Footer selection and provider settings stay
  available with an internal child focused.
  `/resume` offers standalone recoverable internal agents and whole groups,
  without a `list` subcommand. Group launches persist `group_id`,
  `group_member_id` and `group_template_alias` on agent registrations; recovery
  also reads exact member IDs from existing `.ufoo/groups/` records. Group
  recovery updates those member IDs before subsequent routing or stopping.
  Group member `model_config` holds Codex, Claude and agy defaults plus a manual
  override. A nonempty override model replaces the whole provider setting;
  `src/orchestration/groups/modelConfig.js` validates and translates selected
  settings into launch arguments. Preview and runtime records expose model,
  reasoning effort and source; resume preserves the saved choice.
  Internal auto agy members retain the native ucode host and persist
  `model_provider: agy`; launch and resume explicitly select agy so unrelated
  coding-provider settings cannot override the group's model assignment.
  Explicit ucode members also resolve role defaults and overrides against their
  effective native provider, persisting it for launch and recovery. Native
  reasoning effort uses `UFOO_UCODE_THINKING`, not vendor CLI flags.
  Internal group launches validate every member before starting workers; auto
  members use ucode with API providers. Group status reconciles the stored roster
  against live registrations:
  groups with some live members report `partial`, and those with none report
  `inactive`. Main-agent dispatch rejects missing or inactive workers and
  can address active internal or external agents. The main agent partitions shared-repository edits by file or module.
  New native coding registrations and launch operations use `ucode`, with
  `ucode:<session>` subscriber IDs. The retired `ufoo-code` and `ufoo` type
  aliases are not launch or recovery inputs; native journal/session paths stay
  under `.ufoo/agent/ucode/`.
  Native ucode's headless thread calls the same coding runner, tools, context and
  session code as standalone ucode. Presentation adapters
  live in `src/ui/agentSurface.js` and `src/ui/agentPresentation.js`.
- Dashboard Settings exposes custom OpenAI gateways plus model/thinking menus.
  Codex defaults to `gpt-6.1-sol` with `medium` effort; Claude defaults to
  `claude-opus-5-5`. Anthropic requests use model-supported adaptive thinking
  and effort, without manual token budgets. Opus 5.5 requests enable thinking
  summaries so its progress remains visible in agent panes.
  `src/ui/agentSettingsController.js` owns settings input and menu presentation;
  `src/agents/providers/modelSettings.js` resolves each provider's model catalog
  with its own credentials. The shared catalog lives in
  `src/agents/providers/modelsCatalog.js`; native ucode forwards to it.
  For custom API URLs, including native-provider URL overrides, model catalogs
  provide suggestions only. Manual model IDs are accepted without a catalog
  check, and the selected ID remains available in the model menu.
  `src/agents/providers/clientIdentity.js` resolves read-only installed-client
  version metadata for model catalogs and inference headers. Codex versions
  follow its cache/install metadata, rather than a pinned old release; internal
  hidden models are excluded from selection. Provider adapters remain direct
  transports, with CLIProxyAPI used as a protocol reference rather than a
  runtime dependency. Claude OAuth carries its provider-specific beta flags;
  API-key authentication remains separate.
  Custom main credentials are project-local and never included in UI snapshots
  or input history. `agentModelRevision` records explicit model selections so
  existing main conversations adopt them on the next request; ordinary recovery
  retains its provider binding. Provider selection saves `agentConversationId`
  for the new conversation, which the dashboard also uses after reopening.
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

HTTP wake registrations use the `bearer-json` adapter and a separate protected
endpoint store. The scheduler holds the queue head until consumer acknowledgement,
bounds HTTP requests to ten seconds and rejects redirects. Registration and receipt
writes share the coordination file locks; wake agents never take over a TTY.

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
| `src/app/cli/` | CLI entry | Main command runner, `setupCommands.js`, `browserCommands.js`, `macCommands.js`, `appCommands.js`, and command groups. |
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
| `src/ui/desktopUiHost.js` | Desktop UI host | Shared Node `ufoo-ui/1` host (`desktop-host-v1`, `markdown-raw-v1`) connecting `Ufoo.app` to `GlobalDaemon` with multi-project + worker tree, `main\|side\|multi` + single-worker stage, and right-rail inspection. |
| `src/ui/workspaceInspector.js` | Workspace asset inspector | Git diff/worktree/report summaries (`Changes`), safe workspace doc reader (`Docs`), and Decisions/Memory CRUD (`Context`). |
| `src/ui/cliHandoff.js` | CLI ↔ App handoff | `ufoo://` deep links, `~/.ufoo/run/desktop-handoff.sock` wakeup, macOS terminal launcher, and `~/.ufoo/bin` CLI shims. |
| `crates/ufoo-tui/` | Rust TTY UI | Required `ufoo-ui/1` child process (ratatui). |
| `crates/ufoo-desktop/` | macOS Desktop host | Tauri v2 native macOS shell with vibrancy, bundled Node runtime supervisor, and `ufoo-ui/1` socket bridge. |
| `apps/desktop/` | Desktop WebView UI | React + TypeScript + Tailwind three-pane Codex-style workbench (`LeftSidebar`, `CenterStage`, `RightInspector`). |
| `src/runtime/browser/` | Optional browser runtime | Component installer, Native Messaging Host, user-scoped `BrowserBroker`, per-session CDP relay, and Playwright MCP session lifecycle. |
| `src/runtime/mac/` | macOS app & Agent Mouse runtime | Cached Swift native helper compiler, Unix-socket `NSApplication` helper (`AXUIElement`, shadowless screenshots, `CGEvent`, Agent Mouse HUD, human takeover monitor), and per-session state/leases. |
| `extensions/ufoo-browser/` | Ufoo Chrome extension | Manifest V3 Chrome extension ("Ufoo"), popup control panel, Native Messaging auto-discovery, and Apache-2.0 attribution/build docs. |
| `src/runtime/daemon/` | Global daemon and project runtime control plane | `GlobalDaemon`, immutable `ProjectContext`, `ProjectRuntimeManager`, global Streamable HTTP listener, stateless stdio proxy, endpoint routing, MCP leases/configuration, prompt routing, launch/resume/close, cron, reports, status, group orchestration. |
| `src/runtime/projects/` | Project registry | Project identity and runtime registry. |
| `src/runtime/terminal/` | Terminal adapters | Host, tmux, internal, external, Terminal.app, iTerm2. |
| `src/runtime/contracts/` | Runtime contracts | Daemon IPC, PTY socket, MCP/JSON-RPC, and `ufoo-ui/1` host↔TUI protocol. |
| `src/runtime/privacy/` | Privacy helpers | Secret redaction. |
| `src/runtime/process/` | Process helpers | Node executable resolution and similar runtime process utilities. |
| `src/coordination/bus/` | Event bus | Queues, envelopes, injection helpers, nicknames, and subscribers. |
| `src/coordination/context/` | Decisions | Decision files, sync, and context doctor. |
| `src/coordination/memory/` | Memory | Durable memory and history search. |
| `src/coordination/history/` | Prompt timeline | Input/prompt history. |
| `src/coordination/report/` | Reports | Agent report store and controller inbox records. |
| `src/coordination/state/` | `.ufoo` state | Path resolution, agent registry persistence, registry diagnostics. |
| `src/coordination/status/` | Status | Project and coordination status summaries. |
| `src/orchestration/controller/` | Launch routing policy | Agent launch selection and normalization. |
| `src/orchestration/groups/` | Groups | Templates, diagrams, validation, prompt profiles, bootstrap planning. |
| `src/orchestration/solo/` | Solo roles | Solo role command helpers. |
| `src/agents/prompts/` | Prompts | Bootstrap prompts, group prompts, profile prompts, native `ucode` prompt sections. |
| `src/agents/providers/` | Provider adapters | Claude/Codex thread providers, event translators, credentials, runtime configuration, shared API transports. |
| `src/agents/launch/` | Agent launch | External CLI launchers, PTY wrapper, notifier, ready detection, environment setup. |
| `src/agents/internal/` | Internal agents | SDK/API-backed embedded internal runner. |
| `src/agents/activity/` | Activity tracking | Ready/activity detectors and state publishing. |
| `src/agents/controller/` | Coordination tool execution | Shared controller tool executor bound to daemon ports. |
| `src/agents/runtime/` | Shared native execution | Capability composition, injected model/tool loop, tool registration/schema/host-grant checks, generic protocol helpers, durable request/command journals, namespaced snapshots, cancellation, and resource-aware scheduling. No coding/daemon/UI implementation imports in the core. |
| `src/agents/capabilities/` | Business capabilities | Coding, planning/interaction, skills, agent management/routing, discovery, memory, reports, groups, and scheduling. Business policy stays outside the shared core. |
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
      context/       # V2 turn index (.turns.jsonl) and sliding window state (.window.json)
      journal/       # append-only native ucode conversation events
      runtimes/      # correlated native model/tool/context observations
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
resolution lives in `src/agents/providers/runtimeConfig.js` and
`upstreamRuntime.js`. Main-agent requests use the shared native transports;
there is no separate controller request sender. Existing `ucode`
session paths and snapshot codecs remain compatible through namespaced storage
adapters. `createAgentRuntime().run()` supports the existing ucode host; hosts
with a runtime store also expose durable `submit`, `resume`, `cancel`, `snapshot`,
`events`, `wait`, and `close`. `agentHost.js` binds these to project IPC and the
chat/TUI. The main agent and workers can edit separate files in the same checkout concurrently. Accepted requests and paused interactions recover after restart;
a running round becomes interrupted and uncertain effects are never replayed.

All main conversations use the main runtime, with one `agentProvider` and
`agentModel` configuration for coding and routing. `/session new` starts a
conversation with current settings. Provider/model bindings survive restart;
provider credentials are resolved through their own adapters without borrowing
MCP handles or an unrelated ucode gateway key. Controller history and execution
mode selectors are no longer loaded; ucode files are not rewritten.

The project daemon delegates bus observation and report consumption to
`src/runtime/daemon/busBridge.js`. Native tool schemas live in
`src/code/tools/specs.js`; execution lives in `src/code/tools/executor.js`, and
`nativeRunner` keeps its existing exported builders.
Shared result/handoff guidance lives in `src/agents/prompts/reporting.js` and
applies to group, native, main coding and resumed internal bootstraps. Reports
and peer handoffs use 1-4 short lines (up to 600 characters by default), with
longer evidence in referenced files. Internal peer replies use the provider's
final text rather than concatenating progress; main replies follow the same rule
and panes retain the full live stream.
CLI report transport/formatting lives in `src/app/cli/reportCoreCommands.js`.
Wrapper/CLI launch environment parsing lives in
`src/app/chat/launchRequestContext.js`; dashboard launches do not forward
external terminal context.

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
| Agent launch/provider code | `npm test -- --runTestsByPath test/unit/agent/launcher.test.js test/unit/agent/internalRunner.test.js test/unit/daemon/agentHost.test.js` |
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

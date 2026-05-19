# Ink TUI Migration Plan

Status: Ink is the default TUI for chat and ucode. The legacy blessed
renderer remains available with `UFOO_TUI=blessed` as a temporary fallback.

## Why

The legacy chat, ucode and internal-agent TUIs all use blessed. Blessed is
an unmaintained imperative widget tree with no modern equivalent of React's
component model, and it's awkward to extend (manual layout math, manual
redraws, no useful test harness).

ink (the React-for-terminals library, what Claude Code, Codex CLI fronts
and the Gemini CLI all use) gives us declarative components, flexbox
layout, hooks, and proper isolation of pure logic from rendering.

## Approach

- Ink is the default renderer; `UFOO_TUI=blessed` keeps the legacy path
  available while fallback removal is evaluated separately.
- Pure helpers live in `src/ui/format/` and are shared by both, so behaviour
  parity is enforced by test rather than copy/paste.
- Components live in `src/ui/components/`, written in plain JS via
  `React.createElement` (no JSX, no build step) so jest stays vanilla.
- ink is loaded through `src/ui/runInk.js`, a thin CJS→ESM bridge so the
  rest of the codebase stays CommonJS.

## Progress

- **P0** ✅ ink + react deps, runtime bridge, `<InkDemo>` smoke harness,
  pure helpers extracted to `src/ui/format/`.
- **P1** ✅ ucode TUI ported to ink.
- **P2** ✅ folded into P3.6 (internal agent view).
- **P3** ✅ chat TUI ported to ink. Daemon
  connection, dashboard (5 views), tool-merge, status spinner, history,
  agent selection, raw-PTY mirror and internal bus agent view are wired.
- **P4** ✅ parity close-out complete: full `commandExecutor` dispatch,
  `daemonMessageRouter` callback coverage, persisted history, BUS streams,
  transient agent state, loop summary, project rail switching, cron/settings
  dashboard actions, completion popup, and default Ink entrypoints.

## P1 ucode TUI — what's wired

| Feature | Status |
|---|---|
| Banner + version + session id header | ✅ |
| Scrolling `<Static>` log (1000 line cap) | ✅ |
| Multiline input (cursor math, Ctrl+A/E/B/F/D/H/K/U/W, Meta+B/F/D, `\\\n` continuation, Alt+Enter newline, CJK wrap) | ✅ |
| Up/Down history walk + agent-selection mode | ✅ |
| Ctrl+C exit, Ctrl+O expand last tool group | ✅ |
| Tool merge/freeze/expand state machine | ✅ |
| Spinner + phase status line (request/thinking/text/tool labels) | ✅ |
| Esc abort with `AbortController` and "Cancelling..." status | ✅ |
| Agents footer with single-line truncation + `+N more` hint | ✅ |
| `runSingleCommand` empty/exit/probe/help/error/tool/nl/ubus/resume/nl_bg kinds | ✅ |
| Background tasks ("BG x/y/z" suffix) | ✅ |
| ubus / resume / nl_bg branches | ✅ |
| autoBus polling | ✅ |

## Real-TTY checklist

```sh
./bin/ucode.js
# fallback: UFOO_TUI=blessed ./bin/ucode.js
```

### Editor

- [ ] Type, see characters appear with the cursor on the next cell.
- [ ] Backspace deletes one cell back; cursor stays correct on CJK.
- [ ] Left/Right arrows move the cursor; resetting preferred col.
- [ ] Up/Down on a single line walks input history.
- [ ] Up/Down on a multiline value moves between visual rows.
- [ ] `\` followed by Enter inserts a newline; Enter alone submits.
- [ ] Alt+Enter inserts a newline.
- [ ] Ctrl+A / Ctrl+E jump to row start / end.
- [ ] Ctrl+W deletes the previous word (also Meta+Backspace).
- [ ] Long pasted text doesn't lock up the renderer.
- [ ] Resize the terminal — input frame and footer span the new width.

### Status line

- [ ] Shows `UCODE · Ready` while idle.
- [ ] Shows a spinning indicator + phase ("Waiting for model...",
  "Thinking...", "Generating response...", "Calling X...") during
  `runNaturalLanguageTask`.
- [ ] Appends `(<elapsed> s, esc cancel)` when a task is in flight.
- [ ] Esc on a running task flips to "Cancelling..." then back to Ready.

### Tool calls

- [ ] Single tool call renders one line (`· tool · detail`).
- [ ] Two+ consecutive tool calls collapse to one row + `(Ctrl+O expand)`.
- [ ] Ctrl+O expands the most recent group with `│`/`└` branch markers
  and only fires once per group.
- [ ] When text arrives between tool calls, the previous group freezes
  into the log and a fresh group starts on the next tool call.

### Agents footer

- [ ] Shows `Agents: none  │ No target agents` when nothing's online.
- [ ] Shows `Agents: @x @y ...  │ ↓ select target · ←/→ switch` otherwise.
- [ ] At narrow widths, the row stays single-line, drops trailing chips
  and emits ` +N more`.
- [ ] Down enters selection mode (first chip inverse). Left/Right cycle.
  Up exits. Prompt prefix changes to `›@<name> ` when locked.

### Smoke

- [ ] `node scripts/ucode-app-smoke.js` exits 0.
- [ ] `npx jest --silent` shows the pre-existing 5 OAuth failures only;
  every ink suite passes.

## Decision log

- **Don't fork ink.** Claude-code-fixed inlines a customised ink under
  `src/ink/`; we don't need React 19 / ConcurrentRoot / IDE bridging,
  so depending on the public `ink@5` keeps maintenance cost low.
- **Don't add JSX.** `React.createElement` keeps jest CJS happy and
  avoids a build step. We can revisit if any single component grows
  past ~600 lines and readability suffers.
- **Don't enable `--experimental-vm-modules` for jest.** The risk of
  surprise ESM behaviour across the existing 1800-test suite is too
  high. Render coverage stays in `scripts/*-smoke.js`; component logic
  is exercised by pure-function tests.
- **Codex isn't a useful reference.** Its TUI is a Rust ratatui app
  (`codex-rs/tui`), not React-based. The architectural principle worth
  borrowing is its hard split between TUI and core protocol.

## P2 dropped, folded into P3

The internal-agent view in chat is not an independent program — it's a
view mode owned by `src/chat/agentViewController.js`. Today it works by
detaching `screen.children`, writing raw `\x1b[2J` to stdout, and
flipping `screen.grabKeys`. There is no clean seam to mount an isolated
ink subtree inside a still-blessed chat host, so attempting P2 in
isolation would force us to build a stdout-arbitration layer we'd throw
away once chat itself is on ink. P3.6 ports the agent view as a chat
sub-mode instead.

## P3 audit (chat TUI surface)

Source: `src/chat/index.js` (2215 lines) + ~30 controllers in
`src/chat/`. Highlights:

### Lifecycle
- Public entrypoint `runChat(projectRoot, { globalMode })` from
  `src/chat/index.js`. Wires `daemonCoordinator.connect()` then loops
  forever; exit goes through `process.exit(0)` from a screen `destroy`
  hook.
- Runners injected via closures: `daemonCoordinator.send`,
  `executeCommand`, `inputSubmitHandler.handleSubmit`,
  `daemonMessageRouter.handleMessage`.

### View state machine
- `dashboardView` ∈ `projects | agents | mode | provider | cron`
- `focusMode` ∈ `input | dashboard` — toggled by Tab and arrow keys
- `globalMode` (boolean) + `globalScope` ∈ `controller | project` —
  `globalMode=true` enables a multi-project rail; Esc/Enter walk the
  scope ladder.
- `enterDashboardMode()` / `exitDashboardMode()` are the two transition
  points; `setGlobalScope()` runs an async, debounced project switch.

### Input
- Submit accepts `@mention`, `@target`, `/command`, plain text and
  numeric disambiguation (when `pending.disambiguate` is set).
- Editor keys cover Ctrl+A/E/B/F/D/H/K/U/W, Meta+B/F/D, arrows
  (cursor + history when empty), Esc (3-layer: clear @target →
  exit project scope → cancel input), bracketed paste, Tab (toggle
  dashboard), PgUp/PgDn (scroll log).
- Completion fires on `/` and `@` with sources from command registry,
  group templates, solo profiles and agent mentions; Up arrow jumps to
  the latest suggestion.
- History is per-project, persisted to `input-history.jsonl` with
  draft restoration on project switch.

### Daemon stack
- `daemonTransport` owns the socket path and retry policy.
- `daemonConnection` owns the queue + lifecycle (`connect`, `send`,
  `requestStatus`, `close`, `markExit`, `switchConnection`,
  `getState`).
- `daemonCoordinator` orchestrates project switches with a serialised
  Promise chain.
- `daemonMessageRouter.handleMessage(msg)` is a stateless dispatcher
  that turns daemon responses into log appends, dashboard updates, PTY
  writes and transient agent state changes.
- `daemonReconnect.restartDaemonFlow()` provides a per-project lock for
  daemon restarts.

### Side controllers
- `cronScheduler` — `/cron start|stop|list` + the cron dashboard view.
- `settingsController` — launch mode / agent provider,
  with daemon restart on mode/provider change. `autoResume` stays config/command-driven.
- `chatLogController` — log buffer + history file replay
  (`loadHistory`, `appendHistory`, `markStreamStart`,
  `setHistoryTarget`, `resetViewState`).
- `statusLineController` — debounced status line with background-task
  suffix (e.g. `(ufoo-agent processing)`); `queueStatusLine`,
  `resolveStatusLine`, `enqueueBusStatus`, `resolveBusStatus`.
- `streamTracker` — per-publisher stream state + markdown rendering
  (`beginStream`, `appendStreamDelta`, `finalizeStream`,
  `markPendingDelivery`, `consumePendingDelivery`).
- `transientAgentState` — TTL-bounded `working / waiting_input /
  blocked` markers per agent.
- `projectCloseController` — `requestCloseProject(index)` runs daemon
  stop + project switch.
- `agentDirectory` — agent label resolution + window clamping (pure).
- `internalAgentLogHistory` — bus log replay for internal agents.

### Internal-agent sub-view (`agentViewController`, 1072 lines)
- Public API: `getCurrentView`, `getViewingAgent`,
  `isAgentViewUsesBus`, `getAgentInputSuppressUntil`,
  `get/setAgentOutputSuppressed`, `renderAgentDashboard`,
  `setAgentBarVisible`, `enterAgentView(agentId, options)`,
  `exitAgentView`, `sendRawToAgent`, `sendResizeToAgent`,
  `requestAgentSnapshot`, `writeToAgentTerm`, `placeAgentCursor`,
  `handleBusAgentKey`, `handleResizeInAgentView`, `refreshAgentView`.
- Two render modes inside it: PTY mirror (raw ANSI passthrough +
  cursor placement, `agentSockets.connectOutput/Input`,
  `requestSnapshot`) and an embedded bus subview (own input value,
  cursor, log, animated status indicator).
- `agentBar.computeAgentBar` renders the agent strip across both
  modes.
- `agentSockets.createAgentSockets` owns the PTY/bus socket
  lifecycle.
- Exit/restore reattaches `screen.children`, restores scroll region
  and unfreezes `screen.render`.

### Layout (`createChatLayout`)
- 9 widgets: screen, logBox, statusLine, completionPanel, dashboard,
  inputBottomLine, promptBox, input, inputTopLine.
- Geometry rules: dashboard 1-2 lines, input 5-9 lines (autosizes by
  content), log fills the rest. Many `height: "100%-N"` strings →
  ink flex layout in the port.

### Commands
`/bus`, `/ctx`, `/daemon`, `/doctor`, `/cron`, `/group`, `/init`,
`/open`, `/launch`, `/project`, `/role`, `/solo`, `/settings`,
`/help`, plus nested subcommands (`/bus activate|list|rename|send|status`,
`/cron start|list|stop`, etc.). `commandExecutor.executeCommand(text)`
is the single dispatch point. `parseCommand(text)`, `parseAtTarget(text)`
and `shouldEchoCommandInChat(text)` are pure.

### Cross-cutting
- `text.js`: `escapeBlessed`, `stripBlessedTags`, `stripAnsi`,
  `truncateAnsi`, `decodeEscapedNewlines`. Pervasive — used by every
  log message, status line and dashboard line. The blessed-tag
  helpers (`escapeBlessed`/`stripBlessedTags`) become no-ops in ink;
  the ANSI helpers stay relevant.
- `rawKeyMap.keyToRaw(ch, key)`: converts ink-style key events to
  PTY bytes for the agent view. Stays as-is.
- `transport.js`: `startDaemon`, `stopDaemon`, `connectWithRetry`.
  Framework-agnostic, no migration needed.

### Migration concern shortlist (1 per section)
1. **Entry**: 50+ `screen.render()` calls turn into React state
   updates; build a `useReducer` so dispatchers are async-safe.
2. **State machine**: `setGlobalScope` is async + debounced — model
   it as an effect, not a setter.
3. **Input**: cursor math already lives in `src/ui/format` (P0); we
   reuse it.
4. **Daemon**: keep `daemonConnection` / `daemonCoordinator` as-is;
   wrap the message router in a `useEffect` subscription that pumps
   into `dispatch`.
5. **Side controllers**: keep the controllers as plain modules;
   `useEffect` subscribes/unsubscribes instead of attaching to
   blessed events.
6. **Agent view**: ink can't render arbitrary ANSI inside a `<Box>`,
   but it can yield stdout to a "raw mode" component that writes
   straight through during PTY mirror; we'll model it with
   `<Static>`-style raw write or by suspending ink's render and
   passing stdout through, then re-mount on exit.
7. **Layout**: replace `height: "100%-N"` with flexbox + `flexGrow`.
8. **Commands**: long-running commands run on a serialised promise
   chain like ucode's `runChainRef`.
9. **Cross-cutting**: drop blessed-tag helpers from ink call sites;
   ANSI/text helpers stay.

### P3 phase plan

| Step | Goal | Status |
|---|---|---|
| P3.1 | This audit | ✅ |
| P3.2 | `UFOO_TUI=ink` switch in `runChat()` | ✅ |
| P3.3 | ChatApp shell (banner + log + input + status) | ✅ |
| P3.4 | Five dashboard views as React components | ✅ |
| P3.5 | Daemon connection + PROMPT/BUS_SEND wiring | ✅ |
| P3.6 | Raw-PTY internal agent view as a ChatApp mode | ✅ |
| P3.7 | Real-TTY checklist | ✅ |

## P3 chat TUI — what's wired

| Feature | Status |
|---|---|
| Banner header (project + global mode + scope) | ✅ |
| Scrolling `<Static>` log (1000 line cap) | ✅ |
| Multiline input (P1 MultilineInput component) | ✅ |
| 5 dashboard views (projects/agents/mode/provider/cron) | ✅ |
| Tab toggles input/dashboard focus | ✅ |
| Up/Down history walk + agent selection mode | ✅ |
| Left/Right cycle agents while selected | ✅ |
| Spinner + phase status line | ✅ |
| Tool-merge state machine + Ctrl+O expand | ✅ |
| Daemon connect / send / status poll | ✅ |
| `PROMPT` for free text, `BUS_SEND` for `@target` | ✅ |
| `BUS_SEND_OK` / `RESPONSE` / `ERROR` / `STATUS` / `BUS` envelopes | ✅ |
| Raw PTY agent mirror (Enter on selected agent, Esc to leave) | ✅ |
| `daemonMessageRouter` (markdown streams, transient state, bus subview) | ✅ |
| `commandExecutor` full slash-command dispatch (`/cron`, `/group`, `/role`, `/settings` …) | ✅ |
| Slash + `@` autocomplete | ✅ |
| Input history persisted file load/save | ✅ |
| Cron dashboard actions | ✅ |
| Settings dashboard actions (launch mode, provider) | ✅ |

## Real-TTY checklist for chat

```sh
./bin/ufoo.js chat                   # project mode
./bin/ufoo.js chat --global          # global controller mode
# fallback: UFOO_TUI=blessed ./bin/ufoo.js chat
```

### Layout
- [ ] Banner shows the active project + global/project tag.
- [ ] `Agents:` footer, status line above input, log fills the rest.
- [ ] Resize the terminal — input frame and footer stay single-line.

### Input + history
- [ ] Type, Enter sends a `PROMPT`. Backspace, arrows, Ctrl+A/E etc.
  behave the same as the ucode editor.
- [ ] Up/Down on an empty draft walks the in-memory history.
- [ ] `\` + Enter inserts a newline.
- [ ] Esc clears any active agent selection.

### Daemon
- [ ] On launch the daemon spawns automatically (look for the socket
  under `~/.ufoo` or your project's `.ufoo`).
- [ ] Send a free-text message — daemon answers, status flips to
  `Working on task...` and back to Ready.
- [ ] Type `@<agent> hi` (or select with arrow keys) — message is
  sent via `BUS_SEND`, ack arrives as `✓ Message delivered`.

### Agents footer
- [ ] Tab into the dashboard, ↓ enters agent selection (first item
  inverse), ←/→ cycles, ↑ exits.
- [ ] Enter on a selected agent attaches to its PTY (cleared screen +
  scroll region + bottom hint bar). Esc returns to chat without
  losing the previous draft or log.

### Tool-merge
- [ ] Daemon-driven tool calls collapse and `(Ctrl+O expand)` works
  the same as ucode.

### Smoke
- [ ] `node scripts/chat-app-smoke.js` exits 0.
- [ ] `node scripts/ucode-app-smoke.js` exits 0.
- [ ] `npx jest --silent` shows the pre-existing 5 OAuth failures
  only; every ink suite passes.

## P4 close-out

- **STATUS handler fix** — chat now reads `msg.data.active` /
  `msg.data.active_meta` / `msg.data.cron.tasks` so the agents and cron
  counts in the footer actually update.
- **Slash command dispatch** — `createCommandExecutor` is wired in Ink
  with daemon stop/start/restart, cron IPC, project switching and agent
  activation callbacks.
- **Input history persistence** — `<projectRoot>/.ufoo/chat/input-history.jsonl`
  is loaded on mount and appended on every submit; format matches the
  blessed inputHistoryController.
- **Daemon message routing** — Ink routes daemon envelopes through
  `daemonMessageRouter`, including BUS phase status, transient states,
  pending delivery markers, streams, close/launch refreshes and loop
  summary dashboard display.
- **Inline completion popup** — `/<prefix>` matches commands from
  `COMMAND_REGISTRY`; `@<prefix>` matches the live agents list. Tab
  accepts the top suggestion. Pure helper `buildCompletions` lives in
  `src/ui/format` with full jest coverage.
- **Exit hygiene** — Ctrl+C now flushes `\x1b[2J\x1b[H` so the shell
  prompt comes back to a clean screen instead of sitting under the
  final ink frame; `runUcodeInkTui` returns `{ code: 0 }` so
  `agent.js`'s `process.exit(res.code)` no longer crashes.

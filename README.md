# ufoo

[中文文档](README.zh-CN.md) · [Architecture Guide](docs/PROJECT.md) · [Observability](docs/OBSERVABILITY.md) · [Documentation Index](docs/README.md)

**Multi-Agent Workspace Runtime.** Just add `u` — `claude` → `uclaude`, `codex` → `ucodex`, `agy` → `uagy`, `grok` → `ugrok`, `kimi` → `ukimi` — or open `ufoo` to run a project main agent alongside embedded Codex, Claude, and native `ucode` workers inside a single Rust TUI dashboard.

Package: [u-foo on npm](https://www.npmjs.com/package/u-foo)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue.svg)](https://github.com/Icyoung/ufoo)

---

## Why ufoo?

ufoo gives every coding agent in your repository a shared control plane without forcing you into a single vendor CLI:

- **Unified Rust TUI Dashboard (`ufoo` & `ucode`)**: Work with a project main agent and multiple internal Codex, Claude, and `ucode` workers in one terminal (`main`, `side`, and `multi` split layouts), with independent per-agent input drafts, live streaming thinking/tool trees, pane-local mouse copy, and `/resume` for individual workers or entire agent groups.
- **Composable Native Agent Runtime & Context Engine V2**: Shared by the `ufoo` main agent, independent background coding tasks (`manage_tasks`), and standalone `ucode`. Includes a KV-cache-stable sliding turn window, automatic `<turn_context>` topic indexing, `recall_turn` off-window transcript search, structured `plan_graph` / Plan Mode, crash-safe journals, workspace write leases, and token-free background command auto-wake.
- **Everyday Chrome Automation (`browser`)**: Operate your already-open, signed-in Chrome through the optional `ufoo Browser` extension and user-scoped broker with per-tab ownership (`browser_tab_busy` protection) — never launching a blank profile or closing your browser on disconnect.
- **macOS Desktop Apps & Independent Agent Mouse (`mac_app`)**: Hybrid `AXUIElement` UI tree inspection (`@e1..@eN` refs + direct AX actions), shadowless 1:1 logical-point screenshots (`screenshotId` coordinate mapping), and a window-targeted **Agent Mouse** with a floating HUD that operates Mac apps without hijacking your physical cursor — yielding immediately on mouse shake, target-window click, or `Esc`.
- **Drop-In CLI Wrappers & Universal MCP**: Keep using external `uclaude`, `ucodex`, `uagy`, `ugrok`, `ukimi`, **Codex App/IDE**, **Cursor**, **Antigravity App**, or HTTP webhooks. One user-scoped daemon (`~/.ufoo/run/ufoo.sock`) hosts isolated project runtimes, a singleton Streamable HTTP MCP server, and a stateless `ufoo mcp` stdio proxy.
- **Groups, Shared Memory & Evidence-Gated Orchestration**: Launch multi-agent teams from 7 built-in group templates with role-tuned `codex` / `claude` / `agy` model presets, share architectural decisions and durable memory, collaborate remotely via `ufoo online`, and audit every run with `ufoo trace` and `ufoo metrics`.

---

## Installation & Requirements

### Requirements

- **Node.js 18.17+** (`ufoo Browser` Playwright MCP runtime requires **Node.js 20+**).
- **macOS** or **Linux** (prebuilt `ufoo-tui` binaries are bundled for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`; macOS is required for `mac_app` desktop automation and Terminal.app/iTerm2 adapters).
- Corresponding vendor CLIs installed when using wrapper binaries (`claude`, `codex`, `agy`, `grok`, `kimi`).

### Install from npm

```bash
npm install -g u-foo
ufoo setup
```

`ufoo setup` interactively asks whether to install the optional **ufoo Browser** component (`ufoo setup --browser=install` or `ufoo setup --browser=skip`; non-interactive installs skip optional downloads by default).

### Build from Source

```bash
git clone https://github.com/Icyoung/ufoo.git
cd ufoo
npm install
npm run pack:tui
npm link
```

### Installed Binaries

| Binary | Responsibility |
|---|---|
| `ufoo` | Main CLI, multi-agent chat dashboard, global/project daemons, MCP server & stdio proxy, `browser` & `mac` managers, groups, bus, context, memory, reports, trace/metrics, and online relay. |
| `ucode` | Native ufoo coding-agent CLI/TUI powered by the shared runtime, Context Engine V2, `browser`, and `mac_app`. |
| `uclaude` | Claude Code wrapper with ufoo bootstrap, bus identity, native stdio MCP message channel, and resume capture. |
| `ucodex` | OpenAI Codex wrapper with ufoo bootstrap, bus identity, native app-server queue delivery, and resume capture. |
| `uagy` | Antigravity CLI wrapper with ufoo bootstrap, bus identity, and conversation resume capture. |
| `ugrok` | Grok Build wrapper with ufoo bootstrap and bus registration. |
| `ukimi` | Kimi Code wrapper with ufoo bootstrap, bus registration, and resume metadata. |

---

## Quick Start

### 1. Open the Multi-Agent Dashboard

```bash
cd your-project
ufoo init --targets context,bus
ufoo          # Open current project dashboard
ufoo -g       # Or open global router to switch across registered projects
```

Inside chat, work directly with the main agent or spawn internal workers:

```text
> /launch codex reviewer
> /launch claude builder
> /launch ucode fixer
> @reviewer inspect the current diff and list release risks
> /group run build-lane instance=auth-refactor
```

### 2. Or Use Drop-In CLI Wrappers

Run any wrapped CLI in your project terminal — it automatically joins the project event bus and inherits shared context:

```bash
uclaude
ucodex
uagy
ugrok
ukimi
ucode
```

### 3. Connect External IDE / Desktop Agent Hosts via MCP

- **Codex App, Codex CLI & Codex IDE Extension** (direct authenticated Streamable HTTP):
  ```bash
  ufoo -g
  ufoo mcp configure codex    # Use --dry-run to preview with redacted credentials
  ```
  Restart the Codex surface after configuring.

- **Cursor, Antigravity App & Other MCP Hosts** (stateless stdio proxy supporting both newline JSON and `Content-Length` framing):
  ```json
  {
    "mcpServers": {
      "ufoo": {
        "command": "ufoo",
        "args": ["mcp"]
      }
    }
  }
  ```
  Inspect or restart the singleton MCP listener anytime with `ufoo mcp status` and `ufoo mcp restart`.

---

## Dashboard & TUI Guide

Both `ufoo` and standalone `ucode` render through the Rust `ufoo-tui` process over the `ufoo-ui/1` socket protocol. Long-running tasks live in the daemon — closing the TUI never cancels background runs, and reconnecting replays live transcripts and status.

### Layouts & Navigation

The dashboard provides three window modes (`Ctrl+W` cycles `main → side → multi → main`):

- **`/window main`** — Full-width main agent pane.
- **`/window side`** — Main agent on the left + one active internal worker on the right.
- **`/window multi`** — Main agent + all active internal Codex, Claude, and `ucode` workers.

| Shortcut / Action | Behavior |
|---|---|
| `Ctrl+W` (in `main` input) | Cycle layouts (`main → side → multi → main`); in a child input, deletes the previous word. |
| `Ctrl+Q` | Exit split layout back to `main` while keeping workers and drafts alive. |
| `Tab` | Enter visible child pane in split mode, cycle footer agents in `main` mode, or accept slash completion. |
| `Esc` | Close open popup/menu, or return focus from an internal child input back to `main` without cancelling work. |
| `Ctrl+C` | In a child pane: cancel only that child's active turn (keeping worker & queue alive). In `main`: clear draft, cancel turn, or exit. |
| `Ctrl+O` | Expand/collapse the latest thinking or merged tool-call block in the focused pane. |
| `Ctrl+X` (on Agents footer) | Close the selected internal worker via the project daemon. |
| Mouse drag in any pane | Pane-local text selection (excludes borders/adjacent panes); releasing copies via macOS clipboard or OSC 52. |

### Essential Slash Commands

```text
/status                         Project, daemon, and active agent summary
/launch <codex|claude|ucode>    Spawn an embedded internal worker
/resume                         Resume saved internal workers or whole groups (group:<id>)
/task list | inspect | cancel   Manage independent background coding tasks
/answer <interaction-id> <text> Reply to a paused ask_user interaction
/session show | new             Inspect or start a fresh main conversation
/settings                       Configure provider, custom gateway, model, and thinking effort
/group templates | run | status Orchestrate multi-agent group workflows
/ctx status | decisions | doctor Inspect architectural decisions and context health
/bus status | list | send       Inspect bus queues and message registered agents
/project list | switch <n>      Switch workspaces in global/multi-project mode
/open /path/to/project          Open and attach another project directory
/doctor                         Diagnose CLI versions, MCP config, and delivery receipts
```

---

## Native Agent Runtime & `ucode`

`ufoo`'s project main agent, writable child tasks (`manage_tasks`), and `ucode` share a layered, capability-composed runtime (`src/agents/runtime/`).

### Context Engine V2 & `recall_turn`

- **KV-Cache-Stable Sliding Window**: Retains a `Step=2` aligned raw turn window (5 turns by default, expanding up to 10 on active topics within a 45% context budget) so system prefixes and historical turns stay cache-hit friendly.
- **Ephemeral `<turn_context>` Injection**: Attaches a compact `<topic_map>` and `<relevant_turns>` digest to the current user turn without polluting persisted transcripts.
- **Optional Background Aux Enrichment**: When `agentAuxModel` or `ucodeAuxModel` is configured, an asynchronous Phase B enricher refines turn summaries and Tier 2 topic selection off the critical path (zero extra model calls when unconfigured).
- **Deterministic Overflow Eviction & `recall_turn`**: Tight context budgets trigger a deterministic Level 1–3 eviction ladder instead of blocking LLM compaction calls, while the `recall_turn` tool lets the agent search off-window turns or paginate full raw transcripts on demand.

### Plan Mode, Execution Budgets & Workspace Leases

- **Plan Mode & `plan_graph`**: Enable with `/plan on` (or automatically when `plan_graph create` runs). Blocks direct mutating calls (`write`, `edit`, `bash`, mutating `browser`/`mac_app` actions) while permitting read/inspection tools and advancing structured `plan_graph` nodes. Leave with `/plan off`.
- **Execution & Loop Guards**: Model turns and tool calls are unbounded by default within a 12-hour task deadline (configurable via `ucode --max-tool-calls <N|none>`, `UFOO_UCODE_MAX_TOOL_CALLS`, `UFOO_UCODE_MAX_TOOL_ERRORS`, and `UFOO_UCODE_TASK_TIMEOUT_MS`). Consecutive tool failures warn at 3 and stop at 5 (or 12 of the last 20); identical repeated tool batches trigger a reminder and halt runaway loops.
- **Crash Safety & Directory Leases**: Completed turns commit atomically before the next model request. Interrupted mutations are never blindly replayed. Concurrent managed writers coordinate via directory leases, while verified `git worktree` checkouts execute in parallel.

### Token-Free Background Command Auto-Wake

Agents can launch background processes (dev servers, builds, watchers) with declarative wake conditions — zero LLM polling while waiting:

```json
{
  "command": "npm run dev",
  "background": true,
  "wake": {
    "conditions": [{ "type": "log_contains", "text": "Ready in" }]
  }
}
```

Supported one-shot conditions: `log_contains`, `file_exists`, `port_open` (`127.0.0.1`), plus process exit (`wake.onExit`, enabled by default). Watches survive host restarts and resume cleanly at turn boundaries.

### Agent Skills

Default skills (`ufoo`, `ufoo-bus`, `ufoo-context`, `ufoo-online`) link automatically on `postinstall` without overwriting user-owned files. Manage skills across hosts with:

```bash
ufoo skills list --optional
ufoo skills install all --claude          # ~/.claude/skills
ufoo skills install all --codex           # ${CODEX_HOME:-~/.codex}/skills
ufoo skills install all --agy             # ~/.gemini/config/skills
ufoo skills install all --agents          # ~/.agents/skills
ufoo skills install ufoo-bus-poll --target /path/to/skills
```

---

## Browser & macOS Desktop Automation

Both capabilities are available out of the box in the `ufoo` main agent, writable native child tasks, and `ucode`. Multimodal screenshots attach automatically as provider vision blocks and retire cleanly after viewing.

### 1. Your Everyday Chrome (`browser` / `ufoo browser`)

Connects to your existing, authenticated Chrome via Playwright MCP (requires **Node.js 20+**) — preserving logins and cookies without ever launching an empty browser or closing Chrome on disconnect.

```bash
ufoo setup --browser=install     # Install optional Playwright MCP runtime + Native Messaging host
ufoo browser install --dev       # Load unpacked extension from extensions/ufoo-browser/ during preview
ufoo browser status [--json]
ufoo browser doctor
ufoo browser enable | disable | update | uninstall
```

- **Per-Tab Ownership via `BrowserBroker`**: The `ufoo Browser` MV3 extension auto-connects over Chrome Native Messaging to a shared local broker (`~/.ufoo/browser/private/broker.sock`). Agents inspect tabs (`browser_tabs` `action=list`) and claim specific `tabId`s; tabs owned by another session return `browser_tab_busy` without preemption. You can pause all control or release tabs anytime from the extension popup.
- **Compatibility Modes**: Supports the official Playwright Extension (`backend: "playwright-extension"`) and explicit CDP endpoints (`UFOO_BROWSER_CDP_ENDPOINT=chrome` or `http://127.0.0.1:9222`, guarded by a per-OS-user lease).
- **On-Demand Schema Discovery**: `browser` exposes `status`, `connect`, `tools`, `call`, and `disconnect`, keeping external Playwright schemas out of the base system prompt until needed. Artifacts save under `.ufoo/browser/<session-hash>/`.

### 2. macOS Desktop Apps & Independent Agent Mouse (`mac_app` / `ufoo mac`)

Operates native Cocoa, SwiftUI, Catalyst, and Electron apps on macOS through a cached, zero-dependency Swift helper (`~/.ufoo/mac/bin/`) served over a private Unix socket:

- **Structured Accessibility (`AXUIElement`)**: `list_apps`, `list_windows`, `snapshot` (automatically wakes Chromium/Electron AX trees, assigns `@e1..@eN` refs, supports `includeMenuBar=true` and `query` filtering), `ax_action` (`press`, `focus`, `set_value`, `confirm`, `pick`, `show_menu`, `increment`, `decrement`), `launch_app`, `focus_app`, and `manage_window`.
- **1:1 Logical-Point Screenshots**: Shadowless window (`-o -l`), region, or full-display capture scaled to 1:1 macOS logical points by default. Passing `screenshotId` maps image `(x, y)` coordinates directly to live window/screen coordinates without Retina `2x` drift. Saved under `.ufoo/mac/<session-hash>/`.
- **Independent Agent Mouse & Human Yield**:
  - Tracks a per-session virtual pointer and dispatches window-targeted `NSEvent` / `CGEvent.postToPid` events **without moving or warping your physical cursor**.
  - Renders a non-capturable (`sharingType = .none`) floating **Agent Mouse HUD** showing live pointer position, click ripples, and action badges.
  - Windows stay in the background unless `focusApp=true` is explicitly requested (always verify background input effects via `snapshot` or `screenshot`, as app support varies; cross-window drags are rejected and unsupported targets never fall back to hijacking the physical mouse).
  - **Instant Human Takeover**: Ordinary physical mouse movement stays independent; a deliberate mouse shake, a physical click inside the agent's target window, or pressing `Esc` immediately triggers `user_takeover` and yields control.

```bash
ufoo mac status [--json]         # Inspect helper state, displays, and TCC permissions
ufoo mac permissions             # Prompt & open macOS Accessibility + Screen Recording settings
ufoo mac doctor                  # Verify Swift helper build, daemon socket RPC, and permissions
ufoo mac hud on | off | toggle   # Toggle on-screen Agent Mouse visual indicator
ufoo mac enable | disable | stop
```

---

## Architecture & Agent Delivery Protocol

```text
ufoo / ufoo chat / ucode
  -> src/app/chat + src/ui/ + crates/ufoo-tui (ratatui over ufoo-ui/1)
  -> home-scoped GlobalDaemon (~/.ufoo/run/ufoo.sock)
  -> isolated ProjectRuntime per workspace (~/.ufoo/projects/runtime)
  -> orchestration (router, 7 group templates, solo roles, cron)
  -> shared native agent runtime + SDK internal runners + CLI wrappers
  -> .ufoo/ coordination state (bus, context decisions, memory, history, reports, journals)

External MCP Clients:
  Codex App / CLI / IDE  --(Streamable HTTP)--> GlobalDaemon MCP Listener & Router
  Cursor / agy / others  --(ufoo mcp proxy)--->   -> ProjectRuntimeGateway -> Project Bus & Tools
```

### Two Deterministic Agent Delivery Modes

ufoo selects an agent's bus delivery mode strictly from whether `UFOO_SUBSCRIBER_ID` was inherited at launch:

1. **Wrapper-Managed Agents (`ucodex`, `uclaude`, `uagy`, `ugrok`, `ukimi`, `ucode`)**:
   - Inherit `UFOO_SUBSCRIBER_ID` and `UFOO_AGENT_HANDLE`. The wrapper/daemon owns registration, activity tracking, and direct prompt injection.
   - **Native Incoming Transports**: Interactive `ucodex` (verified baseline `0.160.1+`) binds a launch-local app-server and queues bus work via `thread/queue/add`; interactive `uclaude` (`2.1.204+`) uses a launch-local stdio MCP channel with startup probe verification. Neither mutates global vendor config, and uncertain deliveries are persisted for explicit operator resolution (`ufoo bus deliveries <subscriber> [<receipt-id> accepted|retry]`) rather than falling back to blind keystroke injection. Use `--no-native-messages` (`UFOO_NATIVE_MESSAGES=0`) to opt out.

2. **Externally Hosted MCP Agents (no inherited `UFOO_SUBSCRIBER_ID`)**:
   - Self-register once via MCP `register_agent` (receiving a server-allocated `<prefix>:<8-hex>` ID, `<prefix>-N` nickname, and opaque `agent_handle`; pass `client_instance_id` for seamless reconnect recovery).
   - Pair with the opt-in `ufoo-bus-poll` skill for **zero-token idle waiting** matched to each host app:
     - **Codex App**: Keeps one foreground MCP `wait_for_message` call pending on a dedicated `ufoo_wait` connection until a message arrives, then acknowledges via `ack_bus`.
     - **Cursor**: Runs `ufoo bus poll "<subscriber-id>" --follow --interval 30` in a monitored background terminal (`notify_on_output` matching `\[ufoo\]`).
     - **Antigravity App (`agy app`)**: Runs a silent background exit-on-message waiter polling `ufoo bus check "<subscriber-id>"` that exits `0` on `[ufoo]` output to trigger reactive wakeup, then acknowledges via MCP `ack_bus` and re-arms.
   - **HTTP Wake Endpoints**: Register remote bots (e.g. `grok-bot`) with `ufoo bus join <session> grok-bot --wake-url https://... --wake-key-file /path/to/key` (`bearer-json` with `ufoo bus ack` queue gating).

---

## Multi-Agent Groups, Context & Observability

### Built-In Group Templates (`templates/groups/`)

Launch coordinated multi-agent pipelines (`build-lane`, `build-ultra`, `design-system`, `product-discovery`, `ui-plan-review`, `ui-polish`, `verify-ship`) directly from chat or CLI:

```text
/group templates
/group template show build-lane
/group run build-lane dry_run=true
/group run build-lane instance=release-v4
/group status
/group diagram build-lane mermaid
/group stop release-v4
```

Every member across all 7 templates carries role-tuned defaults for `codex`, `claude`, and `agy` plus an optional manual `override`:

| Role | Codex (`model` / `effort`) | Claude | Antigravity (`agy`) |
|---|---|---|---|
| Architect, Debugger, Discovery, Design Consultant | `gpt-6-astra` / `high` | `claude-fable-5-2` | `gemini-4-carbon-high` |
| Builder, Frontend Refiner | `gpt-6.1-sol` / `high` | `claude-opus-5-5` | `gemini-4-hydrogen-high` |
| Reviewer, Scope Challenger, Critics, Release Coordinator | `gpt-6.1-sol` / `xhigh` | `claude-opus-5-5` | `gemini-4-argon-high` |
| PMO | `gpt-6-astra` / `high` | `claude-fable-5-2` | `gemini-4-argon-high` |
| QA | `gpt-6.1-sol` / `xhigh` | `claude-opus-5-5` | `gemini-4-hydrogen-high` |

### Decisions, Shared Memory, Reports & Acceptance

```bash
# Durable shared project facts (use /ctx decisions for plan-level architectural constraints)
ufoo memory add "Auth token contract" --body "Refresh window is 300s..." --tags auth,api
ufoo memory list --tag auth
ufoo memory show mem-0001

# Unified prompt history & structured task lifecycle reports
ufoo history build && ufoo history show 20
ufoo report start "Refactor session store" --task store-v2 --agent builder
ufoo report done "All unit tests green" --task store-v2 --agent builder
ufoo report list
```

Worker `done` reports record concise 1–4 line handoffs with file references; parent acceptance (`accept_task` / `manage_tasks operation=accept`) is tracked separately and requires post-report validation tool evidence.

### Tracing & Metrics (`OBSERVABILITY.md`)

Inspect end-to-end parent/child model calls, tool executions, context projections, and delegation latency without invoking a model or starting a daemon:

```bash
ufoo trace <task-id> --json
ufoo trace --agent <id-or-nickname> --follow
ufoo metrics --json > baseline.json
ufoo metrics --baseline baseline.json --json
```

Read-only MCP equivalents: `read_agent_trace` and `read_agent_metrics`. See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

### Online Relay (`ufoo online`)

Collaborate across machines over `https://online.ufoo.dev` or a self-hosted WebSocket relay:

```bash
ufoo online server --host 127.0.0.1 --port 8787
ufoo online token codex:abc123 --nickname builder
ufoo online room create --nickname builder --name review-room --type private --password secret
ufoo online connect --nickname builder --room <room_id> --room-password secret
ufoo online send --nickname builder --room <room_id> --text "handoff ready"
ufoo online inbox builder --unread
```

---

## Providers & Configuration

Project settings live in `.ufoo/config.json`; user-wide `ucode`, daemon, `browser`, and `mac` settings live in `~/.ufoo/config.json`. Use `/settings` in the TUI (or click the footer provider caption) to switch providers, models, custom OpenAI Chat/Responses gateways, and thinking effort (`low`, `medium`, `high`, `xhigh`, `max`).

- **Codex & OpenAI**: Defaults to `gpt-6.1-sol` (`medium` effort; `gpt-6-luna` aux model), refreshing local Codex OAuth credentials automatically.
- **Claude / Anthropic**: Defaults to `claude-opus-5-5` (`claude-haiku-5-5` aux model) with adaptive thinking and streamed thinking summaries.
- **Antigravity (`agy`)**: Select `/provider agy` in `ufoo` or `ucode --provider agy` (defaults to `gemini-4-carbon-high` and aux `gemini-4-hydrogen-high`). Automatically reuses your `agy` login from macOS Keychain / Linux Secret Service / Cloud Code auth (`UFOO_AGY_AUTH_PATH`, `UFOO_AGY_ACCESS_TOKEN`, `UFOO_AGY_PROJECT_ID` overrides supported).
- **Grok Build & Kimi Code**: Supported via `ugrok` / `grok-cli` (`grok-4.6`) and `ukimi` / `kimi-cli`.
- **Custom Gateways**: Set `agentProvider: "custom"` (or global `ucodeProvider` / `ucodeBaseUrl` / `ucodeApiKey`); uses OpenAI Chat Completions by default or OpenAI Responses when the URL ends in `/responses`.

Project `.ufoo/config.json` example:

```json
{
  "launchMode": "auto",
  "daemonTopology": "global",
  "agentProvider": "codex-cli",
  "agentModel": "",
  "agentAuxModel": "",
  "agentThinking": "medium",
  "autoResume": false
}
```

Global `~/.ufoo/config.json` (`ucode`, `browser`, and `mac` sections):

```json
{
  "ucodeProvider": "openai",
  "ucodeModel": "gpt-6.1-sol",
  "ucodeAuxModel": "",
  "ucodeBaseUrl": "https://api.openai.com/v1",
  "ucodeApiKey": "sk-...",
  "browser": { "enabled": true, "backend": "ufoo-extension" },
  "mac": { "enabled": true, "hud": true, "takeoverGuard": true }
}
```

> **Note on Internal Codex Host Access**: Embedded internal Codex SDK threads currently default to `danger-full-access`, network enabled, and `approvalPolicy: never` (bounded by your OS user permissions) so mobile simulators, Gradle/ADB daemons, and build caches work seamlessly. Relaunch existing workers after upgrading to pick up runtime policy updates.

---

## Source Layout & Development

```text
crates/ufoo-tui/        Rust ratatui terminal renderer (chat & ucode surfaces)
extensions/ufoo-browser/ Chrome MV3 extension for ufoo Browser
src/
  app/                  Chat client controller & CLI command groups (setup, browser, mac, trace, metrics...)
  ui/                   Rust TUI socket hosts, multi-pane session manager, and pure formatters
  runtime/              Global daemon, project runtimes, MCP HTTP/stdio, terminal, browser & mac runtimes
  orchestration/        Launch routing, group templates/validation, and solo role policies
  agents/               Shared runtime core, Context Engine V2, capabilities, profiles, providers, prompts
  code/                 Native ucode host, file/shell/background tools, Plan Mode, and session codecs
  coordination/         Event bus, decisions, shared memory, history, reports, and file-locked state
  tools/                Shared controller/worker MCP tool schemas and handlers
  online/               WebSocket relay server, client, rooms, and inbox helpers
SKILLS/                 Default skills (ufoo, ufoo-bus, ufoo-context, ufoo-online)
OPTIONAL_SKILLS/        Opt-in host wake skill (ufoo-bus-poll)
templates/groups/       Built-in multi-agent workflow templates
```

See [docs/PROJECT.md](docs/PROJECT.md) for full architectural invariants and package boundaries.

### Development & Testing

```bash
npm install
npm run pack:tui          # Build & stage crates/ufoo-tui into dist/tui/<platform>-<arch>/
cargo test -p ufoo-tui    # Rust TUI unit tests
npm test                  # Full Jest suite
```

Optional live integration suites:

```bash
# Real Chrome extension/CDP fixture (uses a disposable profile, never your personal profile)
UFOO_TEST_BROWSER=1 npm test -- --runTestsByPath test/integration/browser-existing-chrome.test.js

# macOS independent Agent Mouse pointer verification against a disposable AppKit window
UFOO_TEST_MAC_POINTER=1 npm test -- --runTestsByPath test/integration/mac-independent-pointer.test.js
```

### Release & Troubleshooting

- **Releases**: GitHub Actions (`.github/workflows/release.yml`) runs full CI verification, builds `ufoo-tui` across `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`, verifies package integrity, and publishes to npm on `v*` tags (`npm version patch && git push --follow-tags`).
- **Deleted Workspaces**: Preview stale project registry entries with `ufoo project prune`, and archive them to `~/.ufoo/projects/archive/` with `ufoo project prune --apply`.
- **Restricted Codex Home**: If `~/.codex` is read-only in a sandboxed environment, export `CODEX_HOME="$PWD/.ufoo/codex"` before launching `ufoo`.

## License

UNLICENSED. See [LICENSE](LICENSE).

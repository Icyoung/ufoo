# ufoo

[中文文档](README.zh-CN.md) · [Website](https://ufoo.dev) · [Architecture Guide](docs/PROJECT.md) · [Observability](docs/OBSERVABILITY.md) · [Documentation Index](docs/README.md)

**Multi-Agent Workspace Control Plane & Collaborative Coding Runtime (SDK + ACP + MCP).** Orchestrate Codex, Claude, Antigravity, Gemini CLI, OpenCode, Kimi, Goose, Grok, and native `ucode` workers across a **native macOS Desktop App**, a **Rust TUI dashboard**, and a **Zero-Knowledge E2EE Remote Web/Mobile PWA** — all backed by one local workspace daemon.

Package: [u-foo on npm](https://www.npmjs.com/package/u-foo) · Remote Web App: [online.ufoo.dev/remote](https://online.ufoo.dev/remote/)

[![npm version](https://img.shields.io/npm/v/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![npm downloads](https://img.shields.io/npm/dm/u-foo.svg)](https://www.npmjs.com/package/u-foo)
[![CI](https://github.com/Icyoung/ufoo/actions/workflows/ci.yml/badge.svg)](https://github.com/Icyoung/ufoo/actions/workflows/ci.yml)
[![macOS Desktop Build](https://github.com/Icyoung/ufoo/actions/workflows/macos-desktop.yml/badge.svg)](https://github.com/Icyoung/ufoo/actions/workflows/macos-desktop.yml)
[![License](https://img.shields.io/badge/license-UNLICENSED-red.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue.svg)](https://github.com/Icyoung/ufoo)

---

## Why ufoo v5?

ufoo gives every coding agent in your repositories a shared control plane, memory, and orchestration runtime without locking you into a single vendor CLI:

- **Native macOS Desktop App (`Ufoo.app`)**: Built with Tauri v2 + React/Tailwind and a self-contained Node + Rust runtime. Features Main / Side / Multi interactive workflow canvas layouts, live Git diff & workspace file inspector, Approval Inbox, Command Palette (`⌘K`), Back/Forward view history (`⌘[` / `⌘]`), stacked peer-agent group relay cards, file/image drag-and-drop attachments, and seamless CLI handoff (`ufoo app`).
- **Zero-Knowledge E2EE Remote Web & Mobile PWA (`ufoo remote`)**: Control and approve your local Mac sessions from your phone or any browser at `https://online.ufoo.dev/remote/<device_id>`. Pairs via one-time QR code with mutual HMAC proof + fingerprint verification, uses WebRTC P2P with relay fallback, and encrypts every frame end-to-end with ECDH P-256 + HKDF-SHA256 + AES-256-GCM.
- **Three-Layer Agent Interop (SDK + Bidirectional ACP + MCP)**:
  - **Native SDK Workers**: Embedded Codex SDK (`codex`), Claude Agent SDK (`claude`), Antigravity (`agy`), and native `ucode`.
  - **Universal ACP Client & Server**: Run any ACP-compliant CLI (`gemini`, `opencode`, `kimi`, `goose`, `grok`, or custom `acpAgents`) as a managed worker, or expose ufoo itself over ACP (`ufoo acp`, `ucode --acp`) to Zed, JetBrains, Neovim, and T3 Code.
  - **Focused Singleton MCP**: Auto-injected into managed workers and exposed to external IDEs/apps (Codex App/IDE, Cursor, Antigravity App) via one user-scoped daemon (`~/.ufoo/run/ufoo.sock`).
- **Shared Workspace & Model-Managed Git Worktrees**: Agents and groups share the live project repository directly without forced framework worktree isolation or agent-to-worktree binding. Models decide on demand whether to create git worktrees and can freely read/edit across all linked worktrees of the same repository.
- **Automatic Group Round Rollup & `read_agent_history`**: When all members of a group finish a round and queues drain, the daemon automatically aggregates every member's final-turn output and wakes `ufoo` to summarize the round; `ufoo` can also query `read_agent_history` anytime across active or archived project agents.
- **Unified Rust TUI Dashboard (`ufoo` & `ucode`)**: Fast terminal control plane (`main`, `side`, and `multi` split layouts) sharing the exact same `ufoo-ui/1` protocol and persistent background daemon (with optional macOS `launchd` supervision via `ufoo daemon service install`).
- **Native Agent Runtime & Context Engine V2**: KV-cache-stable sliding turn window, automatic `<turn_context>` topic indexing, `recall_turn` off-window transcript search, structured `plan_graph` / Plan Mode, crash-safe journals, shared-repository editing, and token-free background command auto-wake.
- **Everyday Chrome (`browser`) & macOS Desktop Automation (`mac_app`)**: Operate your signed-in Chrome via per-tab `BrowserBroker` ownership (`ufoo Browser` MV3 extension) and native macOS apps via `AXUIElement` snapshots, 1:1 logical-point screenshots, and an independent **Agent Mouse** with instant human takeover.
- **Groups, Shared Memory & Observability**: 7 built-in multi-agent workflow templates, architectural decisions (`/ctx decisions`), durable shared memory (`ufoo memory`), evidence-gated task acceptance, and zero-model `ufoo trace` / `ufoo metrics`.

---

## Installation & Requirements

### Requirements

- **macOS Desktop App**: macOS 12.0+ (Apple Silicon `arm64` or Intel `x64`, self-contained `.dmg` bundles Node.js and `ufoo-tui`).
- **CLI / TUI**: **Node.js 18.17+** (`ufoo Browser` Playwright MCP runtime requires **Node.js 20+**), **macOS** or **Linux** (prebuilt `ufoo-tui` binaries bundled for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`).
- Corresponding vendor CLIs/accounts installed for the agents you want to run (`codex`, `claude`, `agy`, `gemini`, `opencode`, `kimi`, `goose`, `grok`).

### Option 1: macOS Desktop App (`.dmg`)

Download the latest Apple Silicon (`arm64`) or Intel (`x64`) installer from [GitHub Releases](https://github.com/Icyoung/ufoo/releases), drag `Ufoo.app` into `/Applications`, and optionally install CLI shims (`ufoo`, `ucode`) from Settings or via:

```bash
ufoo app --install-cli --zshrc
```

> If launching an unsigned preview build on macOS, right-click `Ufoo.app` → **Open** once (or run `xattr -dr com.apple.quarantine /Applications/Ufoo.app`).

### Option 2: Install CLI & TUI from npm

```bash
npm install -g u-foo
ufoo setup
```

`ufoo setup` interactively configures optional components such as **ufoo Browser** (`ufoo setup --browser=install` or `--browser=skip`).

### Option 3: Build from Source

```bash
git clone https://github.com/Icyoung/ufoo.git
cd ufoo
npm install
npm --prefix apps/desktop ci
npm run pack:tui          # Build & stage Rust TUI binary
npm link                  # Link ufoo & ucode globally

# Optional: stage & build macOS Desktop binary (requires Rust + Xcode CLI tools)
npm run pack:desktop
```

### Installed Binaries

Legacy PTY CLI wrappers (`uclaude`, `ucodex`, `uagy`, `ugrok`, `ukimi`) and `node-pty` were removed in v5 in favor of native SDKs, ACP, and MCP.

| Binary | Responsibility |
|---|---|
| `ufoo` | Main CLI, Rust TUI dashboard, Desktop App handoff (`ufoo app`), ACP Server (`ufoo acp`), E2EE remote pairing (`ufoo remote`), global/project daemon (`ufoo daemon`), MCP server & stdio proxy, `browser` & `mac` managers, groups, bus, context, memory, reports, and trace/metrics. |
| `ucode` | Native ufoo coding-agent CLI/TUI and standalone ACP Server (`ucode --acp`) powered by the shared runtime, Context Engine V2, `browser`, and `mac_app`. |

---

## Quick Start

### 1. Open in Desktop App or Rust TUI

```bash
cd your-project
ufoo init --targets context,bus
ufoo app      # Hand off workspace to Ufoo Desktop (macOS)
ufoo          # Or open the Rust TUI dashboard in your terminal
ufoo -g       # Or open the global multi-project router
```

Inside chat (Desktop or TUI), work with the main agent or spawn managed workers and teams:

```text
> /launch codex reviewer
> /launch claude builder
> /launch agy researcher
> /launch acp:opencode refactor
> @reviewer inspect the current diff and list release risks
> /group run build-lane instance=auth-refactor
```

### 2. Pair Your Phone or Remote Browser (Zero-Knowledge E2EE)

Open **Settings → Remote Access** in Ufoo Desktop, or run from CLI:

```bash
ufoo remote pair          # Prints terminal QR code, 8-char code & personal /remote/<device_id> URL
ufoo remote status        # Show relay state, device fingerprint, and personal URL
ufoo remote devices       # List paired browsers / phones
ufoo remote revoke <id>   # Immediately revoke a paired device
```

Scan the QR code on your phone or visit `https://online.ufoo.dev/remote/<device_id>` — all traffic is encrypted end-to-end between your Mac and browser (`ECDH P-256 + HKDF-SHA256 + AES-256-GCM`) with WebRTC P2P and zero-knowledge relay fallback.

### 3. Connect External Editors & Agents via ACP or MCP

- **ACP Hosts (Zed, JetBrains, Neovim, T3 Code)**:
  ```bash
  ufoo acp                  # Expose ufoo project main agent over ACP stdio
  ucode --acp               # Expose standalone ucode over ACP stdio
  ```
- **Codex App, Codex CLI & Codex IDE Extension** (authenticated Streamable HTTP MCP):
  ```bash
  ufoo -g
  ufoo mcp configure codex  # Use --dry-run to preview with redacted credentials
  ```
- **Cursor, Antigravity App & Other MCP Hosts** (stateless stdio proxy):
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

### 4. Keep the Local Daemon Running on macOS (`launchd`)

```bash
ufoo daemon service install
ufoo daemon service status
ufoo daemon service restart
ufoo daemon service uninstall
```

---

## Desktop App & Rust TUI Guide

Both `Ufoo.app` and the Rust `ufoo-tui` terminal client speak the same `ufoo-ui/1` protocol over Unix sockets (or E2EE remote frames). Long-running work lives inside the daemon — closing the app or terminal never cancels active runs, and reconnecting replays full live transcripts and tool trees.

### Layouts & Shortcuts

Cycle three workspace views (`main → side → multi`):
- **Main**: Full-width active conversation (Project Main, Global Router, or single Worker view).
- **Side**: Project Main on the left + active Worker pane on the right.
- **Multi**: Interactive multi-agent workflow canvas / split view across all active workers.

| Surface | Shortcut | Behavior |
|---|---|---|
| Desktop | `⌘K` | Open Command Palette (jump to projects, agents, or actions). |
| Desktop | `⌘[` / `⌘]` (or `Alt+←` / `Alt+→`) | Navigate Back / Forward across visited workspace & agent views. |
| Desktop | `⌘B` / `⌘⌥B` | Toggle Left Sidebar / Right Workspace Inspector (Git diffs, files, docs). |
| TUI | `Ctrl+W` / `Ctrl+Q` | Cycle `main → side → multi` layouts / return to `main`. |
| TUI | `Tab` / `Esc` | Switch between visible panes or return focus to `main` without cancelling work. |
| TUI | `Ctrl+O` | Expand/collapse the latest thinking or merged tool-call tree. |
| TUI | `Ctrl+C` / `Ctrl+X` | Cancel focused worker turn (`Ctrl+C`) or close selected worker (`Ctrl+X`). |

### Essential Slash Commands

```text
/status                         Project, daemon, and active agent summary
/launch <agent> [nickname]      Spawn an embedded SDK or ACP worker (codex, claude, agy, ucode, acp:<id>)
/resume                         Resume saved internal workers or whole groups (group:<id>)
/task list | inspect | cancel   List or inspect tasks, or cancel a session run
/answer <interaction-id> <text> Reply to a paused ask_user interaction
/session show | new             Inspect or start a fresh main conversation
/settings                       Configure provider, custom gateway, model, and thinking effort
/group templates | run | status Orchestrate multi-agent group workflows
/ctx status | decisions | doctor Inspect architectural decisions and context health
/bus status | list | send       Inspect bus queues and message registered agents
/project list | switch <n>      Switch workspaces in global/multi-project mode
/open /path/to/project          Open and attach another project directory
/doctor                         Diagnose CLI versions, ACP runtimes, and MCP configuration
```

---

## Native Agent Runtime & `ucode`

`ufoo`'s project main agent and `ucode` share a layered, capability-composed runtime (`src/agents/runtime/`).

### Context Engine V2 & `recall_turn`

- **KV-Cache-Stable Sliding Window**: Retains a `Step=2` aligned raw turn window (5 turns by default, expanding up to 10 on active topics within a 45% context budget) so system prefixes and historical turns stay cache-hit friendly.
- **Ephemeral `<turn_context>` Injection**: Attaches a compact `<topic_map>` and `<relevant_turns>` digest to the current user turn without polluting persisted transcripts.
- **Optional Background Aux Enrichment**: When `agentAuxModel` or `ucodeAuxModel` is configured, an asynchronous Phase B enricher refines turn summaries and Tier 2 topic selection off the critical path (zero extra model calls when unconfigured).
- **Deterministic Overflow Eviction & `recall_turn`**: Tight context budgets trigger a deterministic Level 1–3 eviction ladder instead of blocking LLM compaction calls, while `recall_turn` searches off-window turns or paginates full raw transcripts on demand.

### Plan Mode, Execution Budgets & Shared Editing

- **Plan Mode & `plan_graph`**: Enable with `/plan on` (or automatically via `plan_graph create`). Blocks direct mutating calls while permitting inspection tools and advancing structured `plan_graph` nodes. Leave with `/plan off`.
- **Execution & Loop Guards**: Model turns and tool calls are unbounded by default within a 12-hour task deadline (configurable via `ucode --max-tool-calls <N|none>`, `UFOO_UCODE_MAX_TOOL_CALLS`, `UFOO_UCODE_MAX_TOOL_ERRORS`, and `UFOO_UCODE_TASK_TIMEOUT_MS`). Consecutive tool failures warn at 3 and stop at 5 (or 12 of the last 20); repeated identical tool batches halt runaway loops.
- **Crash Safety & Shared-Repo Collaboration**: Completed turns commit atomically before the next model request. Multiple agents share the repository directly without whole-repo write locks, relying on coordinator task partitioning to avoid overlapping file edits (and optional `git worktree` checkouts when isolation is desired).

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

Supported one-shot conditions: `log_contains`, `file_exists`, `port_open` (`127.0.0.1`), plus process exit (`wake.onExit`, enabled by default).

### Agent Skills

Default skills (`ufoo`, `ufoo-bus`, `ufoo-context`, `ufoo-online`) link automatically on `postinstall` without overwriting user-owned files:

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

Available out of the box in the `ufoo` main agent and `ucode`. Multimodal screenshots attach automatically as provider vision blocks and retire cleanly after viewing.

### 1. Everyday Chrome (`browser` / `ufoo browser`)

Connects to your existing, authenticated Chrome via Playwright MCP (requires **Node.js 20+**) — preserving logins and cookies without ever launching an empty profile or closing Chrome on disconnect:

```bash
ufoo setup --browser=install     # Install optional Playwright MCP runtime + Native Messaging host
ufoo browser install --dev       # Load unpacked extension from extensions/ufoo-browser/
ufoo browser status [--json]
ufoo browser doctor
ufoo browser enable | disable | update | uninstall
```

- **Per-Tab Ownership via `BrowserBroker`**: The `ufoo Browser` MV3 extension connects over Chrome Native Messaging to `~/.ufoo/browser/private/broker.sock`. Agents claim specific `tabId`s; tabs owned by another session return `browser_tab_busy` without preemption.
- **Compatibility Modes**: Supports the official Playwright Extension (`backend: "playwright-extension"`) and explicit CDP endpoints (`UFOO_BROWSER_CDP_ENDPOINT`).

### 2. macOS Desktop Apps & Independent Agent Mouse (`mac_app` / `ufoo mac`)

Operates native Cocoa, SwiftUI, Catalyst, and Electron apps on macOS through a cached, zero-dependency Swift helper (`~/.ufoo/mac/bin/`):

- **Structured Accessibility (`AXUIElement`)**: `list_apps`, `list_windows`, `snapshot` (`@e1..@eN` refs, `includeMenuBar=true`, `query` filtering), `ax_action`, `launch_app`, `focus_app`, and `manage_window`.
- **1:1 Logical-Point Screenshots**: Shadowless window (`-o -l`), region, or full-display capture scaled to 1:1 macOS logical points with `screenshotId` coordinate mapping (no Retina `2x` drift).
- **Independent Agent Mouse & Human Yield**: Dispatches window-targeted `NSEvent` / `CGEvent.postToPid` input with a non-capturable floating **Agent Mouse HUD** without moving your physical cursor; yields immediately on mouse shake, target-window click, or `Esc`.

```bash
ufoo mac status [--json]         # Inspect helper state, displays, and TCC permissions
ufoo mac permissions             # Prompt & open macOS Accessibility + Screen Recording settings
ufoo mac doctor                  # Verify Swift helper build, daemon socket RPC, and permissions
ufoo mac hud on | off | toggle   # Toggle on-screen Agent Mouse visual indicator
ufoo mac enable | disable | stop
```

---

## Architecture & Multi-Agent Orchestration

```text
Surfaces:
  Ufoo.app (Tauri v2 + React) ──┐
  ufoo / ucode (Rust ufoo-tui) ─┼──(ufoo-ui/1)──> desktopUiHost / rustChatHost
  Web/Mobile PWA (E2EE P2P/WS) ─┘                     │
                                                      v
                                    GlobalDaemon (~/.ufoo/run/ufoo.sock)
                                      ├── Isolated ProjectRuntime per workspace
                                      ├── Managed Workers: Codex SDK · Claude SDK · agy · ucode · ACP Client
                                      ├── Smart Git Worktree Manager & Group Orchestrator (7 templates)
                                      ├── Singleton Streamable HTTP MCP + ufoo mcp stdio proxy
                                      └── .ufoo/ state (bus, decisions, memory, history, reports, journals)

External ACP Hosts (Zed / JetBrains / Neovim) ──(ufoo acp / ucode --acp)──> ProjectRuntime
```

### Built-In Group Templates (`templates/groups/`)

Launch coordinated multi-agent pipelines (`build-lane`, `build-ultra`, `design-system`, `product-discovery`, `ui-plan-review`, `ui-polish`, `verify-ship`) directly from Desktop, TUI, or CLI:

```text
/group templates
/group template show build-lane
/group run build-lane dry_run=true
/group run build-lane instance=release-v5
/group status
/group diagram build-lane mermaid
/group stop release-v5
```

### Decisions, Shared Memory, Reports & Observability

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

# Offline end-to-end tracing & metrics (no model calls required)
ufoo trace <task-id> --json
ufoo trace --agent <id-or-nickname> --follow
ufoo metrics --json > baseline.json
ufoo metrics --baseline baseline.json --json
```

Read-only MCP equivalents: `read_agent_trace` and `read_agent_metrics`. See [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md).

---

## Providers & Configuration

Project settings live in `.ufoo/config.json`; user-wide `ucode`, daemon, `browser`, `mac`, and `remote` settings live in `~/.ufoo/config.json` and `~/.ufoo/remote/`.

- **Codex / OpenAI**: Embedded `@openai/codex-sdk` with automatic Codex OAuth refresh.
- **Claude / Anthropic**: Embedded `@anthropic-ai/claude-agent-sdk` with adaptive thinking and streamed thinking summaries.
- **Antigravity (`agy`)**: Native `agy` thread provider reusing macOS Keychain / Linux Secret Service / Cloud Code auth (`UFOO_AGY_AUTH_PATH`, `UFOO_AGY_ACCESS_TOKEN`, `UFOO_AGY_PROJECT_ID` overrides supported).
- **Universal ACP Agents**: Built-in presets for `gemini`, `opencode`, `kimi`, `goose`, and `grok`, plus custom entries via `acpAgents` in config.
- **Custom OpenAI-Compatible Gateways**: Set `agentProvider: "custom"` (or global `ucodeProvider` / `ucodeBaseUrl` / `ucodeApiKey`); automatically uses OpenAI Responses when the URL ends in `/responses`.

Project `.ufoo/config.json` example:

```json
{
  "daemonTopology": "global",
  "groupAutoSummarize": true,
  "agentProvider": "codex-cli",
  "agentModel": "",
  "agentAuxModel": "",
  "agentThinking": "medium",
  "autoResume": false,
  "acpAgents": []
}
```

Global `~/.ufoo/config.json` example:

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

---

## Source Layout & Development

```text
apps/desktop/           React + TypeScript + Tailwind UI (Desktop App & Remote Web/Mobile PWA)
crates/
  ufoo-desktop/         Tauri v2 macOS Desktop host (Ufoo.app + self-contained runtime staging)
  ufoo-tui/             Rust ratatui terminal renderer (chat & ucode surfaces)
extensions/ufoo-browser/ Chrome MV3 extension for ufoo Browser
src/
  app/                  Chat client controller & CLI command groups (app, remote, setup, browser, mac, trace, metrics...)
  ui/                   Desktop UI host, E2EE remote relay bridge, Rust TUI hosts, workspace/git inspector
  runtime/              Global daemon, launchd service, project runtimes, MCP HTTP/stdio, worktree manager, browser & mac runtimes
  orchestration/        Launch routing, group workflow graphs/templates, and solo role policies
  agents/               Shared runtime core, Context Engine V2, capabilities, profiles, SDK/ACP providers, prompts
  code/                 Native ucode host, file/shell/background tools, Plan Mode, and session codecs
  coordination/         Event bus, decisions, shared memory, history, reports, and file-locked state
  tools/                Shared controller/worker MCP tool schemas and handlers
  online/               Zero-Knowledge E2EE relay server, crypto primitives, QR generator & PWA host
SKILLS/                 Default skills (ufoo, ufoo-bus, ufoo-context, ufoo-online)
OPTIONAL_SKILLS/        Opt-in host wake skill (ufoo-bus-poll)
templates/groups/       Built-in multi-agent workflow templates
```

See [docs/PROJECT.md](docs/PROJECT.md) for full architectural invariants and package boundaries.

### Development & Testing

```bash
npm install
npm --prefix apps/desktop ci
npm run pack:tui            # Build & stage crates/ufoo-tui into dist/tui/<platform>-<arch>/
npm run desktop:ui:build    # Typecheck & build apps/desktop UI
cargo test -p ufoo-tui      # Rust TUI unit tests
npm test                    # Full Jest suite
```

### CI, Releases & macOS Builds

- **CI (`.github/workflows/ci.yml`)**: Runs the Jest test suite on Node 18/20/22 (Ubuntu & macOS), builds & tests `ufoo-tui`, and builds `apps/desktop`.
- **macOS Desktop Build (`.github/workflows/macos-desktop.yml`)**: Automatically builds self-contained Apple Silicon (`arm64`) and Intel (`x64`) `Ufoo.app` + `.dmg` installers when desktop files change on `master`, on manual `workflow_dispatch`, or on `v*` tags (where `.dmg` installers and `SHA256SUMS.txt` are attached to the GitHub Release). Configure `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, and `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` repository secrets to enable Developer ID signing and notarization; otherwise builds are cleanly ad-hoc signed.
- **npm Release (`.github/workflows/release.yml`)**: Runs full CI, compiles `ufoo-tui` across `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64`, verifies package integrity, and publishes `u-foo` to npm on `v*` tags (`npm version patch && git push --follow-tags`).

### Troubleshooting

- **Deleted Workspaces**: Preview stale project registry entries with `ufoo project prune`, and archive them to `~/.ufoo/projects/archive/` with `ufoo project prune --apply`.
- **Restricted Codex Home**: If `~/.codex` is read-only in a sandboxed environment, export `CODEX_HOME="$PWD/.ufoo/codex"` before launching `ufoo`.

## License

UNLICENSED. See [LICENSE](LICENSE).

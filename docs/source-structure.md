# Source Structure

This document records the current `src/` package layout after the old
compatibility directories were removed. New code should import from these
source-of-truth packages directly.

## Current Layout

| Directory | Responsibility |
|---|---|
| `src/app/chat/` | Chat client state, slash-command execution, daemon connection, multi-window panes, chat history, and agent selection helpers. |
| `src/app/cli/` | Main CLI runner, command groups, and CLI features such as init, doctor, and skills. |
| `src/ui/ink/` | Ink components for chat and `ucode` TUI. |
| `src/ui/format/` | Pure formatting, banners, width, markdown, status, and input helper functions. |
| `src/runtime/daemon/` | Project daemon, global MCP bridge, IPC server, prompt routing, launch/resume/close, cron, group orchestration, reports, and status. |
| `src/runtime/projects/` | Project identity and runtime registry. |
| `src/runtime/process/` | Runtime process helpers such as Node executable resolution. |
| `src/runtime/privacy/` | Secret redaction and shadow-diff privacy/safety helpers. |
| `src/runtime/terminal/` | Host, tmux, internal, and external terminal adapters. |
| `src/runtime/contracts/` | IPC event, PTY socket, and MCP/JSON-RPC contracts. |
| `src/agents/prompts/` | Agent bootstrap prompts, group prompts, profile prompts, and native `ucode` system prompt sections. |
| `src/agents/providers/` | Claude/Codex provider seams, event translators, credentials, direct auth, and upstream transports. |
| `src/agents/launch/` | External CLI launchers, PTY runner/wrapper, notifier, launch environment, and Agy session helpers. |
| `src/agents/internal/` | SDK-backed embedded internal runner. |
| `src/agents/activity/` | Ready/activity detectors, state writer/publisher, and activity tracker. |
| `src/agents/controller/` | `ufoo-agent` router/controller, loop runtime, observability, and controller tool executor. |
| `src/code/` | Native `ucode` agent loop, native provider runner, session store, skills, and native file/shell tools. |
| `src/code/launcher/` | `ucode` launch resolution, bootstrap file generation, doctor/build/runtime config helpers. |
| `src/orchestration/controller/` | Gate/main/global/loop router payload logic, flags, launch routing, fast path, finalization, and shadow guard. |
| `src/orchestration/groups/` | Group templates, diagrams, validation, prompt profiles, and group bootstrap planning. |
| `src/orchestration/solo/` | Solo role command helpers. |
| `src/coordination/bus/` | Event bus, queues, injection, envelopes, nicknames, subscribers, and bus daemon. |
| `src/coordination/context/` | Decisions, context sync, and context doctor. |
| `src/coordination/memory/` | Durable memory and history search. |
| `src/coordination/history/` | Prompt/input timeline. |
| `src/coordination/report/` | Report and controller inbox store. |
| `src/coordination/state/` | `.ufoo` path resolution, agent registry persistence, and registry diagnostics. |
| `src/coordination/status/` | Status aggregation/display. |
| `src/tools/` | Shared controller/worker tool registry and handlers. |
| `src/online/` | Online relay client/server/runner and token helpers. |
| `src/config.js` | Project/global configuration loading and normalization. |

Removed historical directories:

```text
src/agent
src/bus
src/chat
src/cli
src/context
src/controller
src/daemon
src/group
src/history
src/memory
src/projects
src/report
src/solo
src/status
src/terminal
src/ui/components
src/code/prompts
src/code/config
src/doctor
src/init
src/providerapi
src/shared
src/skills
src/ufoo
src/utils
```

The old shared contract shims `src/shared/eventContract.js` and
`src/shared/ptySocketContract.js` were also removed; use
`src/runtime/contracts/`. Markdown rendering now lives in `src/ui/format/`.

## Dependency Direction

Recommended dependency flow:

```text
app -> ui
app -> runtime -> coordination
app -> orchestration -> agents
runtime -> orchestration -> agents/providers
agents -> coordination
agents -> runtime/contracts
coordination -> runtime/privacy
ui -> app callbacks and ui/format
```

Rules:

- UI may render state and call injected callbacks; it should not launch agents
  or write bus queues directly.
- Runtime may call orchestration, coordination, and agent launchers; it should
  not import Ink components.
- Prompt builders should not import UI or daemon implementations.
- Provider adapters should not know about chat commands.
- Runtime contracts should not import feature modules.

## Package Notes

- `src/code/` remains intentionally intact for native `ucode`. Splitting it into
  a future `src/agents/native-ucode/` shape should be a separate, smaller change.
- Tests may keep their existing `test/unit/chat`, `test/unit/daemon`, and similar
  names as historical coverage categories, but their imports should point to the
  current source directories.
- Active docs should use the current paths above. Archived plan docs can keep
  historical paths as context.

## Focused Checks

| Change type | Minimum checks |
|---|---|
| Prompt move | `npm test -- --runTestsByPath test/unit/code/ucodeTui.test.js test/unit/group/templates.test.js test/unit/group/promptProfiles.test.js` |
| Tool registry move | `npm test -- --runTestsByPath test/unit/tools/registry.test.js test/unit/tools/handlers.test.js test/unit/agent/controllerToolExecutor.test.js` |
| MCP bridge change | `npm test -- --runTestsByPath test/unit/daemon/mcpServer.test.js test/unit/tools/registry.test.js test/unit/shared/eventContract.test.js` |
| Agent runner move | `npm test -- --runTestsByPath test/unit/agent/internalRunner.test.js test/unit/agent/ptyRunner.test.js test/unit/agent/launcher.test.js` |
| Runtime/app move | `npm test -- --runTestsByPath test/unit/ui/ChatApp.test.js test/unit/daemon/run.test.js test/unit/chat/daemonConnection.test.js` |
| Large package move | Full `npm test`. |

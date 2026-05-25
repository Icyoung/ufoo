# Project Instructions (Codex + Claude Code)

`CLAUDE.md` is a symlink to this file. Prefer edits in `AGENTS.md`.

## Project Map

Start with `PROJECT.md` for the short project guide.

Architecture references live in `README.md`, `PROJECT.md`, and the source
packages listed below. The local `docs/` directory is ignored and should not be
treated as a repository source of truth.

## Source Boundaries

- Chat client code lives in `src/app/chat/`; CLI command groups live in
  `src/app/cli/`; Ink components live in `src/ui/ink/`; pure formatting helpers
  live in `src/ui/format/`.
- The project daemon, project registry, terminal adapters, and IPC contracts
  live in `src/runtime/`; routing/group/solo orchestration lives in
  `src/orchestration/`.
- Agent launchers, internal runners, provider seams, activity tracking,
  controller loop code, and prompt/bootstrap code live in `src/agents/`.
- Native `ucode` prompt/tool/runtime code lives in `src/code/`; wrapper launch,
  bootstrap, doctor, build, and runtime-config helpers live in
  `src/code/launcher/`.
- Shared controller/worker tools live in `src/tools/`; native `ucode` file and
  shell tools live in `src/code/tools/`.
- Event bus, decisions, memory, history, reports, and status live in
  `src/coordination/`.
- Group templates, prompt profiles, and solo role helpers live in
  `src/orchestration/groups/`, `src/orchestration/solo/`, and
  `templates/groups/`.
When moving packages, update `PROJECT.md` or `README.md` if the public source
map changes.

## Prompt And Tool Changes

Before changing agent prompts, bootstrap text, prompt profiles, router schemas,
or tool-call definitions, read the relevant source packages below.

Keep these sources in sync:

- `src/agents/prompts/`
- `src/agents/providers/`
- `src/agents/internal/`
- `src/agents/launch/`
- `src/agents/activity/`
- `src/agents/controller/`
- `src/agents/prompts/native/` and
  `src/agents/prompts/native/toolDescriptions/`
- `src/code/launcher/`
- `src/orchestration/controller/`
- `src/orchestration/groups/`
- `src/orchestration/solo/`
- `src/coordination/bus/`
- `src/coordination/context/`
- `src/coordination/memory/`
- `src/coordination/history/`
- `src/coordination/report/`
- `src/coordination/status/`
- `src/runtime/daemon/`
- `src/runtime/projects/`
- `src/runtime/terminal/`
- `src/runtime/contracts/`
- `src/app/chat/`
- `src/app/cli/`
- `src/ui/ink/`
- `src/tools/schemaFixtures.js` and `src/tools/registry.js`
- `src/code/nativeRunner.js` and `src/code/tools/`

The old compatibility directories have been removed. Do not reintroduce
`src/agent/`, `src/chat/`, `src/cli/`, `src/daemon/`, `src/bus/`, or similar
top-level compatibility packages; add implementation directly to the current
source-of-truth package.

## Verification

Useful focused checks:

```sh
npm test -- --runTestsByPath test/unit/code/ucodeTui.test.js
npm test -- --runTestsByPath test/unit/ui/ChatApp.test.js
npm test -- --runTestsByPath test/unit/tools/registry.test.js
npm test -- --runTestsByPath test/unit/agent/internalRunner.test.js
node -e "require('./src/app/chat'); require('./src/ui/ink/ChatApp'); require('./src/code/tui'); console.log('ok')"
```

Run full `npm test` for broad agent, daemon, prompt, or package-move changes.

# Global Chat Phase B0 Spike - Impact List & Patch Strategy

Date: 2026-03-06  
Owner: codex-6
Status: historical

## Spike Goal

Validate that chat runtime can switch daemon connection across projects without restarting TUI.

## Prototype Scope (Implemented)

- Added chat command surface: `/project list`, `/project current`, `/project switch <index|path>`.
- Added transactional daemon connection switch:
  - Connect target daemon first.
  - Keep old connection alive on failure.
  - Swap active connection only after target connect succeeds.
- Added daemon transport target abstraction:
  - `connectClientForTarget(...)`
  - `setTarget(...)` / `getTarget(...)`

## What Works in B0

- Connection hot-switch is available in chat runtime.
- `requestStatus` after switch comes from target daemon.
- Switch failures do not drop current active connection.

## Impact List (for full Phase B/C)

1. `src/chat/index.js`
- Current code still has many closures bound to initial `projectRoot` (bus file reads, inject socket paths, activator roots, chat history path).
- For full global mode, these need to consume `activeProjectRoot` dynamically.

2. `src/chat/chatLogController.js` + history paths
- History currently persists to initial project `.ufoo/chat/history.jsonl`.
- Full multi-project behavior needs per-project history source switching and per-project draft state.

3. `src/chat/dashboardView.js` + `src/chat/layout.js` + `src/chat/dashboardKeyController.js`
- Current spike uses command-only switching.
- Full UX requires two-line dashboard, project rail focus state, and arrow-key interaction routing.

4. `src/chat/commandExecutor.js`
- `/project` commands currently consume callbacks from `index.js`.
- For maintainability, project operations should be extracted into dedicated project controller/service module.

5. `src/chat/inputListenerController.js`
- Keybinding arbitration needed for global projects focus vs existing agents/mode/provider views.

## Patch Strategy for Next Phases

1. Introduce `ChatProjectContext` object
- Owns `activeProjectRoot`, `selectedProjectIndex`, drafts, and history source.
- Replace direct `projectRoot` closures with context getters in dependent modules.

2. Split daemon switching into controller
- New `projectSwitchController` to orchestrate:
  - registry lookup
  - daemon ensure-start
  - `daemonCoordinator.switchProject`
  - history/draft context swap

3. Add layout flag for global mode
- `createChatLayout({ globalMode })` to compute two-line dashboard geometry.

4. Extend dashboard state machine
- Add `projects` view and focus transitions:
  - input `↓` -> projects focus
  - projects `←/→` -> switch
  - projects `↑` -> input focus

5. Add integration tests
- Add tests for:
  - switch success and rollback failure
  - per-project draft restore
  - status updates after rapid switch sequences

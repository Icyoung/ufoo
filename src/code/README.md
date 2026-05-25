# ucode Native Core (WIP)

`src/code/` is the self-developed core area for `ucode`.

`ucode` NL core and TUI/runtime orchestration are implemented in `src/code/`.

## Current native scope (phase 1)

- Tool kernel:
  - `read`
  - `write`
  - `edit`
  - `bash`
- Interactive agent loop:
  - `ucode> ...` free-form task input routes to model-backed planner path
  - `tool/run` commands stay available as deterministic fallback
- Dispatcher: `runToolCall({ tool, args }, { workspaceRoot })`
- Queue runtime internals:
  - `submitTask`
  - `runOnce`
  - `listResults`

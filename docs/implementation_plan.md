# Implementation Plan - ufoo Chat Log Copy Support

Provide a simple, reliable way to copy and inspect logs in `ufoo chat` without being interrupted by terminal refreshes.

All modifications will be done inside the newly created worktree at:
`/Users/icy/Code/ufoo/.claude/worktrees/chat-log-copy/`

## Proposed Changes

### 1. Command Definition

#### [MODIFY] [commands.js](file:///Users/icy/Code/ufoo/.claude/worktrees/chat-log-copy/src/app/chat/commands.js)
- Add `/copy` to `COMMAND_TREE` with subcommands/options:
  - `all`: Copy all logs (default).
  - `<number>`: Copy the last N lines of logs.
  - `open`: Write logs to a temp file and open in the default system text editor.

### 2. Command Execution

#### [MODIFY] [commandExecutor.js](file:///Users/icy/Code/ufoo/.claude/worktrees/chat-log-copy/src/app/chat/commandExecutor.js)
- Add option `copyLog` callback to `createCommandExecutor` options.
- Add `case "copy"` to `executeCommand` to parse arguments (`all`, number, or `open`) and delegate to `copyLog`.

### 3. Log Extraction & Clipboard Logic

#### [MODIFY] [index.js](file:///Users/icy/Code/ufoo/.claude/worktrees/chat-log-copy/src/app/chat/index.js)
- Implement `copyLog({ mode, lines })` function:
  - Retrieve raw content from `logBox.content`.
  - Strip blessed formatting (`stripBlessedTags`) and ANSI escapes (`stripAnsi`).
  - If mode is `open`:
    - Save clean log content to a temporary file using `os.tmpdir()` (e.g., `ufoo-chat-log-<timestamp>.txt`).
    - Open the file using the default system text editor (`open -t` on macOS, `start` on Windows, `xdg-open` on Linux).
    - Display a success status message.
  - If mode is `all` or `lines`:
    - Slice the log to get the last N lines if requested.
    - Write the content to the system clipboard using a platform-specific command (`pbcopy` on macOS, `clip` on Windows, `xclip` on Linux).
    - Display a success status message.
- Pass `copyLog` to `createCommandExecutor` options.
- Register global keyboard shortcuts for `M-c` (Option+C) and `C-y` to trigger copying the entire log to clipboard.

## Verification Plan

### Automated Tests
- We will add unit tests in `test/unit/chat/commandExecutor.test.js` or `test/unit/chat/index.test.js` to ensure the new `/copy` command is parsed and routed correctly.

### Manual Verification
- Launch the TUI in the worktree workspace (`node bin/ufoo.js chat`).
- Generate some logs.
- Run `/copy` in the input bar and verify that the logs are copied to the system clipboard.
- Run `/copy 5` to copy the last 5 lines and verify.
- Run `/copy open` and verify that the logs are exported to a text file and opened in the default text editor.
- Press `M-c` or `C-y` and verify that the entire log is copied.

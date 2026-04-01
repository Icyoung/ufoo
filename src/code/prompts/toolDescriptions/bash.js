"use strict";

const BASH_TOOL_NAME = "bash";

function getBashToolDescription() {
  return `Run a single shell command in the workspace directory.

Usage notes:
- Default timeout is 60 seconds. Use timeoutMs to adjust for longer operations.
- Do NOT use bash for file operations when a dedicated tool exists:
  - Use read instead of cat/head/tail.
  - Use write instead of echo/cat heredoc.
  - Use edit instead of sed/awk.
- Use absolute paths when possible. The working directory resets between calls.
- Do not run long-running processes (dev servers, watchers, interactive apps). Suggest the user run these manually.
- For git commands: prefer new commits over amending, never skip hooks (--no-verify) unless explicitly asked.
- Quote file paths that contain spaces with double quotes.
- When chaining commands: use && for sequential dependent commands, ; when you don't care if earlier commands fail.`;
}

module.exports = { BASH_TOOL_NAME, getBashToolDescription };

"use strict";

const BASH_TOOL_NAME = "bash";

function getBashToolDescription() {
  return `Run a single shell command in the workspace directory.

Usage notes:
- Default timeout is 60 seconds. Use timeoutMs to adjust for longer operations (maximum 600 seconds; larger values are clamped).
- Do NOT use bash for file operations when a dedicated tool exists:
  - Use read instead of cat/head/tail.
  - Use write instead of echo/cat heredoc.
  - Use edit instead of sed/awk.
- Use absolute paths when possible. The working directory resets between calls.
- Long-running processes (dev servers, watchers, local preview servers):
  - Start them with \`background: true\` (optional \`startupWaitMs\`, default 2500ms). This returns \`backgroundId\`, \`pid\`, \`running\`, \`logPath\`, \`nextOffset\`, and initial \`logOutput\` (such as bound ports/URLs or startup errors).
  - Observe background output anytime with \`action: "logs"\` and \`backgroundId\`: pass \`offset: <previous nextOffset>\` for incremental new logs, or omit \`offset\` (optionally with \`tailLines\`) to inspect recent lines; use \`waitMs\` to briefly wait for new output.
  - Manage lifecycle with \`action: "status"\`, \`action: "list"\`, and \`action: "stop"\` (with \`backgroundId\`).
  - Supported native hosts automatically notify your session when a background command exits. Use \`wake: {conditions: [{type: "log_contains", text: "ready"}]}\` for a literal log match, \`file_exists\` with a workspace \`path\`, or \`port_open\` with a local \`port\`. Each condition fires once; \`wake.onExit: false\` disables the exit notification. A registered wake is reported in the tool result.
  - After registering a wake, you may finish the foreground turn or do other work. Do not poll logs repeatedly just to keep the agent alive. Notifications resume the original session at a turn boundary and do not answer pending user questions. Stop/cancellation revokes the task's subscriptions. Runtime events never authorize replaying a command.
  - Still do NOT run interactive full-screen TTY apps (vim, nano, top, less) that require keyboard input.
- For git commands: prefer new commits over amending, never skip hooks (--no-verify) unless explicitly asked.
- Quote file paths that contain spaces with double quotes.
- When chaining commands: use && for sequential dependent commands, ; when you don't care if earlier commands fail.`;
}

module.exports = { BASH_TOOL_NAME, getBashToolDescription };

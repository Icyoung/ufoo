"use strict";

const WRITE_TOOL_NAME = "write";

function getWriteToolDescription() {
  return `Write content to a file in the workspace.

Usage notes:
- Overwrites the existing file by default. Use append: true to append instead.
- Prefer the edit tool for modifying existing files — it only sends the diff and is less error-prone.
- Parent directories are created automatically if they don't exist.
- Do not create documentation files (*.md, README) unless explicitly requested by the user.
- Never write files that contain secrets or credentials.`;
}

module.exports = { WRITE_TOOL_NAME, getWriteToolDescription };

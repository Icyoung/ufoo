"use strict";

const READ_TOOL_NAME = "read";

function getReadToolDescription() {
  return `Read a text file from the workspace.

Usage notes:
- The path parameter is relative to the workspace root.
- By default reads the entire file. For large files, use startLine and endLine to read specific ranges.
- Use maxBytes to limit the amount of data returned (default ~200KB).
- Cannot read directories — use bash with \`ls\` for that.
- Always read a file before editing it to understand its current content and structure.
- Results are returned with line numbers for easy reference.`;
}

module.exports = { READ_TOOL_NAME, getReadToolDescription };

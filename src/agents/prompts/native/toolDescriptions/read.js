"use strict";

const READ_TOOL_NAME = "read";

function getReadToolDescription() {
  return `Read a text file from the workspace.

Usage notes:
- The path parameter is relative to the workspace root.
- By default reads the entire file. Files larger than ~4MB are only partially read from the start; in that case truncated is true.
- Use startLine and endLine to read specific line ranges.
- Use maxBytes to limit the amount of data returned (default ~200KB).
- Cannot read directories — use bash with \`ls\` for that.
- Always read a file before editing it to understand its current content and structure.
- The content field contains the raw file text without line numbers. The result also includes totalLines (lines in the portion that was read) and truncated (true when the content was cut short by maxBytes or the large-file limit).`;
}

module.exports = { READ_TOOL_NAME, getReadToolDescription };

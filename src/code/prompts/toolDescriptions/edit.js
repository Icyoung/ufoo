"use strict";

const EDIT_TOOL_NAME = "edit";

function getEditToolDescription() {
  return `Replace text in a file in the workspace using exact string matching.

Usage notes:
- You must read the file first before editing. This tool will produce incorrect results if you guess at file contents.
- The find string must match exactly — including whitespace and indentation. Copy it precisely from the read output.
- The find string should be unique in the file. If it's not unique, provide more surrounding context to make it unique, or use all: true to replace every occurrence.
- Use all: true for bulk replacements like renaming a variable across the file.
- Preserve the exact indentation of the original code when specifying the replacement.`;
}

module.exports = { EDIT_TOOL_NAME, getEditToolDescription };

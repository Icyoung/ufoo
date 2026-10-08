"use strict";

const path = require("path");
const os = require("os");
const { displayCellWidth } = require("./index");
const { UFOO_BANNER_LINES: LOGO } = require("./banner");

function fit(text, width) {
  const value = String(text || "").replace(/[\x00-\x1f\x7f]/g, "");
  if (displayCellWidth(value) <= width) return value;
  let out = "";
  for (const char of value) {
    if (displayCellWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** Transient startup rows; hosts must not append these to conversation history. */
function buildUfooStartupEntries({ version = "dev", workspaceRoot = "", globalMode = false, width = 74 } = {}) {
  const columns = Math.max(1, Math.floor(Number(width) || 74));
  const home = os.homedir();
  const root = String(workspaceRoot || process.cwd());
  const directory = root === home ? "~" : root.startsWith(home + path.sep) ? `~${root.slice(home.length)}` : root;
  const info = [
    `ufoo v${version}`,
    globalMode ? "Global workspace" : directory,
    "Type a task or /help",
  ];
  const logoWidth = Math.max(...LOGO.map(displayCellWidth));
  let rows;
  if (columns >= logoWidth + 26) {
    rows = LOGO.map((text, index) => ({
      text: text.padEnd(logoWidth),
      detail: fit(info[index], columns - logoWidth - 2),
    }));
  } else if (columns >= logoWidth) {
    rows = LOGO.map((text) => ({ text }));
    rows.push(...info.filter(Boolean).map((detail) => ({ text: "", detail: fit(detail, columns) })));
  } else {
    rows = info.filter(Boolean).map((detail) => ({ text: "", detail: fit(detail, columns) }));
  }
  return [
    { id: "startup-before", kind: "spacer", text: "" },
    ...rows.map((row, index) => ({ id: `startup-${index}`, kind: "banner", speaker: "", ...row })),
    { id: "startup-after", kind: "spacer", text: "" },
  ];
}

module.exports = { buildUfooStartupEntries };

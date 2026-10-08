"use strict";
const fs = require("fs");
const path = require("path");

/** Legacy output is evidence, never a fabricated native tool transcript. */
function readControllerSummary(projectRoot) {
  const file = path.join(projectRoot, ".ufoo", "agent", "ufoo-agent.history.jsonl");
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, 65536);
    const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    if (size > length) lines.shift();
    return { source: "legacy-controller-history", trust: "untrusted", entries: lines.filter(Boolean).slice(-6).flatMap((line) => {
      try { const item = JSON.parse(line); return [{ prompt: String(item.prompt || "").slice(0, 2000), reply: String(item.reply || "").slice(0, 4000) }]; }
      catch { return []; }
    }) };
  } catch (error) { return { source: "legacy-controller-history", entries: [], error: error.code === "ENOENT" ? "" : "unreadable" }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
module.exports = { readControllerSummary };

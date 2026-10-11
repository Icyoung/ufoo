"use strict";

const fs = require("fs");
const path = require("path");
const { withFileLock } = require("./fileLock");

/** Append-only checkpoints also preserve source batches from in-flight turns. */
function createCheckpointStore({ workspaceRoot, namespace = "ucode", sessionId, redact = value => value } = {}) {
  if (![namespace, sessionId].every(value => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value || ""))) throw new Error("invalid checkpoint identity");
  const file = path.join(path.resolve(workspaceRoot), ".ufoo", "agent", namespace, "context", `${sessionId}.jsonl`);
  const records = () => {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.pop(); // An interrupted final append has never been committed.
    return lines.filter(Boolean).map(line => JSON.parse(line));
  };
  return {
    file,
    load: () => records().at(-1)?.checkpoint || null,
    archive: () => records().flatMap(record => record.sourceBatch || []),
    commit(checkpoint, sourceBatch, expectedVersion) {
      return withFileLock(file, () => {
        if ((records().at(-1)?.checkpoint.version || 0) !== expectedVersion) return false;
        const fd = fs.openSync(file, "a+", 0o600);
        try {
          const bytes = fs.readFileSync(file);
          if (bytes.length && bytes[bytes.length - 1] !== 10) fs.ftruncateSync(fd, bytes.lastIndexOf(10) + 1);
          fs.writeSync(fd, JSON.stringify(redact({ checkpoint, sourceBatch })) + "\n");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        return true;
      });
    },
    remove() { if (fs.existsSync(file)) fs.unlinkSync(file); },
  };
}

module.exports = { createCheckpointStore };

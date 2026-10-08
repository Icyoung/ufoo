"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createExecutionPathSelector } = require("../../../src/runtime/daemon/executionPaths");
test("conversation execution paths persist and old controller history is never switched in place", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-paths-"));
  try {
    fs.mkdirSync(path.join(root, ".ufoo/agent"), { recursive: true });
    const history = path.join(root, ".ufoo/agent/ufoo-agent.history.jsonl");
    fs.writeFileSync(history, '{"reply":"old"}\n');
    const select = createExecutionPathSelector(root);
    expect(select({ mode: "main" })).toBe("legacy");
    expect(select({ sessionId: "fresh", mode: "main" })).toBe("main");
    const restarted = createExecutionPathSelector(root);
    expect(restarted({ sessionId: "fresh", mode: "legacy" })).toBe("main");
    expect(() => restarted({ sessionId: "fresh", mode: "legacy", requestedMode: "legacy" })).toThrow("/session new");
    expect(fs.readFileSync(history, "utf8")).toBe('{"reply":"old"}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

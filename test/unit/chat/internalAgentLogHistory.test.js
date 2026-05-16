const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadInternalAgentLogHistory } = require("../../../src/chat/internalAgentLogHistory");
const { getUfooPaths } = require("../../../src/ufoo/paths");

function writeJsonl(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
}

describe("internal agent log history", () => {
  test("replays targeted router messages and agent replies for one internal agent", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-log-history-"));
    const paths = getUfooPaths(projectRoot);
    fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
      agents: {
        "codex:1": { nickname: "builder" },
        "codex:2": { nickname: "reviewer" },
      },
    }), "utf8");

    writeJsonl(path.join(paths.busEventsDir, "2026-05-16.jsonl"), [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: "codex:1",
        data: { message: "assigned task", source: "chat-dialog", injection_mode: "immediate" },
      },
      {
        seq: 2,
        event: "message",
        publisher: "codex:1",
        target: "ufoo-agent",
        data: { message: "done\\nwith detail" },
      },
      {
        seq: 3,
        event: "message",
        publisher: "codex:2",
        target: "ufoo-agent",
        data: { message: "other agent" },
      },
    ]);

    expect(loadInternalAgentLogHistory(projectRoot, "codex:1")).toEqual([
      "> assigned task",
      "• done",
      "  with detail",
    ]);
  });

  test("replays stream deltas without done markers", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-log-history-"));
    const paths = getUfooPaths(projectRoot);
    fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents: { "codex:1": {} } }), "utf8");

    writeJsonl(path.join(paths.busEventsDir, "2026-05-16.jsonl"), [
      {
        seq: 1,
        event: "message",
        publisher: "codex:1",
        target: "ufoo-agent",
        data: { message: JSON.stringify({ stream: true, delta: "hel" }) },
      },
      {
        seq: 2,
        event: "message",
        publisher: "codex:1",
        target: "ufoo-agent",
        data: { message: JSON.stringify({ stream: true, done: true }) },
      },
    ]);

    expect(loadInternalAgentLogHistory(projectRoot, "codex:1")).toEqual(["• hel"]);
  });
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const { loadInternalAgentLogHistory } = require("../../../src/chat/internalAgentLogHistory");
const { getUfooPaths } = require("../../../src/ufoo/paths");

function writeJsonl(filePath, events) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
}

function createProject(agents) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-log-history-"));
  const paths = getUfooPaths(projectRoot);
  fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
  fs.writeFileSync(paths.agentsFile, JSON.stringify({ agents }), "utf8");
  return { projectRoot, paths };
}

describe("internal agent log history", () => {
  test("replays targeted router messages and agent replies for one internal agent", () => {
    const { projectRoot, paths } = createProject({
      "codex:1": { nickname: "builder" },
      "codex:2": { nickname: "reviewer" },
    });

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
    const { projectRoot, paths } = createProject({ "codex:1": {} });

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

  test("nickname and scoped nickname messages stay isolated per agent", () => {
    const { projectRoot, paths } = createProject({
      "codex:1": { nickname: "builder", scoped_nickname: "ufoo-builder" },
      "codex:2": { nickname: "reviewer", scoped_nickname: "ufoo-reviewer" },
    });

    writeJsonl(path.join(paths.busEventsDir, "2026-05-16.jsonl"), [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: "builder",
        data: { message: "for builder nickname" },
      },
      {
        seq: 2,
        event: "message",
        publisher: "ufoo-agent",
        target: "ufoo-reviewer",
        data: { message: "for reviewer scoped nickname" },
      },
    ]);

    expect(loadInternalAgentLogHistory(projectRoot, "codex:1")).toEqual(["> for builder nickname"]);
    expect(loadInternalAgentLogHistory(projectRoot, "codex:2")).toEqual(["> for reviewer scoped nickname"]);
  });

  test("multiple stream deltas replay like live internal output", () => {
    const { projectRoot, paths } = createProject({ "codex:1": {} });

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
        data: { message: JSON.stringify({ stream: true, delta: "lo\n" }) },
      },
      {
        seq: 3,
        event: "message",
        publisher: "codex:1",
        target: "ufoo-agent",
        data: { message: JSON.stringify({ stream: true, delta: "world" }) },
      },
    ]);

    expect(loadInternalAgentLogHistory(projectRoot, "codex:1")).toEqual([
      "• hello",
      "  world",
    ]);
  });

  test("history replay reads only the last seven event files", () => {
    const { projectRoot, paths } = createProject({ "codex:1": {} });

    for (let day = 1; day <= 8; day += 1) {
      writeJsonl(path.join(paths.busEventsDir, `2026-05-${String(day).padStart(2, "0")}.jsonl`), [
        {
          seq: day,
          event: "message",
          publisher: "ufoo-agent",
          target: "codex:1",
          data: { message: `day ${day}` },
        },
      ]);
    }

    expect(loadInternalAgentLogHistory(projectRoot, "codex:1")).toEqual([
      "> day 2",
      "> day 3",
      "> day 4",
      "> day 5",
      "> day 6",
      "> day 7",
      "> day 8",
    ]);
  });

  test("history replay stops at maxEvents newest matching events", () => {
    const { projectRoot, paths } = createProject({ "codex:1": {} });
    const events = [];
    for (let seq = 1; seq <= 405; seq += 1) {
      events.push({
        seq,
        event: "message",
        publisher: "ufoo-agent",
        target: "codex:1",
        data: { message: `event ${seq}` },
      });
    }
    writeJsonl(path.join(paths.busEventsDir, "2026-05-16.jsonl"), events);

    const history = loadInternalAgentLogHistory(projectRoot, "codex:1", { maxEvents: 400, maxLines: 500 });
    expect(history).toHaveLength(400);
    expect(history[0]).toBe("> event 6");
    expect(history[399]).toBe("> event 405");
  });
});

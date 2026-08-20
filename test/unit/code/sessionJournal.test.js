"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  appendTurnMessages,
  getJournalPath,
  loadJournal,
  loadTranscriptProjection,
} = require("../../../src/code/conversation/sessionJournal");

describe("ucode session journal v3", () => {
  let workspaceRoot;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-session-journal-"));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("appends typed events with monotonic sequence and idempotent turn scopes", () => {
    const first = appendTurnMessages(workspaceRoot, "sess-journal", "turn-1", [
      { role: "user", content: "hello" },
    ], { scope: "input" });
    const second = appendTurnMessages(workspaceRoot, "sess-journal", "turn-1", [
      { role: "assistant", content: "hi" },
    ], { scope: "output" });
    const retry = appendTurnMessages(workspaceRoot, "sess-journal", "turn-1", [
      { role: "assistant", content: "hi" },
    ], { scope: "output" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(retry.events).toHaveLength(0);
    const events = loadJournal(workspaceRoot, "sess-journal").events;
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.map((event) => event.type)).toEqual(["user.message", "assistant.message"]);
  });

  test("retains identical assistant text when it belongs to different turns", () => {
    for (const turnId of ["turn-1", "turn-2"]) {
      appendTurnMessages(workspaceRoot, "sess-repeat", turnId, [
        { role: "user", content: `question ${turnId}` },
      ], { scope: "input" });
      appendTurnMessages(workspaceRoot, "sess-repeat", turnId, [
        { role: "assistant", content: "same answer" },
      ], { scope: "output" });
    }

    const projected = loadTranscriptProjection(workspaceRoot, "sess-repeat");
    expect(projected.events.filter((event) => event.role === "assistant")).toHaveLength(2);
  });

  test("migrates the known legacy baseline-shift duplicate without rewriting legacy", () => {
    const legacyDir = path.join(workspaceRoot, ".ufoo", "agent", "ucode", "transcripts");
    const legacyPath = path.join(legacyDir, "sess-legacy.jsonl");
    const legacy = [
      { id: "u1", role: "user", content: "first", createdAt: "2026-08-20T01:00:00.000Z" },
      { id: "a1", role: "assistant", content: "answer", createdAt: "2026-08-20T01:00:01.000Z" },
      { id: "a1-copy", role: "assistant", content: "answer", createdAt: "2026-08-20T01:05:00.000Z" },
      { id: "u2", role: "user", content: "second", createdAt: "2026-08-20T01:05:00.500Z" },
    ];
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyPath, `${legacy.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const before = fs.readFileSync(legacyPath, "utf8");

    const projection = loadTranscriptProjection(workspaceRoot, "sess-legacy");
    expect(projection.events.map((event) => event.id)).toEqual(["u1", "a1", "u2"]);
    expect(projection.suppressed).toHaveLength(1);

    appendTurnMessages(workspaceRoot, "sess-legacy", "turn-2", [
      { role: "assistant", content: "second answer" },
    ], { scope: "output" });

    expect(fs.readFileSync(legacyPath, "utf8")).toBe(before);
    const journal = loadJournal(workspaceRoot, "sess-legacy").events;
    expect(journal.some((event) => (
      event.type === "history.corrected"
      && event.payload.reason === "legacy_system_baseline_shift"
    ))).toBe(true);
    expect(fs.existsSync(getJournalPath(workspaceRoot, "sess-legacy"))).toBe(true);
    expect(loadTranscriptProjection(workspaceRoot, "sess-legacy").events.map((event) => event.content))
      .toEqual(["first", "answer", "second", "second answer"]);
  });
});

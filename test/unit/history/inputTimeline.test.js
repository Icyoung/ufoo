const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendBusEntry, getTimelineFile, readTimeline } = require("../../../src/history/inputTimeline");
const { getUfooPaths } = require("../../../src/ufoo/paths");

describe("history inputTimeline redaction", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-input-timeline-"));
    fs.mkdirSync(path.dirname(getUfooPaths(projectRoot).agentsFile), { recursive: true });
    fs.writeFileSync(getUfooPaths(projectRoot).agentsFile, JSON.stringify({ agents: {} }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("appendBusEntry redacts bearer tokens before timeline persistence", () => {
    appendBusEntry(projectRoot, {
      seq: 1,
      timestamp: "2026-04-20T10:00:00.000Z",
      publisher: "codex:1",
      target: "claude:2",
      message: "Use Authorization: Bearer top-secret-token for this request",
    });

    const raw = fs.readFileSync(getTimelineFile(projectRoot), "utf8");
    expect(raw).not.toContain("top-secret-token");
    expect(raw).toContain("Bearer [REDACTED]");

    const rows = readTimeline(projectRoot, 5);
    expect(rows[0].message).toContain("Bearer [REDACTED]");
  });
});

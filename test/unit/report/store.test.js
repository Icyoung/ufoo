const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  REPORT_PHASES,
  getReportPaths,
  normalizeReportInput,
  appendReport,
  listReports,
  updateReportState,
  readReportSummary,
  appendControllerInboxEntry,
  listControllerInboxEntries,
  clearControllerInbox,
  consumeControllerInboxEntries,
} = require("../../../src/report/store");

describe("report store", () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-report-store-"));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("normalizeReportInput applies defaults and error normalization", () => {
    const done = normalizeReportInput({
      phase: "done",
      task_id: "t1",
      agent_id: "codex:1",
      summary: "ok",
    }, { ts: "2026-02-12T00:00:00.000Z" });
    expect(done.phase).toBe(REPORT_PHASES.DONE);
    expect(done.ok).toBe(true);
    expect(done.scope).toBe("public");
    expect(done.controller_id).toBe("ufoo-agent");

    const failed = normalizeReportInput({
      phase: "done",
      task_id: "t2",
      agent_id: "codex:1",
      error: "boom",
      ok: false,
    }, { ts: "2026-02-12T00:00:01.000Z" });
    expect(failed.phase).toBe(REPORT_PHASES.ERROR);
    expect(failed.ok).toBe(false);

    const progress = normalizeReportInput({
      phase: "progress",
      task_id: "t3",
      agent_id: "codex:1",
      message: "running",
      scope: "private",
      controller_id: "router:1",
    });
    expect(progress.phase).toBe(REPORT_PHASES.PROGRESS);
    expect(progress.scope).toBe("private");
    expect(progress.controller_id).toBe("router:1");
  });

  test("append/list reports", () => {
    appendReport(projectRoot, normalizeReportInput({
      phase: "start",
      task_id: "task-1",
      agent_id: "codex:1",
      message: "scan repo",
    }, { ts: "2026-02-12T00:00:00.000Z" }));

    appendReport(projectRoot, normalizeReportInput({
      phase: "done",
      task_id: "task-1",
      agent_id: "codex:1",
      summary: "completed",
    }, { ts: "2026-02-12T00:00:01.000Z" }));

    const rows = listReports(projectRoot, { num: 10, agent: "codex:1" });
    expect(rows).toHaveLength(2);
    expect(rows[0].phase).toBe("done");
    expect(rows[1].phase).toBe("start");
  });

  test("report sinks redact secret-like payloads before persistence", () => {
    const report = normalizeReportInput({
      phase: "progress",
      task_id: "task-secret",
      agent_id: "codex:1",
      message: "Authorization: Bearer hidden-secret",
      meta: {
        accessToken: "access-secret",
      },
    }, { ts: "2026-02-12T00:00:04.000Z" });

    appendReport(projectRoot, report);
    appendControllerInboxEntry(projectRoot, "ufoo-agent", report);
    updateReportState(projectRoot, report);

    const { reportsFile, stateFile } = getReportPaths(projectRoot);
    const inboxFile = path.join(path.dirname(reportsFile), "private-inbox", "ufoo-agent.jsonl");
    const reportsRaw = fs.readFileSync(reportsFile, "utf8");
    const stateRaw = fs.readFileSync(stateFile, "utf8");
    const inboxRaw = fs.readFileSync(inboxFile, "utf8");

    expect(reportsRaw).not.toContain("hidden-secret");
    expect(reportsRaw).not.toContain("access-secret");
    expect(stateRaw).not.toContain("hidden-secret");
    expect(stateRaw).not.toContain("access-secret");
    expect(inboxRaw).not.toContain("hidden-secret");
    expect(inboxRaw).not.toContain("access-secret");

    const listed = listReports(projectRoot, { num: 5, agent: "codex:1" });
    expect(listed[0].message).toContain("Bearer [REDACTED]");
    expect(listed[0].meta.accessToken).toBe("[REDACTED]");
  });

  test("updates state pending count and summary", () => {
    const start = normalizeReportInput({
      phase: "start",
      task_id: "task-2",
      agent_id: "claude-code:2",
      message: "investigate",
    }, { ts: "2026-02-12T00:00:02.000Z" });
    updateReportState(projectRoot, start);

    let summary = readReportSummary(projectRoot);
    expect(summary.pending_total).toBe(1);
    expect(summary.agents[0].agent_id).toBe("claude-code:2");
    expect(summary.agents[0].pending_count).toBe(1);

    const done = normalizeReportInput({
      phase: "done",
      task_id: "task-2",
      agent_id: "claude-code:2",
      summary: "done",
    }, { ts: "2026-02-12T00:00:03.000Z" });
    updateReportState(projectRoot, done);

    summary = readReportSummary(projectRoot);
    expect(summary.pending_total).toBe(0);
    expect(summary.agents[0].pending_count).toBe(0);
    expect(summary.agents[0].last.summary).toBe("done");

    const { stateFile } = getReportPaths(projectRoot);
    expect(fs.existsSync(stateFile)).toBe(true);
  });

  test("readReportSummary hides private ufoo-agent controller pending entries", () => {
    const hiddenPrivate = normalizeReportInput({
      phase: "start",
      task_id: "task-hidden",
      agent_id: "ufoo-assistant:1",
      message: "internal",
      scope: "private",
      controller_id: "ufoo-agent",
    }, { ts: "2026-02-12T00:00:10.000Z" });
    updateReportState(projectRoot, hiddenPrivate);

    const visiblePublic = normalizeReportInput({
      phase: "start",
      task_id: "task-public",
      agent_id: "codex:1",
      message: "visible",
      scope: "public",
      controller_id: "ufoo-agent",
    }, { ts: "2026-02-12T00:00:11.000Z" });
    updateReportState(projectRoot, visiblePublic);

    const visiblePrivateOtherController = normalizeReportInput({
      phase: "start",
      task_id: "task-private-visible",
      agent_id: "router:2",
      message: "visible private",
      scope: "private",
      controller_id: "router:1",
    }, { ts: "2026-02-12T00:00:12.000Z" });
    updateReportState(projectRoot, visiblePrivateOtherController);

    const summary = readReportSummary(projectRoot);
    expect(summary.pending_total).toBe(2);

    const hiddenAgent = summary.agents.find((item) => item.agent_id === "ufoo-assistant:1");
    expect(hiddenAgent.pending_count).toBe(0);
    expect(hiddenAgent.pending).toEqual([]);

    const publicAgent = summary.agents.find((item) => item.agent_id === "codex:1");
    expect(publicAgent.pending_count).toBe(1);

    const privateOtherControllerAgent = summary.agents.find((item) => item.agent_id === "router:2");
    expect(privateOtherControllerAgent.pending_count).toBe(1);
  });

  test("controller inbox append/list/clear works", () => {
    appendControllerInboxEntry(projectRoot, "ufoo-agent", {
      phase: "start",
      task_id: "task-a",
      agent_id: "codex:1",
    });
    appendControllerInboxEntry(projectRoot, "ufoo-agent", {
      phase: "done",
      task_id: "task-a",
      agent_id: "codex:1",
    });

    let rows = listControllerInboxEntries(projectRoot, "ufoo-agent");
    expect(rows).toHaveLength(2);
    expect(rows[0].phase).toBe("start");
    expect(rows[1].phase).toBe("done");

    clearControllerInbox(projectRoot, "ufoo-agent");
    rows = listControllerInboxEntries(projectRoot, "ufoo-agent");
    expect(rows).toHaveLength(0);
  });

  test("consumeControllerInboxEntries removes only consumed subset", () => {
    const first = normalizeReportInput({
      phase: "start",
      task_id: "task-a",
      agent_id: "codex:1",
      message: "first",
      scope: "private",
    });
    const second = normalizeReportInput({
      phase: "progress",
      task_id: "task-b",
      agent_id: "codex:2",
      message: "second",
      scope: "private",
    });
    appendControllerInboxEntry(projectRoot, "ufoo-agent", first);
    appendControllerInboxEntry(projectRoot, "ufoo-agent", second);

    const consumed = consumeControllerInboxEntries(projectRoot, "ufoo-agent", [first]);
    expect(consumed.removed).toBe(1);
    expect(consumed.remaining).toBe(1);
    const rows = listControllerInboxEntries(projectRoot, "ufoo-agent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      entry_id: second.entry_id,
      task_id: "task-b",
    }));
  });
});

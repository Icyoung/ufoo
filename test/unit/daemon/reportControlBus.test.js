const fs = require("fs");
const os = require("os");
const path = require("path");

const EventBus = require("../../../src/coordination/bus");
const { getUfooPaths } = require("../../../src/coordination/state/paths");
const {
  REPORT_CONTROL_EVENT,
  REPORT_CONTROL_TARGET,
  REPORT_CONTROL_TYPE,
  enqueueAgentReport,
  extractAgentReportControl,
  getReportControlQueueFile,
  isAgentReportControlEvent,
  takeReportControlEvents,
} = require("../../../src/runtime/daemon/reportControlBus");

describe("daemon report control bus", () => {
  let projectRoot;
  let consoleLogSpy;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-report-control-bus-"));
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await new EventBus(projectRoot).init();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("enqueues agent report as a daemon control event", async () => {
    const result = await enqueueAgentReport(
      projectRoot,
      {
        phase: "done",
        task_id: "task-1",
        agent_id: "codex:abc",
        summary: "finished",
      },
      {
        requestId: "report-req-1",
        queuedAt: "2026-05-24T00:00:00.000Z",
      },
    );

    expect(result).toEqual(expect.objectContaining({
      queued: true,
      request_id: "report-req-1",
      targets: [REPORT_CONTROL_TARGET],
    }));

    const paths = getUfooPaths(projectRoot);
    const pendingPath = getReportControlQueueFile(projectRoot);
    const events = fs.readFileSync(pendingPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));

    expect(fs.existsSync(path.join(paths.busQueuesDir, REPORT_CONTROL_TARGET, "pending.jsonl"))).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      event: REPORT_CONTROL_EVENT,
      publisher: "codex:abc",
      target: REPORT_CONTROL_TARGET,
      type: REPORT_CONTROL_TYPE,
    }));
    expect(events[0].data).toEqual(expect.objectContaining({
      request_id: "report-req-1",
      queued_at: "2026-05-24T00:00:00.000Z",
      report: expect.objectContaining({
        task_id: "task-1",
        agent_id: "codex:abc",
        summary: "finished",
      }),
    }));
  });

  test("identifies and extracts report control events", () => {
    const evt = {
      event: REPORT_CONTROL_EVENT,
      target: REPORT_CONTROL_TARGET,
      type: REPORT_CONTROL_TYPE,
      timestamp: "2026-05-24T00:00:00.000Z",
      data: {
        request_id: "report-req-2",
        report: {
          phase: "progress",
          task_id: "task-2",
          agent_id: "claude-code:def",
          message: "halfway",
        },
      },
    };

    expect(isAgentReportControlEvent(evt)).toBe(true);
    expect(extractAgentReportControl(evt)).toEqual({
      request_id: "report-req-2",
      queued_at: "2026-05-24T00:00:00.000Z",
      report: expect.objectContaining({
        phase: "progress",
        task_id: "task-2",
      }),
    });
    expect(isAgentReportControlEvent({ event: "message", data: {} })).toBe(false);
    expect(isAgentReportControlEvent({
      event: REPORT_CONTROL_EVENT,
      type: REPORT_CONTROL_TYPE,
      target: "ufoo-agent",
      data: {},
    })).toBe(false);
    expect(isAgentReportControlEvent({
      event: REPORT_CONTROL_EVENT,
      target: REPORT_CONTROL_TARGET,
      type: "message/targeted",
      data: { report: {} },
    })).toBe(false);
    expect(isAgentReportControlEvent({
      event: REPORT_CONTROL_EVENT,
      target: "other-agent",
      type: REPORT_CONTROL_TYPE,
      data: { report: {} },
    })).toBe(false);
  });

  test("takes queued control events without touching normal bus messages", async () => {
    await enqueueAgentReport(
      projectRoot,
      {
        phase: "progress",
        task_id: "task-3",
        agent_id: "codex:def",
        message: "working",
      },
      { requestId: "report-req-3" },
    );

    const events = takeReportControlEvents(projectRoot);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      event: REPORT_CONTROL_EVENT,
      target: REPORT_CONTROL_TARGET,
      type: REPORT_CONTROL_TYPE,
    }));
    expect(extractAgentReportControl(events[0])).toEqual(expect.objectContaining({
      request_id: "report-req-3",
      report: expect.objectContaining({ task_id: "task-3" }),
    }));
    expect(takeReportControlEvents(projectRoot)).toEqual([]);
  });
});

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
  drainReportControlEvents,
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

    const events = [];
    await drainReportControlEvents(projectRoot, async (event) => { events.push(event); });
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
    expect(await drainReportControlEvents(projectRoot, async () => {})).toBe(0);
  });
  test("failed persistence restores the claim and never acknowledges ahead of the handler", async () => {
    await enqueueAgentReport(projectRoot, { agent_id: "a", phase: "start" });
    const { DeliveryQueue } = require("../../../src/coordination/bus/deliveryQueue");
    const queue = new DeliveryQueue(getReportControlQueueFile(projectRoot));
    await expect(drainReportControlEvents(projectRoot, async () => {
      expect(queue.processingFiles()).toHaveLength(1);
      throw new Error("persistence failure");
    })).rejects.toThrow("persistence failure");
    expect(queue.readPending()).toHaveLength(1);
    expect(queue.processingFiles()).toHaveLength(0);
    expect(await drainReportControlEvents(projectRoot, async () => true)).toBe(1);
  });

  test("implicit lifecycle reports share a task ID, including queued starts", async () => {
    const first = await enqueueAgentReport(projectRoot, { agent_id: "a", phase: "start" });
    const progress = await enqueueAgentReport(projectRoot, { agent_id: "a", phase: "progress" });
    const done = await enqueueAgentReport(projectRoot, { agent_id: "a", phase: "done" });
    expect(progress.report.task_id).toBe(first.report.task_id);
    expect(done.report.task_id).toBe(first.report.task_id);
    await drainReportControlEvents(projectRoot, async (event) => {
      await require("../../../src/runtime/daemon/reporting").recordAgentReport({ projectRoot, report: event.data.report });
      return true;
    });
    expect(require("../../../src/coordination/report/store").readReportSummary(projectRoot).pending_total).toBe(0);
  });

  test("ambiguous implicit reports require an explicit task ID", async () => {
    await enqueueAgentReport(projectRoot, { agent_id: "a", phase: "start", task_id: "one" });
    await enqueueAgentReport(projectRoot, { agent_id: "a", phase: "start", task_id: "two" });
    await expect(enqueueAgentReport(projectRoot, { agent_id: "a", phase: "done" })).rejects.toThrow("Multiple active tasks");
  });

  test("retry after persistence does not duplicate reports or reopen completed work", async () => {
    const { recordAgentReport } = require("../../../src/runtime/daemon/reporting");
    const store = require("../../../src/coordination/report/store");
    await enqueueAgentReport(projectRoot, { agent_id: "a", phase: "done", task_id: "one" });
    await expect(drainReportControlEvents(projectRoot, async (event) => {
      await recordAgentReport({ projectRoot, report: event.data.report });
      throw new Error("crash before ack");
    })).rejects.toThrow("crash before ack");
    await drainReportControlEvents(projectRoot, async (event) => {
      await recordAgentReport({ projectRoot, report: event.data.report });
    });
    expect(store.listReports(projectRoot)).toHaveLength(1);
    expect(store.listControllerInboxEntries(projectRoot)).toHaveLength(1);
    expect(store.readReportSummary(projectRoot).pending_total).toBe(0);
  });

});

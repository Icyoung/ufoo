const fs = require("fs");
const os = require("os");
const path = require("path");

jest.mock("../../../src/bus", () => {
  return jest.fn().mockImplementation(() => ({
    wake: jest.fn().mockResolvedValue({ ok: true, targets: ["ufoo-agent"] }),
  }));
});

const EventBus = require("../../../src/bus");
const { getUfooPaths } = require("../../../src/ufoo/paths");
const {
  recordAgentReport,
  resolveAgentDisplayName,
  toStatusPhase,
  formatStatusText,
  buildReportStatus,
} = require("../../../src/daemon/reporting");
const { REPORT_PHASES } = require("../../../src/report/store");
const { listControllerInboxEntries } = require("../../../src/report/store");

describe("daemon reporting", () => {
  let projectRoot;

  beforeEach(() => {
    EventBus.mockClear();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-daemon-reporting-"));
    const paths = getUfooPaths(projectRoot);
    fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
      agents: {
        "codex:abc": { nickname: "codex-1" },
      },
    }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("records public report, emits status, and queues private controller event", async () => {
    const onStatus = jest.fn();
    const { entry } = await recordAgentReport({
      projectRoot,
      report: {
        phase: "done",
        task_id: "task-1",
        agent_id: "codex:abc",
        summary: "completed",
      },
      onStatus,
      log: jest.fn(),
    });

    expect(entry.agent_id).toBe("codex:abc");
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
      phase: "done",
      key: "report:codex:abc:task-1",
      text: "codex-1 done: completed",
    }));
    const inbox = listControllerInboxEntries(projectRoot, "ufoo-agent");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual(expect.objectContaining({
      phase: "done",
      agent_id: "codex:abc",
      task_id: "task-1",
      scope: "public",
    }));
  });

  test("private report does not emit public status and still queues controller event", async () => {
    const onStatus = jest.fn();
    await recordAgentReport({
      projectRoot,
      report: {
        phase: "start",
        task_id: "task-2",
        agent_id: "ufoo-assistant-agent",
        message: "scan repo",
        scope: "private",
      },
      onStatus,
      log: jest.fn(),
    });

    expect(onStatus).not.toHaveBeenCalled();
    const inbox = listControllerInboxEntries(projectRoot, "ufoo-agent");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toEqual(expect.objectContaining({
      phase: "start",
      agent_id: "ufoo-assistant-agent",
      scope: "private",
    }));
    expect(EventBus).toHaveBeenCalledWith(projectRoot);
    const instance = EventBus.mock.results[0].value;
    expect(instance.wake).toHaveBeenCalledWith("ufoo-agent", expect.objectContaining({
      reason: "agent-report:start",
      shake: false,
    }));
  });

  test("toStatusPhase maps report phases to status phases", () => {
    expect(toStatusPhase("start")).toBe("start");
    expect(toStatusPhase("progress")).toBe("start");
    expect(toStatusPhase("error")).toBe("error");
    expect(toStatusPhase("done")).toBe("done");
    expect(toStatusPhase("unknown")).toBe("done");
  });

  test("formatStatusText formats start phase", () => {
    expect(formatStatusText("builder", { phase: "start", message: "working" }))
      .toBe("builder working");
  });

  test("formatStatusText formats progress phase", () => {
    expect(formatStatusText("builder", { phase: "progress", summary: "50%" }))
      .toBe("builder progress: 50%");
  });

  test("formatStatusText formats error phase", () => {
    expect(formatStatusText("builder", { phase: "error", error: "crash" }))
      .toBe("builder failed: crash");
  });

  test("formatStatusText formats done phase", () => {
    expect(formatStatusText("builder", { phase: "done", summary: "ok" }))
      .toBe("builder done: ok");
  });

  test("resolveAgentDisplayName returns nickname when available", () => {
    expect(resolveAgentDisplayName(projectRoot, "codex:abc")).toBe("codex-1");
  });

  test("resolveAgentDisplayName returns agentId when no nickname", () => {
    expect(resolveAgentDisplayName(projectRoot, "codex:unknown")).toBe("codex:unknown");
  });

  test("resolveAgentDisplayName returns unknown-agent for empty", () => {
    expect(resolveAgentDisplayName(projectRoot, "")).toBe("unknown-agent");
  });

  test("buildReportStatus creates correct status object", () => {
    const entry = { phase: "done", agent_id: "codex:abc", task_id: "t1", summary: "ok" };
    const result = buildReportStatus(entry, "builder");
    expect(result.phase).toBe("done");
    expect(result.key).toBe("report:codex:abc:t1");
    expect(result.text).toBe("builder done: ok");
  });

  test("public report does not wake private controller", async () => {
    await recordAgentReport({
      projectRoot,
      report: {
        phase: "done",
        task_id: "task-3",
        agent_id: "codex:abc",
        summary: "complete",
        scope: "public",
      },
      onStatus: jest.fn(),
      log: jest.fn(),
    });

    expect(EventBus).not.toHaveBeenCalled();
  });
});

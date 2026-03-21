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
const { recordAgentReport } = require("../../../src/daemon/reporting");
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

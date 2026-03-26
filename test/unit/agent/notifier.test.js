const fs = require("fs");
const os = require("os");
const path = require("path");
const AgentNotifier = require("../../../src/agent/notifier");

function safeName(subscriber) {
  return subscriber.replace(/:/g, "_");
}

function writePending(projectRoot, subscriber, events) {
  const pendingFile = path.join(
    projectRoot,
    ".ufoo",
    "bus",
    "queues",
    safeName(subscriber),
    "pending.jsonl"
  );
  fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
  fs.writeFileSync(
    pendingFile,
    `${events.map((evt) => JSON.stringify(evt)).join("\n")}\n`,
    "utf8"
  );
  return pendingFile;
}

describe("AgentNotifier delivery strategy", () => {
  let projectRoot = "";

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-notifier-"));
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "agent"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "bus", "queues"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "bus", "events"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "bus", "logs"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "bus", "offsets"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".ufoo", "bus", "daemon", "counts"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".ufoo", "agent", "all-agents.json"), JSON.stringify({ agents: {} }, null, 2));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("ufoo-code skips notifier injection and keeps pending queue", async () => {
    const subscriber = "ufoo-code:abc123";
    const pendingFile = writePending(projectRoot, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: subscriber,
        data: { message: "hello" },
      },
    ]);

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.injector = {
      inject: jest.fn().mockResolvedValue(undefined),
      readTty: jest.fn(() => ""),
    };

    const delivered = await notifier.deliverPending();

    expect(delivered).toBe(0);
    expect(notifier.injector.inject).not.toHaveBeenCalled();
    expect(fs.readFileSync(pendingFile, "utf8")).toContain("hello");
  });

  test("non-ufoo-code drains pending and injects message text", async () => {
    const subscriber = "codex:abc123";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: {
            status: "active",
            activity_state: "idle",
          },
        },
      }, null, 2)
    );
    const pendingFile = writePending(projectRoot, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: subscriber,
        data: { message: "legacy payload" },
      },
    ]);

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.injector = {
      inject: jest.fn().mockResolvedValue(undefined),
      readTty: jest.fn(() => ""),
    };
    notifier.eventBus = {
      send: jest.fn().mockResolvedValue({ ok: true }),
    };

    const delivered = await notifier.deliverPending();

    expect(delivered).toBe(1);
    expect(notifier.injector.inject).toHaveBeenCalledTimes(1);
    expect(notifier.injector.inject).toHaveBeenCalledWith(subscriber, "legacy payload");
    // Verify activity_state written to disk via publisher
    const agentsData = JSON.parse(fs.readFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"), "utf8"
    ));
    expect(agentsData.agents[subscriber].activity_state).toBe("working");
    expect(fs.existsSync(pendingFile)).toBe(false);
  });

  test("busy activity state still delivers immediate messages", async () => {
    const subscriber = "codex:busy1";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: {
            status: "active",
            activity_state: "working",
          },
        },
      }, null, 2)
    );
    const pendingFile = writePending(projectRoot, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: subscriber,
        data: { message: "task-a", injection_mode: "immediate" },
      },
    ]);

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.injector = {
      inject: jest.fn().mockResolvedValue(undefined),
      readTty: jest.fn(() => ""),
    };
    notifier.eventBus = {
      send: jest.fn().mockResolvedValue({ ok: true }),
    };

    const delivered = await notifier.deliverPending();

    expect(delivered).toBe(1);
    expect(notifier.injector.inject).toHaveBeenCalledWith(subscriber, "task-a");
    expect(fs.existsSync(pendingFile)).toBe(false);
  });

  test("busy activity state defers queued delivery and keeps queue intact", async () => {
    const subscriber = "codex:busy2";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: {
            status: "active",
            activity_state: "working",
          },
        },
      }, null, 2)
    );
    const pendingFile = writePending(projectRoot, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: subscriber,
        data: { message: "task-b", injection_mode: "queued" },
      },
    ]);

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.injector = {
      inject: jest.fn().mockResolvedValue(undefined),
      readTty: jest.fn(() => ""),
    };

    const delivered = await notifier.deliverPending();

    expect(delivered).toBe(0);
    expect(notifier.injector.inject).not.toHaveBeenCalled();
    expect(fs.readFileSync(pendingFile, "utf8")).toContain("task-b");
  });

  test("deliverPending injects only one message and requeues the rest", async () => {
    const subscriber = "codex:queue1";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: {
            status: "active",
            activity_state: "idle",
          },
        },
      }, null, 2)
    );
    const pendingFile = writePending(projectRoot, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: subscriber,
        data: { message: "task-a" },
      },
      {
        seq: 2,
        event: "message",
        publisher: "ufoo-agent",
        target: subscriber,
        data: { message: "task-b" },
      },
    ]);

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.injector = {
      inject: jest.fn().mockResolvedValue(undefined),
      readTty: jest.fn(() => ""),
    };
    notifier.eventBus = {
      send: jest.fn().mockResolvedValue({ ok: true }),
    };

    const delivered = await notifier.deliverPending();

    expect(delivered).toBe(1);
    expect(notifier.injector.inject).toHaveBeenCalledTimes(1);
    expect(notifier.injector.inject).toHaveBeenCalledWith(subscriber, "task-a");
    const pendingRaw = fs.readFileSync(pendingFile, "utf8");
    expect(pendingRaw).toContain("task-b");
    expect(pendingRaw).not.toContain("task-a");
  });

  test("poll keeps working state for hold window before downgrading to idle", async () => {
    const subscriber = "codex:hold1";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: {
            status: "active",
            activity_state: "working",
          },
        },
      }, null, 2)
    );

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.workingHoldMs = 1000;
    notifier.lastWorkingAt = Date.now();
    notifier._launcherReady = true; // simulate launcher ready
    notifier.getMessageCount = jest.fn(() => 0);
    notifier.notify = jest.fn();
    notifier.refreshTitle = jest.fn();
    notifier.updateHeartbeat = jest.fn();
    const stateSpy = jest.spyOn(notifier, "updateActivityState");

    await notifier.poll();
    expect(stateSpy).not.toHaveBeenCalledWith("idle");

    notifier.lastWorkingAt = Date.now() - 1500;
    await notifier.poll();
    expect(stateSpy).toHaveBeenCalledWith("idle");
  });

  test("poll does not set idle when _launcherReady is false", async () => {
    const subscriber = "codex:gate1";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: { status: "active", activity_state: "starting" },
        },
      }, null, 2)
    );

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.workingHoldMs = 0;
    notifier.lastWorkingAt = 0;
    // _launcherReady defaults to false after start()
    notifier._launcherReady = false;
    notifier.getMessageCount = jest.fn(() => 0);
    notifier.notify = jest.fn();
    notifier.refreshTitle = jest.fn();
    notifier.updateHeartbeat = jest.fn();
    const stateSpy = jest.spyOn(notifier, "updateActivityState");

    await notifier.poll();
    expect(stateSpy).not.toHaveBeenCalledWith("idle");
  });

  test("markLauncherReady enables idle transition in poll", async () => {
    const subscriber = "codex:gate2";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: { status: "active", activity_state: "starting" },
        },
      }, null, 2)
    );

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.workingHoldMs = 0;
    notifier.lastWorkingAt = 0;
    notifier._launcherReady = false;
    notifier.getMessageCount = jest.fn(() => 0);
    notifier.notify = jest.fn();
    notifier.refreshTitle = jest.fn();
    notifier.updateHeartbeat = jest.fn();
    const stateSpy = jest.spyOn(notifier, "updateActivityState");

    // Before markLauncherReady: no idle
    await notifier.poll();
    expect(stateSpy).not.toHaveBeenCalledWith("idle");

    // After markLauncherReady: idle allowed
    notifier.markLauncherReady();
    await notifier.poll();
    expect(stateSpy).toHaveBeenCalledWith("idle");
  });

  test("start() sets activity_state to starting and _launcherReady to false", () => {
    const subscriber = "codex:start1";
    // Pre-populate agent entry (writeActivityState requires it)
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: { status: "active", activity_state: "ready" },
        },
      }, null, 2)
    );
    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.start();
    expect(notifier._launcherReady).toBe(false);
    // Check that starting was written
    const data = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".ufoo", "agent", "all-agents.json"), "utf8")
    );
    expect(data.agents[subscriber].activity_state).toBe("starting");
    // cleanup timer
    if (notifier.timer) clearInterval(notifier.timer);
  });

  test("poll does not force working state on queue growth", async () => {
    const subscriber = "codex:work1";
    fs.writeFileSync(
      path.join(projectRoot, ".ufoo", "agent", "all-agents.json"),
      JSON.stringify({
        agents: {
          [subscriber]: {
            status: "active",
            activity_state: "ready",
          },
        },
      }, null, 2)
    );

    const notifier = new AgentNotifier(projectRoot, subscriber);
    notifier.autoTrigger = false;
    notifier.lastCount = 0;
    notifier.getMessageCount = jest.fn()
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(1);
    notifier.notify = jest.fn();
    notifier.refreshTitle = jest.fn();
    notifier.updateHeartbeat = jest.fn();
    const stateSpy = jest.spyOn(notifier, "updateActivityState");

    await notifier.poll();
    expect(stateSpy).not.toHaveBeenCalledWith("working");
  });
});

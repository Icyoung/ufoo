const fs = require("fs");
const os = require("os");
const path = require("path");
const BusDaemon = require("../../../src/bus/daemon");

function safeName(subscriber) {
  return subscriber.replace(/:/g, "_");
}

function writePending(busDir, subscriber, events) {
  const queueDir = path.join(busDir, "queues", safeName(subscriber));
  fs.mkdirSync(queueDir, { recursive: true });
  const file = path.join(queueDir, "pending.jsonl");
  const lines = events.map((evt) => JSON.stringify(evt)).join("\n");
  fs.writeFileSync(file, `${lines}\n`, "utf8");
}

describe("BusDaemon delivery ownership", () => {
  let tmpDir;
  let busDir;
  let daemonDir;
  let agentsFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-bus-daemon-"));
    busDir = path.join(tmpDir, "bus");
    daemonDir = path.join(tmpDir, "daemon");
    agentsFile = path.join(tmpDir, "all-agents.json");

    fs.mkdirSync(path.join(busDir, "queues"), { recursive: true });
    fs.mkdirSync(daemonDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("skips delivery for terminal launch mode (owned by notifier)", async () => {
    const subscriber = "codex:abc123";
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: {
          [subscriber]: {
            launch_mode: "terminal",
            nickname: "worker",
            status: "active",
          },
        },
      }),
      "utf8"
    );

    writePending(busDir, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "sender:1",
        target: subscriber,
        data: { message: "hello" },
      },
    ]);

    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.injector.inject = jest.fn().mockResolvedValue(undefined);

    await daemon.checkQueues();

    expect(daemon.injector.inject).not.toHaveBeenCalled();
  });

  test("delivers for legacy launch mode (owner unknown)", async () => {
    const subscriber = "codex:def456";
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: {
          [subscriber]: {
            launch_mode: "",
            nickname: "legacy",
            status: "active",
          },
        },
      }),
      "utf8"
    );

    writePending(busDir, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "sender:1",
        target: subscriber,
        data: { message: "legacy message" },
      },
    ]);

    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.injector.inject = jest.fn().mockResolvedValue(undefined);

    await daemon.checkQueues();

    expect(daemon.injector.inject).toHaveBeenCalledTimes(1);
    expect(daemon.injector.inject).toHaveBeenCalledWith(subscriber, "legacy message");
  });

  test("queued mode defers legacy delivery while agent is busy", async () => {
    const subscriber = "codex:busy789";
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: {
          [subscriber]: {
            launch_mode: "",
            nickname: "legacy-busy",
            status: "active",
            activity_state: "working",
          },
        },
      }),
      "utf8"
    );

    writePending(busDir, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "sender:1",
        target: subscriber,
        data: { message: "later", injection_mode: "queued" },
      },
    ]);

    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.injector.inject = jest.fn().mockResolvedValue(undefined);

    await daemon.checkQueues();

    expect(daemon.injector.inject).not.toHaveBeenCalled();
    const pendingFile = path.join(busDir, "queues", safeName(subscriber), "pending.jsonl");
    expect(fs.readFileSync(pendingFile, "utf8")).toContain("\"injection_mode\":\"queued\"");
  });

  test("queued mode does not get stuck on legacy starting state", async () => {
    const subscriber = "codex:start123";
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: {
          [subscriber]: {
            launch_mode: "",
            nickname: "legacy-starting",
            status: "active",
            activity_state: "starting",
          },
        },
      }),
      "utf8"
    );

    writePending(busDir, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "sender:1",
        target: subscriber,
        data: { message: "queued-first", injection_mode: "queued" },
      },
    ]);

    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.injector.inject = jest.fn().mockResolvedValue(undefined);

    await daemon.checkQueues();

    expect(daemon.injector.inject).toHaveBeenCalledTimes(1);
    expect(daemon.injector.inject).toHaveBeenCalledWith(subscriber, "queued-first");
    const after = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(after.agents[subscriber].activity_state).toBe("working");
  });

  test("mixed immediate and queued batch defers queued after immediate delivery", async () => {
    const subscriber = "codex:mixed123";
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: {
          [subscriber]: {
            launch_mode: "",
            nickname: "legacy-mixed",
            status: "active",
            activity_state: "idle",
          },
        },
      }),
      "utf8"
    );

    writePending(busDir, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "sender:1",
        target: subscriber,
        data: { message: "immediate-first", injection_mode: "immediate" },
      },
      {
        seq: 2,
        event: "message",
        publisher: "sender:1",
        target: subscriber,
        data: { message: "queued-second", injection_mode: "queued" },
      },
    ]);

    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.injector.inject = jest.fn().mockResolvedValue(undefined);

    await daemon.checkQueues();

    expect(daemon.injector.inject).toHaveBeenCalledTimes(1);
    expect(daemon.injector.inject).toHaveBeenCalledWith(subscriber, "immediate-first");
    const pendingFile = path.join(busDir, "queues", safeName(subscriber), "pending.jsonl");
    expect(fs.readFileSync(pendingFile, "utf8")).toContain("queued-second");
    expect(fs.readFileSync(pendingFile, "utf8")).not.toContain("immediate-first");
  });

  test("isRunning returns false when no pid file", () => {
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    expect(daemon.isRunning()).toBe(false);
  });

  test("isRunning returns false when pid is dead", () => {
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    fs.writeFileSync(daemon.pidFile, "999999\n");
    expect(daemon.isRunning()).toBe(false);
  });

  test("getRunningPid returns null when no pid file", () => {
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    expect(daemon.getRunningPid()).toBeNull();
  });

  test("getRunningPid returns null for dead pid", () => {
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    fs.writeFileSync(daemon.pidFile, "999999\n");
    expect(daemon.getRunningPid()).toBeNull();
  });

  test("stop logs not running when no daemon", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.stop();
    expect(logSpy).toHaveBeenCalledWith("[daemon] Not running");
    logSpy.mockRestore();
  });

  test("status logs not running and cleans stale pid file", () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    fs.writeFileSync(daemon.pidFile, "999999\n");
    daemon.status();
    expect(logSpy).toHaveBeenCalledWith("[daemon] Not running");
    expect(fs.existsSync(daemon.pidFile)).toBe(false);
    logSpy.mockRestore();
  });

  test("setLegacyActivityState updates agent meta", () => {
    const subscriber = "codex:act1";
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: { [subscriber]: { status: "active" } },
    }));
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.setLegacyActivityState(subscriber, "working");
    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents[subscriber].activity_state).toBe("working");
  });

  test("setLegacyActivityState does nothing for missing subscriber", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({ agents: {} }));
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.setLegacyActivityState("codex:missing", "idle");
    // Should not throw
  });

  test("refreshLegacyActivityState transitions starting to idle", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: { "codex:r1": { status: "active", activity_state: "starting" } },
    }));
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    const result = daemon.refreshLegacyActivityState(
      "codex:r1",
      { activity_state: "starting" },
      false
    );
    expect(result).toBe("idle");
  });

  test("refreshLegacyActivityState transitions starting to ready when pending", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: { "codex:r2": { status: "active", activity_state: "starting" } },
    }));
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    const result = daemon.refreshLegacyActivityState(
      "codex:r2",
      { activity_state: "starting" },
      true
    );
    expect(result).toBe("ready");
  });

  test("refreshLegacyActivityState holds working state during hold period", () => {
    fs.writeFileSync(agentsFile, JSON.stringify({
      agents: { "codex:r3": { status: "active", activity_state: "working" } },
    }));
    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.lastWorkingAt.set("codex:r3", Date.now());
    const result = daemon.refreshLegacyActivityState(
      "codex:r3",
      { activity_state: "working" },
      false
    );
    expect(result).toBe("working");
  });

  test("skips daemon injection for ufoo-code and keeps pending queue", async () => {
    const subscriber = "ufoo-code:ee8094d2";
    fs.writeFileSync(
      agentsFile,
      JSON.stringify({
        agents: {
          [subscriber]: {
            launch_mode: "",
            agent_type: "ufoo-code",
            nickname: "ufoo-code-1",
            status: "active",
          },
        },
      }),
      "utf8"
    );

    writePending(busDir, subscriber, [
      {
        seq: 1,
        event: "message",
        publisher: "ufoo-agent",
        target: subscriber,
        data: { message: "hello ucode" },
      },
    ]);

    const daemon = new BusDaemon(busDir, agentsFile, daemonDir, 2000);
    daemon.injector.inject = jest.fn().mockResolvedValue(undefined);

    await daemon.checkQueues();

    expect(daemon.injector.inject).not.toHaveBeenCalled();

    const pendingFile = path.join(busDir, "queues", safeName(subscriber), "pending.jsonl");
    const pendingRaw = fs.readFileSync(pendingFile, "utf8");
    expect(pendingRaw).toContain("hello ucode");
  });
});

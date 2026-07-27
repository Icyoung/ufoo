"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { ActivityDetector } = require("../../../src/agents/activity/activityDetector");
const { createActivityStatePublisher } = require("../../../src/agents/activity/activityStatePublisher");
const {
  DEFAULT_GRACE_MS,
  reconcileDetectorOwnedActivity,
  resolveGraceMs,
} = require("../../../src/agents/activity/activityReconcile");

function makeTmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-reconcile-"));
  const agentDir = path.join(root, ".ufoo", "agent");
  const busDir = path.join(root, ".ufoo", "bus");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(busDir, "events"), { recursive: true });
  const agentsFile = path.join(agentDir, "all-agents.json");
  return { root, agentsFile };
}

function writeAgents(agentsFile, agents) {
  fs.writeFileSync(agentsFile, JSON.stringify({
    created_at: "2026-03-08T00:00:00.000Z",
    agents,
  }, null, 2));
}

describe("activityReconcile", () => {
  let tmpDir;
  let agentsFile;

  beforeEach(() => {
    const proj = makeTmpProject();
    tmpDir = proj.root;
    agentsFile = proj.agentsFile;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolveGraceMs caps quiet window at DEFAULT_GRACE_MS", () => {
    expect(resolveGraceMs({ quietWindowMs: 30000 })).toBe(DEFAULT_GRACE_MS);
    expect(resolveGraceMs({ quietWindowMs: 3000 })).toBe(3000);
  });

  test("clears inject-stamp working when detector is idle past grace", () => {
    const subscriber = "codex:stuck1";
    const since = new Date(Date.now() - 6000).toISOString();
    writeAgents(agentsFile, {
      [subscriber]: {
        status: "active",
        activity_state: "working",
        activity_detail: "inject",
        activity_since: since,
      },
    });

    const detector = new ActivityDetector("codex", { quietWindowMs: 50 });
    detector.markReady();
    // Simulate detector already idle (no PTY echo after inject stamp).
    detector.markWorking();
    detector.markIdle();

    const publisher = createActivityStatePublisher({
      agentsFile,
      subscriber,
      projectRoot: tmpDir,
    });
    // Publisher last published idle; disk still working (desync).
    publisher.publish("idle");
    writeAgents(agentsFile, {
      [subscriber]: {
        status: "active",
        activity_state: "working",
        activity_detail: "inject",
        activity_since: since,
      },
    });

    const result = reconcileDetectorOwnedActivity({
      detector,
      publisher,
      agentsFile,
      subscriber,
    });
    expect(result.ok).toBe(true);
    expect(result.reconciled).toBe(true);
    expect(result.reason).toBe("cleared");

    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents[subscriber].activity_state).toBe("idle");
    expect(data.agents[subscriber].activity_detail).toBeUndefined();
  });

  test("waits for grace before clearing fresh inject stamp", () => {
    const subscriber = "codex:grace1";
    const since = new Date().toISOString();
    writeAgents(agentsFile, {
      [subscriber]: {
        status: "active",
        activity_state: "idle",
      },
    });

    const detector = new ActivityDetector("codex", { quietWindowMs: 5000 });
    detector.markReady();
    detector.markWorking();
    detector.markIdle();

    const publisher = createActivityStatePublisher({
      agentsFile,
      subscriber,
      projectRoot: tmpDir,
    });
    publisher.publish("idle");
    writeAgents(agentsFile, {
      [subscriber]: {
        status: "active",
        activity_state: "working",
        activity_detail: "inject",
        activity_since: since,
      },
    });

    const result = reconcileDetectorOwnedActivity({
      detector,
      publisher,
      agentsFile,
      subscriber,
      now: Date.now(),
    });
    expect(result.reconciled).toBe(false);
    expect(result.reason).toBe("grace");

    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents[subscriber].activity_state).toBe("working");
  });

  test("does not clear when detector is still working", () => {
    const subscriber = "codex:busy1";
    writeAgents(agentsFile, {
      [subscriber]: {
        status: "active",
        activity_state: "working",
        activity_detail: "inject",
        activity_since: new Date(Date.now() - 6000).toISOString(),
      },
    });

    const detector = new ActivityDetector("codex", { quietWindowMs: 50 });
    detector.markReady();
    detector.markWorking();

    const publisher = createActivityStatePublisher({
      agentsFile,
      subscriber,
      projectRoot: tmpDir,
    });

    const result = reconcileDetectorOwnedActivity({
      detector,
      publisher,
      agentsFile,
      subscriber,
    });
    expect(result.reconciled).toBe(false);
    expect(result.reason).toBe("local_busy");
  });

  test("does not clear waiting_input", () => {
    const subscriber = "codex:wait1";
    writeAgents(agentsFile, {
      [subscriber]: {
        status: "active",
        activity_state: "waiting_input",
        activity_since: new Date(Date.now() - 60000).toISOString(),
      },
    });

    const detector = new ActivityDetector("codex", { quietWindowMs: 50 });
    detector.markReady();
    detector.markWorking();
    detector.markIdle();

    const publisher = createActivityStatePublisher({
      agentsFile,
      subscriber,
      projectRoot: tmpDir,
    });

    const result = reconcileDetectorOwnedActivity({
      detector,
      publisher,
      agentsFile,
      subscriber,
    });
    expect(result.reconciled).toBe(false);
    expect(result.reason).toBe("disk_gated");
  });
});

describe("activityStatePublisher reconcile", () => {
  let tmpDir;
  let agentsFile;

  beforeEach(() => {
    const proj = makeTmpProject();
    tmpDir = proj.root;
    agentsFile = proj.agentsFile;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reconcile republishes idle when disk disagrees despite lastState match", () => {
    const subscriber = "codex:repub1";
    writeAgents(agentsFile, {
      [subscriber]: { status: "active", activity_state: "starting" },
    });

    const pub = createActivityStatePublisher({
      agentsFile,
      subscriber,
      projectRoot: tmpDir,
    });
    expect(pub.publish("idle")).toBe(true);
    expect(pub.publish("idle")).toBe(false);

    writeAgents(agentsFile, {
      [subscriber]: {
        status: "active",
        activity_state: "working",
        activity_detail: "inject",
      },
    });

    expect(pub.publish("idle")).toBe(false);
    expect(pub.publish("idle", {}, { force: true, reconcile: true })).toBe(true);
    const data = JSON.parse(fs.readFileSync(agentsFile, "utf8"));
    expect(data.agents[subscriber].activity_state).toBe("idle");
  });
});

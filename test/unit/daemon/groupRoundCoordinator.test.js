"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGroupRoundCoordinator } = require("../../../src/runtime/daemon/groupRoundCoordinator");
const { getUfooPaths } = require("../../../src/coordination/state/paths");
const { DeliveryQueue } = require("../../../src/coordination/bus/deliveryQueue");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupGroupProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-group-round-"));
  const paths = getUfooPaths(root);
  fs.mkdirSync(paths.busEventsDir, { recursive: true });
  fs.mkdirSync(paths.groupsDir, { recursive: true });
  fs.mkdirSync(path.dirname(paths.agentsFile), { recursive: true });

  const setActivities = (states = {}) => {
    fs.writeFileSync(paths.agentsFile, JSON.stringify({
      agents: {
        "codex:aaa11111": {
          nickname: "architect",
          display_nickname: "architect",
          status: "active",
          activity_state: states.A || "ready",
          group_id: "build-lane-1",
        },
        "codex:bbb22222": {
          nickname: "builder",
          display_nickname: "builder",
          status: "active",
          activity_state: states.B || "ready",
          group_id: "build-lane-1",
        },
        "codex:ccc33333": {
          nickname: "reviewer",
          display_nickname: "reviewer",
          status: "active",
          activity_state: states.C || "ready",
          group_id: "build-lane-1",
        },
      },
    }, null, 2));
  };

  setActivities();
  fs.writeFileSync(path.join(paths.groupsDir, "build-lane-1.json"), JSON.stringify({
    group_id: "build-lane-1",
    template_alias: "build-lane",
    template_name: "Build Lane",
    status: "running",
    members: [
      { nickname: "architect", subscriber_id: "codex:aaa11111", role: "architect" },
      { nickname: "builder", subscriber_id: "codex:bbb22222", role: "builder" },
      { nickname: "reviewer", subscriber_id: "codex:ccc33333", role: "reviewer" },
    ],
  }, null, 2));

  let seq = 0;
  const eventFile = path.join(paths.busEventsDir, "2026-11-27.jsonl");
  const appendEvent = (obj) => {
    seq += 1;
    fs.appendFileSync(eventFile, JSON.stringify({
      seq,
      timestamp: new Date().toISOString(),
      ...obj,
    }) + "\n");
    return seq;
  };

  const emitSurface = (subscriber, surface) => appendEvent({
    event: "agent_surface",
    publisher: subscriber,
    target: "*",
    data: { subscriber, surface },
  });

  return { root, paths, setActivities, appendEvent, emitSurface };
}

describe("groupRoundCoordinator", () => {
  let fixture;
  let coordinator;

  beforeEach(() => { fixture = setupGroupProject(); });
  afterEach(() => {
    if (coordinator) coordinator.stop();
    coordinator = null;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("waits for A -> B -> C handoffs and pending queues to fully settle, then reports all 3 final outputs once", async () => {
    const settled = [];
    coordinator = createGroupRoundCoordinator({
      projectRoot: fixture.root,
      pollIntervalMs: 0,
      settleDebounceMs: 60,
      onGroupSettled: (rollup) => { settled.push(rollup); },
    });
    coordinator.start();

    // A starts under controller origin and completes, handing off to B via pending queue
    fixture.setActivities({ A: "working", B: "ready", C: "ready" });
    fixture.emitSurface("codex:aaa11111", { type: "task_started", publisher: "ufoo-agent", parentTaskRunId: "task_parent_1", parentSessionId: "main-custom" });
    coordinator.tick();

    const bQueue = DeliveryQueue.forSubscriber(fixture.paths.busDir, "codex:bbb22222");
    bQueue.append({ seq: 99, event: "message", publisher: "codex:aaa11111", target: "codex:bbb22222", data: { message: "implement change" } });
    fixture.emitSurface("codex:aaa11111", { type: "task_completed", finalText: "Architect final design A." });
    fixture.setActivities({ A: "ready", B: "ready", C: "ready" });
    coordinator.tick();

    // Must NOT settle yet because B still has a pending queued message
    await wait(110);
    expect(settled).toHaveLength(0);

    // B consumes queue and runs 2 turns (draft then final)
    bQueue.writePending([]);
    fixture.setActivities({ A: "ready", B: "working", C: "ready" });
    fixture.emitSurface("codex:bbb22222", { type: "task_started", publisher: "codex:aaa11111" });
    fixture.emitSurface("codex:bbb22222", { type: "task_completed", finalText: "Builder first draft (should be superseded)." });
    fixture.emitSurface("codex:bbb22222", { type: "task_started", publisher: "codex:ccc33333" });
    fixture.emitSurface("codex:bbb22222", { type: "task_completed", finalText: "Builder final patch B." });
    fixture.setActivities({ A: "ready", B: "ready", C: "working" });
    fixture.emitSurface("codex:ccc33333", { type: "task_started", publisher: "codex:bbb22222" });
    coordinator.tick();

    // Still must NOT settle while C is running
    await wait(110);
    expect(settled).toHaveLength(0);

    // C finishes -> all 3 idle & queues empty
    fixture.emitSurface("codex:ccc33333", { type: "text_delta", delta: "Reviewer final verdict C: PASS." });
    fixture.emitSurface("codex:ccc33333", { type: "task_completed" });
    fixture.setActivities({ A: "ready", B: "ready", C: "ready" });
    coordinator.tick();

    await wait(120);
    expect(settled).toHaveLength(1);
    const rollup = settled[0];
    expect(rollup).toMatchObject({
      groupId: "build-lane-1",
      groupLabel: "Build Lane",
      roundId: 1,
      origin: "controller",
      parentTaskRunId: "task_parent_1",
      parentSessionId: "main-custom",
    });
    expect(rollup.members.map((m) => ({ nickname: m.nickname, turns: m.turnsInRound, lastReply: m.lastReply }))).toEqual([
      { nickname: "architect", turns: 1, lastReply: "Architect final design A." },
      { nickname: "builder", turns: 2, lastReply: "Builder final patch B." },
      { nickname: "reviewer", turns: 1, lastReply: "Reviewer final verdict C: PASS." },
    ]);
    expect(rollup.prompt).toContain("active coordinated objective");
    expect(rollup.prompt).toContain("read_agent_history");

    // Idempotent: ticking again while idle must NOT re-emit
    coordinator.tick();
    await wait(100);
    expect(settled).toHaveLength(1);

    // Round 2 triggered by user directly -> origin === "user"
    fixture.emitSurface("codex:bbb22222", { type: "task_started", publisher: "user" });
    fixture.emitSurface("codex:bbb22222", { type: "task_completed", finalText: "Round 2 tweak." });
    coordinator.tick();
    await wait(120);
    expect(settled).toHaveLength(2);
    expect(settled[1].roundId).toBe(2);
    expect(settled[1].origin).toBe("user");
    expect(settled[1].prompt).toContain("Do NOT automatically dispatch a new round of work");
  });

  test("does not prematurely settle while a group member is paused waiting_user, and respects groupAutoSummarize=false", async () => {
    const settled = [];
    coordinator = createGroupRoundCoordinator({
      projectRoot: fixture.root,
      pollIntervalMs: 0,
      settleDebounceMs: 50,
      onGroupSettled: (rollup) => { settled.push(rollup); },
    });
    coordinator.start();

    fixture.emitSurface("codex:aaa11111", { type: "task_started", publisher: "user" });
    fixture.emitSurface("codex:aaa11111", { type: "task_paused", finalText: "Waiting for approval" });
    coordinator.tick();
    await wait(100);
    expect(settled).toHaveLength(0);

    // Member resumes & completes
    fixture.emitSurface("codex:aaa11111", { type: "task_started", publisher: "user" });
    fixture.emitSurface("codex:aaa11111", { type: "task_completed", finalText: "Approved and done." });
    coordinator.tick();
    await wait(100);
    expect(settled).toHaveLength(1);
    expect(settled[0].members[0].lastReply).toBe("Approved and done.");

    // Disabled config skips dispatch
    fs.writeFileSync(path.join(fixture.root, ".ufoo", "config.json"), JSON.stringify({ groupAutoSummarize: false }));
    fixture.emitSurface("codex:aaa11111", { type: "task_started", publisher: "user" });
    fixture.emitSurface("codex:aaa11111", { type: "task_completed", finalText: "Silent round." });
    coordinator.tick();
    await wait(100);
    expect(settled).toHaveLength(1);
  });
});

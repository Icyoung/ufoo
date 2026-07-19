const { DeliveryScheduler, isDeliverableActivityState } = require("../../../src/runtime/daemon/deliveryScheduler");

function makeQueue(event) {
  const queue = {
    claim: event ? { event, processingFile: "/tmp/claim" } : null,
    claimNext: jest.fn(() => queue.claim),
    completeClaim: jest.fn(),
    restoreClaim: jest.fn(),
    readPending: jest.fn(() => []),
  };
  return queue;
}

describe("DeliveryScheduler", () => {
  test("activity gate only allows idle and ready", () => {
    expect(isDeliverableActivityState("idle")).toBe(true);
    expect(isDeliverableActivityState("ready")).toBe(true);
    expect(isDeliverableActivityState("working")).toBe(false);
    expect(isDeliverableActivityState("waiting_input")).toBe(false);
    expect(isDeliverableActivityState("")).toBe(false);
  });

  test("delivers one message for idle subscriber", async () => {
    const event = {
      seq: 1,
      event: "message",
      publisher: "ufoo-agent",
      data: { message: "hello" },
    };
    const queue = makeQueue(event);
    const injector = { inject: jest.fn().mockResolvedValue(undefined) };
    const emitDelivery = jest.fn().mockResolvedValue(undefined);
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:one": { status: "active", activity_state: "idle", launch_mode: "terminal" },
        },
      }),
      emitDelivery,
    });

    const result = await scheduler.deliverSubscriber("codex:one");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
    expect(queue.claimNext).toHaveBeenCalledTimes(1);
    expect(injector.inject).toHaveBeenCalledWith("codex:one", "[ufoo]<from:ufoo-agent>\nhello");
    expect(queue.completeClaim).toHaveBeenCalledWith(queue.claim);
    expect(queue.restoreClaim).not.toHaveBeenCalled();
    expect(emitDelivery).toHaveBeenCalledWith(expect.objectContaining({
      subscriber: "codex:one",
      status: "ok",
      event: expect.objectContaining({
        seq: event.seq,
        queue_type: "agent_message",
        delivery: expect.objectContaining({ mode: "inject", gate: "idle" }),
      }),
    }));
  });

  test("busy subscriber leaves queue untouched", async () => {
    const queue = makeQueue({
      seq: 1,
      event: "message",
      data: { message: "hello" },
    });
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector: { inject: jest.fn() },
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:busy": { status: "active", activity_state: "working", launch_mode: "terminal" },
        },
      }),
    });

    const result = await scheduler.deliverSubscriber("codex:busy");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 0, deferred: true }));
    expect(result.reason).toBe("working");
    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  test("missing launch mode leaves queue untouched", async () => {
    const queue = makeQueue({
      seq: 1,
      event: "message",
      data: { message: "hello" },
    });
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector: { inject: jest.fn() },
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:legacy": { status: "active", activity_state: "idle" },
        },
      }),
    });

    const result = await scheduler.deliverSubscriber("codex:legacy");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 0, deferred: true }));
    expect(result.reason).toBe("missing_launch_mode");
    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  test("completes non-inject envelopes without terminal injection", async () => {
    const queue = makeQueue({
      seq: 1,
      event: "delivery",
      queue_type: "delivery_status",
      delivery: { mode: "daemon_consume", gate: "none" },
      data: { status: "ok" },
    });
    const injector = { inject: jest.fn() };
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:one": { status: "active", activity_state: "ready", launch_mode: "terminal" },
        },
      }),
    });

    const result = await scheduler.deliverSubscriber("codex:one");

    expect(result).toEqual(expect.objectContaining({ ok: true, skipped: true }));
    expect(result.reason).toBe("unsupported_delivery_mode");
    expect(injector.inject).not.toHaveBeenCalled();
    expect(queue.completeClaim).toHaveBeenCalledWith(queue.claim);
  });

  test("restores claim when state becomes busy after claim", async () => {
    const queue = makeQueue({
      seq: 1,
      event: "message",
      data: { message: "hello" },
    });
    let calls = 0;
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector: { inject: jest.fn() },
      queueFactory: () => queue,
      readAgents: () => {
        calls += 1;
        return {
          agents: {
            "codex:race": {
              status: "active",
              launch_mode: "terminal",
              activity_state: calls <= 1 ? "idle" : "working",
            },
          },
        };
      },
    });

    const result = await scheduler.deliverSubscriber("codex:race");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 0, deferred: true }));
    expect(queue.claimNext).toHaveBeenCalledTimes(1);
    expect(queue.restoreClaim).toHaveBeenCalledWith(queue.claim);
  });

  test("restores claim when injection fails", async () => {
    const event = {
      seq: 1,
      event: "message",
      data: { message: "hello" },
    };
    const queue = makeQueue(event);
    const emitDelivery = jest.fn().mockResolvedValue(undefined);
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector: { inject: jest.fn().mockRejectedValue(new Error("no tty")) },
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:fail": { status: "active", activity_state: "ready", launch_mode: "terminal" },
        },
      }),
      emitDelivery,
    });

    const result = await scheduler.deliverSubscriber("codex:fail");

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      delivered: 0,
      reason: "inject_failed",
    }));
    expect(queue.restoreClaim).toHaveBeenCalledWith(queue.claim);
    expect(queue.completeClaim).not.toHaveBeenCalled();
    expect(emitDelivery).toHaveBeenCalledWith(expect.objectContaining({
      subscriber: "codex:fail",
      status: "error",
      error: "no tty",
      event: expect.objectContaining({
        seq: event.seq,
        queue_type: "agent_message",
        delivery: expect.objectContaining({ mode: "inject", gate: "idle" }),
      }),
    }));
  });

  test("logs gate deferral once per reason and warns after sustained defer", async () => {
    let now = 1000000;
    let activityState = "working";
    const log = jest.fn();
    const queue = makeQueue(null);
    queue.readPending.mockReturnValue([{ seq: 1 }, { seq: 2 }]);
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector: { inject: jest.fn() },
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:busy": { status: "active", activity_state: activityState, launch_mode: "terminal" },
        },
      }),
      log,
      now: () => now,
      deferWarnAfterMs: 1000,
      warnIntervalMs: 1000,
    });

    await scheduler.deliverSubscriber("codex:busy");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("delivery deferred subscriber=codex:busy reason=working pending=2");

    now += 500;
    await scheduler.deliverSubscriber("codex:busy");
    expect(log).toHaveBeenCalledTimes(1); // debounced while reason is unchanged

    now += 600; // 1100ms into the same deferral
    await scheduler.deliverSubscriber("codex:busy");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain("WARN delivery still deferred subscriber=codex:busy reason=working pending=2");

    now += 500;
    await scheduler.deliverSubscriber("codex:busy");
    expect(log).toHaveBeenCalledTimes(2); // warn interval not reached yet

    activityState = "paused";
    await scheduler.deliverSubscriber("codex:busy");
    expect(log).toHaveBeenCalledTimes(3); // reason change logs again
    expect(log.mock.calls[2][0]).toContain("delivery deferred subscriber=codex:busy reason=paused");
  });

  test("delivers after blocked state exceeds the grace period", async () => {
    const now = Date.parse("2026-01-01T00:20:00.000Z");
    const event = { seq: 1, event: "message", data: { message: "hello" } };
    const queue = makeQueue(event);
    const injector = { inject: jest.fn().mockResolvedValue(undefined) };
    const log = jest.fn();
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:stuck": {
            status: "active",
            activity_state: "blocked",
            activity_since: "2026-01-01T00:00:00.000Z",
            launch_mode: "terminal",
          },
        },
      }),
      log,
      now: () => now,
      blockedGraceMs: 15 * 60 * 1000,
    });

    const result = await scheduler.deliverSubscriber("codex:stuck");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
    expect(injector.inject).toHaveBeenCalledTimes(1);
    const graceLogs = log.mock.calls.filter(([msg]) => msg.includes("grace override"));
    expect(graceLogs).toHaveLength(1);
    expect(graceLogs[0][0]).toContain("subscriber=codex:stuck activity_state=blocked");

    await scheduler.deliverSubscriber("codex:stuck");
    expect(log.mock.calls.filter(([msg]) => msg.includes("grace override"))).toHaveLength(1); // warn once per stuck episode
  });

  test("uses first-observed time for the grace period when activity_since is missing", async () => {
    let now = 1000000;
    const event = { seq: 1, event: "message", data: { message: "hello" } };
    const queue = makeQueue(event);
    const injector = { inject: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:waiting": { status: "active", activity_state: "waiting_input", launch_mode: "terminal" },
        },
      }),
      now: () => now,
      blockedGraceMs: 1000,
      deferWarnAfterMs: 60 * 60 * 1000,
    });

    const first = await scheduler.deliverSubscriber("codex:waiting");
    expect(first).toEqual(expect.objectContaining({ deferred: true, reason: "waiting_input" }));
    expect(injector.inject).not.toHaveBeenCalled();

    now += 1001;
    const second = await scheduler.deliverSubscriber("codex:waiting");
    expect(second).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
    expect(injector.inject).toHaveBeenCalledTimes(1);
  });

  test("warns when an inject lock is held beyond the threshold", async () => {
    let now = 1000000;
    const event = { seq: 1, event: "message", data: { message: "hello" } };
    const queue = makeQueue(event);
    let releaseInject;
    const injector = { inject: jest.fn(() => new Promise((resolve) => { releaseInject = resolve; })) };
    const log = jest.fn();
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:one": { status: "active", activity_state: "idle", launch_mode: "terminal" },
        },
      }),
      log,
      now: () => now,
      lockedWarnAfterMs: 1000,
      warnIntervalMs: 1000,
    });

    const inflight = scheduler.deliverSubscriber("codex:one"); // holds the lock inside inject

    const firstLocked = await scheduler.deliverSubscriber("codex:one");
    expect(firstLocked).toEqual(expect.objectContaining({ deferred: true, reason: "locked" }));
    expect(log.mock.calls.filter(([msg]) => msg.includes("lock held"))).toHaveLength(0);

    now += 1500;
    await scheduler.deliverSubscriber("codex:one");
    const lockWarnings = () => log.mock.calls.filter(([msg]) => msg.includes("lock held"));
    expect(lockWarnings()).toHaveLength(1);
    expect(lockWarnings()[0][0]).toContain("subscriber=codex:one");

    now += 500;
    await scheduler.deliverSubscriber("codex:one");
    expect(lockWarnings()).toHaveLength(1); // warn interval debounce

    now += 1100;
    await scheduler.deliverSubscriber("codex:one");
    expect(lockWarnings()).toHaveLength(2);

    releaseInject();
    const result = await inflight;
    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));

    injector.inject.mockResolvedValue(undefined);
    const after = await scheduler.deliverSubscriber("codex:one");
    expect(after).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
  });
});

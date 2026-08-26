const { DeliveryScheduler, isDeliverableActivityState } = require("../../../src/runtime/daemon/deliveryScheduler");

function makeQueue(event) {
  const events = Array.isArray(event) ? event : (event ? [event] : []);
  const queue = {
    claim: events[0] ? { event: events[0], processingFile: "/tmp/claim" } : null,
    claimNext: jest.fn((predicate) => {
      const selected = typeof predicate === "function"
        ? events.find((item, index) => predicate(item, index, events))
        : events[0];
      queue.claim = selected ? { event: selected, processingFile: "/tmp/claim" } : null;
      return queue.claim;
    }),
    completeClaim: jest.fn(),
    restoreClaim: jest.fn(),
    readPending: jest.fn(() => events.slice()),
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
    const markWorking = jest.fn();
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:one": { status: "active", activity_state: "idle", launch_mode: "terminal" },
        },
      }),
      emitDelivery,
      markWorking,
    });

    const result = await scheduler.deliverSubscriber("codex:one");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
    expect(queue.claimNext).toHaveBeenCalledTimes(1);
    expect(injector.inject).toHaveBeenCalledWith("codex:one", "[ufoo]<from:ufoo-agent>\nhello");
    expect(queue.completeClaim).toHaveBeenCalledWith(queue.claim);
    expect(queue.restoreClaim).not.toHaveBeenCalled();
    expect(markWorking).toHaveBeenCalledWith("codex:one");
    expect(emitDelivery).toHaveBeenCalledWith(expect.objectContaining({
      subscriber: "codex:one",
      status: "ok",
      event: expect.objectContaining({
        seq: event.seq,
        queue_type: "agent_message",
        delivery: expect.objectContaining({ mode: "inject", gate: "none" }),
      }),
    }));
  });

  test("busy subscriber leaves queue untouched", async () => {
    const queue = makeQueue({
      seq: 1,
      event: "message",
      data: { message: "hello", injection_mode: "queued" },
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

  test("busy Grok subscriber receives an immediate message despite stale idle-gate metadata", async () => {
    const event = {
      seq: 2,
      event: "message",
      publisher: "ufoo-agent",
      data: { message: "interrupt now", injection_mode: "immediate" },
      delivery: { mode: "inject", gate: "idle", max_inflight: 1 },
    };
    const queue = makeQueue(event);
    const injector = { inject: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "grok:busy": { status: "active", activity_state: "working", launch_mode: "terminal" },
        },
      }),
    });

    const result = await scheduler.deliverSubscriber("grok:busy");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
    expect(injector.inject).toHaveBeenCalledWith(
      "grok:busy",
      "[ufoo]<from:ufoo-agent>\ninterrupt now"
    );
  });

  test("busy Grok subscriber can receive immediate work behind a queued message", async () => {
    const queued = {
      seq: 3,
      event: "message",
      publisher: "ufoo-agent",
      data: { message: "wait for idle", injection_mode: "queued" },
    };
    const immediate = {
      seq: 4,
      event: "message",
      publisher: "ufoo-agent",
      data: { message: "deliver first", injection_mode: "immediate" },
    };
    const queue = makeQueue([queued, immediate]);
    const injector = { inject: jest.fn().mockResolvedValue(undefined) };
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "grok:busy": { status: "active", activity_state: "working", launch_mode: "terminal" },
        },
      }),
    });

    const result = await scheduler.deliverSubscriber("grok:busy");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
    expect(queue.claim.event.seq).toBe(4);
    expect(injector.inject).toHaveBeenCalledWith(
      "grok:busy",
      "[ufoo]<from:ufoo-agent>\ndeliver first"
    );
  });

  test("forces wrapper injection after the oldest message waits five minutes", async () => {
    const now = Date.parse("2026-01-01T00:05:00.001Z");
    const event = {
      seq: 7,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "message",
      publisher: "ufoo-agent",
      data: { message: "timeout fallback", injection_mode: "queued" },
    };
    const queue = makeQueue(event);
    queue.readPending.mockReturnValue([event]);
    const injector = { inject: jest.fn().mockResolvedValue(undefined) };
    const log = jest.fn();
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:stale": {
            status: "active",
            activity_state: "starting",
            launch_mode: "terminal",
          },
        },
      }),
      log,
      now: () => now,
      forceDeliveryAfterMs: 5 * 60 * 1000,
    });

    const result = await scheduler.deliverSubscriber("codex:stale");

    expect(result).toEqual(expect.objectContaining({ ok: true, delivered: 1 }));
    expect(injector.inject).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(
      "delivery queue timeout override subscriber=codex:stale activity_state=starting seq=7"
    ));
    expect(scheduler.pendingSeen.size).toBe(0);
    expect(scheduler.forceWarned.size).toBe(0);
  });

  test("does not force wrapper injection before the five-minute timeout", async () => {
    const now = Date.parse("2026-01-01T00:04:59.999Z");
    const event = {
      seq: 8,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "message",
      data: { message: "still waiting", injection_mode: "queued" },
    };
    const queue = makeQueue(event);
    queue.readPending.mockReturnValue([event]);
    const injector = { inject: jest.fn() };
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:busy": {
            status: "active",
            activity_state: "working",
            launch_mode: "terminal",
          },
        },
      }),
      now: () => now,
      forceDeliveryAfterMs: 5 * 60 * 1000,
    });

    const result = await scheduler.deliverSubscriber("codex:busy");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      delivered: 0,
      deferred: true,
      reason: "working",
    }));
    expect(injector.inject).not.toHaveBeenCalled();
    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  test("backs off after a forced injection fails instead of retrying every tick", async () => {
    let now = Date.parse("2026-01-01T00:05:01.000Z");
    const event = {
      seq: 10,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "message",
      data: { message: "retry with backoff", injection_mode: "queued" },
    };
    const queue = makeQueue(event);
    queue.readPending.mockReturnValue([event]);
    const injector = { inject: jest.fn().mockRejectedValue(new Error("host unavailable")) };
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:stale": {
            status: "active",
            activity_state: "starting",
            launch_mode: "terminal",
          },
        },
      }),
      now: () => now,
      forceDeliveryAfterMs: 5 * 60 * 1000,
      forceRetryBaseMs: 5000,
      forceRetryMaxMs: 60000,
    });

    const first = await scheduler.deliverSubscriber("codex:stale");
    const deferred = await scheduler.deliverSubscriber("codex:stale");

    expect(first).toEqual(expect.objectContaining({ ok: false, reason: "inject_failed" }));
    expect(deferred).toEqual(expect.objectContaining({
      ok: true,
      deferred: true,
      reason: "force_retry_backoff",
    }));
    expect(injector.inject).toHaveBeenCalledTimes(1);
    expect(queue.claimNext).toHaveBeenCalledTimes(1);

    now += 5000;
    await scheduler.deliverSubscriber("codex:stale");
    expect(injector.inject).toHaveBeenCalledTimes(2);
  });

  test("cleans timeout tracking when a queued event disappears", () => {
    const event = {
      seq: 11,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "message",
      data: { message: "removed", injection_mode: "queued" },
    };
    const queue = makeQueue(event);
    queue.readPending.mockReturnValueOnce([event]).mockReturnValue([]);
    const scheduler = new DeliveryScheduler("/tmp/project", {
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:stale": {
            status: "active",
            activity_state: "starting",
            launch_mode: "terminal",
          },
        },
      }),
      now: () => Date.parse("2026-01-01T00:10:00.000Z"),
      forceDeliveryAfterMs: 5 * 60 * 1000,
    });

    scheduler.resolveGate("codex:stale", queue);
    expect(scheduler.pendingSeen.size).toBe(1);
    expect(scheduler.forceWarned.size).toBe(1);

    expect(scheduler.listPendingSubscribers()).toEqual([]);
    expect(scheduler.pendingSeen.size).toBe(0);
    expect(scheduler.forceWarned.size).toBe(0);
    expect(scheduler.forceRetries.size).toBe(0);
  });

  test("never direct-injects an MCP Agent even when its message is old", async () => {
    const now = Date.parse("2026-01-01T01:00:00.000Z");
    const event = {
      seq: 9,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "message",
      data: { message: "external receive" },
    };
    const queue = makeQueue(event);
    queue.readPending.mockReturnValue([event]);
    const injector = { inject: jest.fn() };
    const scheduler = new DeliveryScheduler("/tmp/project", {
      injector,
      queueFactory: () => queue,
      readAgents: () => ({
        agents: {
          "codex:external": {
            status: "active",
            activity_state: "ready",
            launch_mode: "external-mcp",
            mcp_bridge: true,
          },
        },
      }),
      now: () => now,
      forceDeliveryAfterMs: 5 * 60 * 1000,
    });

    const result = await scheduler.deliverSubscriber("codex:external");

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      delivered: 0,
      deferred: true,
      reason: "external_receive",
    }));
    expect(injector.inject).not.toHaveBeenCalled();
    expect(queue.claimNext).not.toHaveBeenCalled();
    expect(scheduler.listPendingSubscribers()).toEqual([]);
  });

  test("missing launch mode leaves queue untouched", async () => {
    const queue = makeQueue({
      seq: 1,
      event: "message",
      data: { message: "hello", injection_mode: "queued" },
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
      data: { message: "hello", injection_mode: "queued" },
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
              activity_state: calls <= 2 ? "idle" : "working",
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
        delivery: expect.objectContaining({ mode: "inject", gate: "none" }),
      }),
    }));
  });

  test("logs gate deferral once per reason and warns after sustained defer", async () => {
    let now = 1000000;
    let activityState = "working";
    const log = jest.fn();
    const queue = makeQueue(null);
    queue.readPending.mockReturnValue([
      { seq: 1, event: "message", data: { message: "first", injection_mode: "queued" } },
      { seq: 2, event: "message", data: { message: "second", injection_mode: "queued" } },
    ]);
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
    const event = {
      seq: 1,
      event: "message",
      data: { message: "hello", injection_mode: "queued" },
    };
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
    const event = {
      seq: 1,
      event: "message",
      data: { message: "hello", injection_mode: "queued" },
    };
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

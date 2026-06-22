const { DeliveryScheduler, isDeliverableActivityState } = require("../../../src/runtime/daemon/deliveryScheduler");

function makeQueue(event) {
  const queue = {
    claim: event ? { event, processingFile: "/tmp/claim" } : null,
    claimNext: jest.fn(() => queue.claim),
    completeClaim: jest.fn(),
    restoreClaim: jest.fn(),
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
});

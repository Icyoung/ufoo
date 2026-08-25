"use strict";

const {
  createUcodeController,
  createThinkingStatusPublisher,
} = require("../../../src/code/UcodeController");

describe("UcodeController", () => {
  test("runExclusive serializes tasks and exposes busy", async () => {
    const controller = createUcodeController({ projectRoot: process.cwd() });
    controller.start();
    const order = [];
    const first = controller.runExclusive(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("a-end");
      return 1;
    });
    expect(controller.isBusy()).toBe(true);
    const second = controller.runExclusive(async () => {
      order.push("b");
      return 2;
    });
    const values = await Promise.all([first, second]);
    expect(values).toEqual([1, 2]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
    expect(controller.isBusy()).toBe(false);
    controller.stop();
  });

  test("cancelTask aborts the active exclusive slot", async () => {
    const controller = createUcodeController({ projectRoot: process.cwd() });
    controller.start();
    const run = controller.runExclusive(async (abort) => {
      await new Promise((resolve, reject) => {
        abort.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(resolve, 500);
      });
    });
    controller.cancelTask();
    await expect(run).rejects.toThrow(/aborted/);
    controller.stop();
  });

  test("cancelTask targets the active task while preserving queued FIFO work", async () => {
    const controller = createUcodeController({ projectRoot: process.cwd() });
    controller.start();
    const order = [];
    let releaseFirst;
    const first = controller.runExclusive(async (task) => {
      order.push("first-start");
      await new Promise((resolve, reject) => {
        releaseFirst = resolve;
        task.signal.addEventListener("abort", () => reject(new Error("first aborted")), { once: true });
      });
    }, { kind: "prompt", label: "first" });
    const second = controller.runExclusive(async () => {
      order.push("second-ran");
      return "second";
    }, { kind: "prompt", label: "second" });

    await new Promise((resolve) => setImmediate(resolve));
    expect(controller.getQueueSnapshot().active.label).toBe("first");
    expect(controller.getQueueSnapshot().queuedCount).toBe(1);
    expect(controller.cancelTask()).toBe(true);
    await expect(first).rejects.toThrow(/first aborted/);
    expect(await second).toBe("second");
    expect(order).toEqual(["first-start", "second-ran"]);
    expect(controller.isBusy()).toBe(false);
    expect(releaseFirst).toBeDefined();
    controller.stop();
  });

  test("clearQueue resolves pending tasks without executing them", async () => {
    const controller = createUcodeController({ projectRoot: process.cwd() });
    controller.start();
    let release;
    const first = controller.runExclusive((task) => new Promise((resolve, reject) => {
      release = resolve;
      task.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    let secondRan = false;
    const second = controller.runExclusive(async () => {
      secondRan = true;
      return 2;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(controller.clearQueue()).toBe(1);
    expect(await second).toBeNull();
    expect(secondRan).toBe(false);
    controller.cancelTask();
    await expect(first).rejects.toThrow(/aborted/);
    release?.();
    controller.stop();
  });

  test("pauses queued work for confirmation and lets a priority reply resume first", async () => {
    const controller = createUcodeController({ projectRoot: process.cwd() });
    controller.start();
    controller.pauseQueue("waiting for reply");
    const order = [];
    const queued = controller.runExclusive(async () => {
      order.push("queued");
      return "queued";
    }, { kind: "prompt", label: "queued" });
    const reply = controller.runExclusive(async () => {
      order.push("reply");
      return "reply";
    }, { kind: "interaction", label: "reply", priority: true });

    expect(controller.getQueueSnapshot()).toMatchObject({
      paused: true,
      pausedReason: "waiting for reply",
      activeBusy: false,
      queuedCount: 2,
    });
    controller.resumeQueue();
    expect(await reply).toBe("reply");
    expect(await queued).toBe("queued");
    expect(order).toEqual(["reply", "queued"]);
    controller.stop();
  });
});

describe("createThinkingStatusPublisher", () => {
  test("throttles thinking deltas into a stable Thinking status", async () => {
    const events = [];
    const thinking = createThinkingStatusPublisher(
      (name, payload) => events.push({ name, payload }),
      { intervalMs: 30 }
    );
    thinking.onThinkingDelta("hello ");
    thinking.onThinkingDelta("world");
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toContainEqual({
      name: "status.set",
      payload: { text: "Thinking…", busy: true },
    });
    thinking.reset();
  });
});

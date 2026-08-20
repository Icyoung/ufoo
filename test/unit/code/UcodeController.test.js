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

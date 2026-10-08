"use strict";

const { createTaskScheduler } = require("../../../src/agents/runtime");

describe("shared task scheduler", () => {
  test("serializes a shared writer resource and runs independent work concurrently", async () => {
    const scheduler = createTaskScheduler({ maxConcurrent: 2 });
    const calls = [];
    let release;
    const first = scheduler.schedule({ id: "write-a", resourceKey: "project-a" }, () => {
      calls.push("a"); return new Promise((resolve) => { release = resolve; });
    });
    const second = scheduler.schedule({ id: "write-b", resourceKey: "project-a" }, () => { calls.push("b"); return "b"; });
    const independent = scheduler.schedule({ id: "read-c" }, () => { calls.push("c"); return "c"; });
    await independent;
    expect(calls).toEqual(["a", "c"]);
    expect(scheduler.snapshot().jobs.find((job) => job.id === "write-b").status).toBe("queued");
    release("a");
    await first;
    expect(await second).toBe("b");
    await scheduler.close();
  });
  test("cancels queued work before it can perform effects and bounds queue size", async () => {
    const scheduler = createTaskScheduler({ maxConcurrent: 1, maxQueued: 1 });
    let release;
    const first = scheduler.schedule({ id: "first" }, () => new Promise((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const work = jest.fn();
    const queued = scheduler.schedule({ id: "queued", signal: controller.signal }, work);
    await expect(scheduler.schedule({ id: "overflow" }, work)).rejects.toMatchObject({ code: "queue_full" });
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    expect(work).not.toHaveBeenCalled();
    release(); await first; await scheduler.close();
  });
});

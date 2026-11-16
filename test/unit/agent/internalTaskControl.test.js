"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const EventBus = require("../../../src/coordination/bus");
const { DeliveryQueue } = require("../../../src/coordination/bus/deliveryQueue");
const { createTaskControl, startTaskControlServer, cancelInternalTask } = require("../../../src/agents/internal/taskControl");

test("cancel interrupts the active turn while preserving worker, queued messages and the next turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-task-control-"));
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  let server;
  try {
    const bus = new EventBus(root); await bus.init();
    const id = await bus.join("child", "codex", "child", { launchMode: "internal", parentPid: process.pid });
    const external = await bus.join("outside", "ucode", "outside", { launchMode: "terminal", parentPid: process.pid });
    const queue = DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), id);
    queue.append({ seq: 1, event: "message", data: { message: "next task" } });
    const parent = new AbortController();
    const control = createTaskControl(parent.signal);
    server = await startTaskControlServer(root, id, control);
    await expect(startTaskControlServer(root, id, control)).rejects.toThrow("already running");
    expect(await cancelInternalTask(root, id)).toEqual({ ok: true, cancelled: false });
    const turn = control.run(signal => new Promise(resolve => signal.addEventListener("abort", () => resolve(signal.reason), { once: true })));
    expect(await cancelInternalTask(root, external)).toMatchObject({ ok: false });
    expect(await cancelInternalTask(root, id)).toEqual({ ok: true, cancelled: true });
    expect(await turn).toBe("user_cancelled");
    expect(parent.signal.aborted).toBe(false);
    expect(queue.readPending()).toHaveLength(1);
    expect(await control.run(async signal => signal.aborted)).toBe(false);
    parent.abort("shutdown");
    expect(await control.run(async signal => signal.reason)).toBe("shutdown");
    await server.close(); server = null;
    expect(await cancelInternalTask(root, id)).toMatchObject({ ok: false, error: expect.stringContaining("restart") });
  } finally { if (server) await server.close(); log.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
});

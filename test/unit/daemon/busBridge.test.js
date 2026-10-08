"use strict";

const { startBusBridge } = require("../../../src/runtime/daemon");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DeliveryQueue } = require("../../../src/coordination/bus/deliveryQueue");
const { enqueueAgentReport } = require("../../../src/runtime/daemon/reportControlBus");
const { recordAgentReport } = require("../../../src/runtime/daemon/reporting");

describe("daemon bus bridge", () => {
  test("adding a watch preserves pending events and late appends/partial UTF-8 rows are not lost", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-observation-tail-"));
    const bus = new (require("../../../src/coordination/bus"))(root);
    await bus.init();
    const child = await bus.join("child", "codex", "coder", { launchMode: "internal" });
    const peer = await bus.join("peer", "claude-code", "peer", { launchMode: "internal" });
    const received = [];
    const bridge = startBusBridge(root, "codex-cli", (event) => received.push(event), () => {}, () => true, null,
      { eventBus: { join: async () => "ufoo-agent" }, internalOnly: true });
    const file = path.join(root, ".ufoo/bus/events", `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const row = (seq, text) => Buffer.from(JSON.stringify({ seq, event: "agent_surface", publisher: child, target: "*",
      data: { subscriber: child, surface: { type: "text_delta", delta: text } } }) + "\n");
    try {
      bridge.watchAgent(child);
      fs.appendFileSync(file, row(100, "first"));
      fs.writeFileSync(path.join(root, ".ufoo/bus/seq.counter"), "100");
      bridge.watchAgent(peer);
      await bridge.refresh();
      expect(received.map((event) => event.data.surface.delta)).toEqual(["first"]);
      const late = row(99, "你好🙂");
      const split = late.indexOf(Buffer.from("🙂")) + 1;
      fs.appendFileSync(file, late.subarray(0, split));
      await bridge.refresh();
      expect(received).toHaveLength(1);
      fs.appendFileSync(file, late.subarray(split));
      await bridge.refresh();
      await bridge.refresh();
      expect(received.map((event) => event.data.surface.delta)).toEqual(["first", "你好🙂"]);
    } finally { bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("internal main does not wake or display wrapper/MCP messages and cannot watch them", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-internal-bridge-"));
    const EventBus = require("../../../src/coordination/bus");
    const bus = new EventBus(root);
    await bus.init();
    const child = await bus.join("child", "codex", "coder", { launchMode: "internal" });
    const wrapper = await bus.join("wrapper", "codex", "outside", { launchMode: "terminal" });
    const onMessage = jest.fn().mockResolvedValue({ accepted: true });
    const onEvent = jest.fn();
    const bridge = startBusBridge(root, "codex-cli", onEvent, jest.fn(), () => true, null,
      { eventBus: { join: async () => "ufoo-agent" }, internalOnly: true, onMessage });
    try {
      const queue = DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), "ufoo-agent");
      queue.append({ seq: 1, event: "message", publisher: wrapper, data: { message: "external noise" } });
      queue.append({ seq: 2, event: "message", publisher: child, data: { message: "child progress" } });
      await bridge.refresh();
      expect(queue.readPending()).toHaveLength(0);
      expect(onMessage).toHaveBeenCalledTimes(1);
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ publisher: child }));
      expect(onEvent).toHaveBeenCalledTimes(1);
      onEvent.mockClear();
      bridge.watchAgent(wrapper);
      await bus.send(child, "external pane noise", wrapper);
      await bridge.refresh();
      expect(onEvent).not.toHaveBeenCalled();
    } finally { bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("background main input is acknowledged only after durable acceptance without a UI client", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-bridge-input-"));
    const accept = jest.fn().mockRejectedValueOnce(new Error("journal unavailable")).mockResolvedValue({ accepted: true });
    const bridge = startBusBridge(root, "codex-cli", jest.fn(), jest.fn(), () => false, null,
      { eventBus: { join: async () => "ufoo-agent" }, onMessage: accept });
    try {
      const queue = DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), "ufoo-agent");
      queue.append({ seq: 1, event: "message", publisher: "codex:worker", data: { message: "background update" } });
      await bridge.refresh();
      expect(queue.readPending()).toHaveLength(1);
      await bridge.refresh();
      expect(queue.readPending()).toHaveLength(0);
      expect(accept).toHaveBeenCalledTimes(2);
    } finally { bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  test("ordinary replies keep a task pending until an explicit terminal report", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-bridge-lifecycle-"));
    const onStatus = jest.fn();
    const onEvent = jest.fn();
    const bridge = startBusBridge(root, "codex-cli", onEvent, onStatus, () => true,
      (report) => recordAgentReport({ projectRoot: root, report }),
      { eventBus: { join: async () => "ufoo-agent" } });
    try {
      bridge.markPending("codex:worker");
      DeliveryQueue.forSubscriber(path.join(root, ".ufoo", "bus"), "ufoo-agent").append({
        seq: 1, event: "message", publisher: "codex:worker", data: { message: "starting now" },
      });
      await bridge.refresh();
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onStatus.mock.calls.map(([event]) => event.phase)).toEqual(["start"]);
      await enqueueAgentReport(root, { agent_id: "codex:worker", task_id: "work", phase: "done" });
      await bridge.refresh();
      expect(onStatus.mock.calls.map(([event]) => event.phase)).toEqual(["start", "done"]);
    } finally {
      bridge.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  test("contains subscriber join failures even when diagnostics also fail", async () => {
    const joinError = Object.assign(new Error("project directory disappeared"), {
      code: "ENOENT",
    });
    const eventBus = {
      join: jest.fn(async () => {
        throw joinError;
      }),
    };
    const onJoinError = jest.fn(() => {
      throw new Error("diagnostic sink unavailable");
    });
    const bridge = startBusBridge(
      "/tmp/ufoo-deleted-project",
      "codex-cli",
      () => {},
      () => {},
      () => false,
      null,
      { eventBus, onJoinError }
    );

    try {
      await expect(bridge.refresh()).resolves.toBeUndefined();
      await expect(bridge.refresh()).resolves.toBeUndefined();
      expect(eventBus.join).toHaveBeenCalledTimes(2);
      expect(onJoinError).toHaveBeenCalledTimes(1);
      expect(bridge.getSubscriber()).toBeNull();
    } finally {
      bridge.stop();
    }
  });
});

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const EventBus = require("../../src/coordination/bus");
const { DeliveryQueue } = require("../../src/coordination/bus/deliveryQueue");
const { createBusSender, handleEvent } = require("../../src/agents/internal/internalRunner");
const { createAgentSurfaceReader } = require("../../src/coordination/history/agentSurface");
const { createAgentSurface } = require("../../src/ui/agentSurface");
const { ackBusHandler } = require("../../src/tools/handlers/ackBus");

test.each([
  ["codex", "codex-cli"],
  ["claude-code", "claude-cli"],
  ["ucode", "ucode"],
])("internal %s retains later user messages when a running task invokes CLI/MCP ack", async (agentType, provider) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-internal-ack-"));
  const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  const bus = new EventBus(root);
  let sender;
  try {
    await bus.init();
    const subscriber = await bus.join("reviewer", agentType, "reviewer", {
      launchMode: "internal", parentPid: process.pid,
    });
    const peer = await bus.join("builder", "codex", "builder", {
      launchMode: "internal", parentPid: process.pid,
    });
    const queue = DeliveryQueue.forSubscriber(bus.busDir, subscriber);
    const surface = createAgentSurface();
    const reader = createAgentSurfaceReader(root);
    const updateSurface = () => {
      for (const event of reader.read([subscriber])) surface.accept(event.data.surface);
    };
    sender = createBusSender(root, subscriber);
    await bus.send(subscriber, "old task", peer, { silent: true });
    const first = queue.claimNext();
    const queuedMessages = ["use the UI automation skill", "check the supplied design"];
    const handled = [];
    let cliResult;
    let boundedCliResult;
    let mcpResult;
    let pendingAfterAck;
    let claimRetained;
    const runtime = { enabled: true, thread: { runStreamed: async function* () {
      yield { type: "turn_started" };
      if (!handled.length) {
        for (const message of queuedMessages) {
          surface.accept({ type: "task_submitted", message });
          await bus.send(subscriber, message, peer, { silent: true, source: "rust-multi-window" });
        }
        const latestSeq = queue.readPending().at(-1).seq;
        const invokeAck = (extra = []) => spawnSync(process.execPath, [
          path.resolve(__dirname, "../../bin/ufoo.js"), "bus", "ack", subscriber, ...extra,
        ], {
          cwd: root, encoding: "utf8", timeout: 4000,
          env: { ...process.env, UFOO_SUBSCRIBER_ID: subscriber, UFOO_LAUNCH_MODE: "internal" },
        });
        cliResult = invokeAck();
        boundedCliResult = invokeAck(["--through", String(latestSeq)]);
        mcpResult = await ackBusHandler({ projectRoot: root, subscriber, eventBus: bus }, { through_seq: latestSeq });
        pendingAfterAck = queue.readPending().map((event) => event.data.message);
        claimRetained = fs.existsSync(first.processingFile);
      }
      yield { type: "turn_completed", finalText: "" };
    } } };
    const execute = async (claim) => {
      const result = await handleEvent(root, agentType, provider, "", subscriber, "reviewer",
        claim.event, sender, [], runtime);
      expect(result.ok).toBe(true);
      handled.push(claim.event.data.message);
      updateSurface();
      queue.completeClaim(claim);
    };

    await execute(first);
    expect(cliResult.error).toBeUndefined();
    expect(cliResult.status).toBe(0);
    expect(boundedCliResult.error).toBeUndefined();
    expect(boundedCliResult.status).toBe(0);
    expect(pendingAfterAck).toEqual(queuedMessages);
    expect(claimRetained).toBe(true);
    expect(mcpResult).toMatchObject({ ok: true, acknowledged: 0 });
    expect(surface.snapshot()).toMatchObject({ busy: true, status: "Waiting for agent… · queued 2" });

    await execute(queue.claimNext());
    expect(queue.readPending().map((event) => event.data.message)).toEqual([queuedMessages[1]]);
    await execute(queue.claimNext());
    expect(handled).toEqual(["old task", ...queuedMessages]);
    expect(queue.claimNext()).toBeNull();
    expect(surface.snapshot()).toMatchObject({ busy: false, status: "ready" });
  } finally {
    if (sender) await sender.flush();
    logSpy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);

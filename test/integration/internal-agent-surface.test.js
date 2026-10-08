"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const EventBus = require("../../src/coordination/bus");
const { createBusSender, handleEvent } = require("../../src/agents/internal/internalRunner");
const { startBusBridge } = require("../../src/runtime/daemon/busBridge");
const { createRustMultiSession } = require("../../src/ui/rustMultiSession");
const { writeMultiPaneBusEvent } = require("../../src/ui/multiPaneBusMirror");
const { DeliveryQueue } = require("../../src/coordination/bus/deliveryQueue");

test("peer task output reaches the hidden surface before completion, survives layout changes and never wakes main", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-agent-surface-"));
  const bus = new EventBus(root);
  await bus.init();
  const child = await bus.join("child", "codex", "coder", { launchMode: "internal", parentPid: process.pid });
  const peer = await bus.join("peer", "claude-code", "peer", { launchMode: "internal", parentPid: process.pid });
  const meta = (id) => JSON.parse(fs.readFileSync(path.join(root, ".ufoo/agent/all-agents.json"), "utf8")).agents[id];
  const frames = [];
  const session = createRustMultiSession({ projectRoot: root, getActiveAgents: () => [child, peer], getAgentMeta: meta,
    publish: () => {}, publishLossy: (name, payload) => frames.push(payload) });
  const onMessage = jest.fn();
  const bridge = startBusBridge(root, "codex-cli", (data) => writeMultiPaneBusEvent(data, {
    agentIds: session.listInternalAgentIds(), getMeta: meta, acceptEvent: session.acceptEvent,
    hasStructuredEvents: session.hasStructuredEvents,
  }), () => {}, () => true, null, { eventBus: { join: async () => "ufoo-agent" }, internalOnly: true, onMessage });
  const sender = createBusSender(root, child);
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let running;
  try {
    session.syncAgents();
    bridge.watchAgent(child);
    running = handleEvent(root, "codex", "codex-cli", "", child, "coder",
      { publisher: peer, data: { message: "peer task" } }, sender, [], {
        enabled: true, thread: { runStreamed: async function* () {
          yield { type: "text_delta", delta: "VISIBLE_BEFORE_DONE" };
          await paused;
          yield { type: "tool_call", toolCallId: "cmd", name: "bash", args: { command: "ls" } };
          yield { type: "tool_result", toolCallId: "cmd", output: "a.js\nb.js" };
          yield { type: "text_delta", delta: "FINISHED" };
        } },
      });
    // Flush the observation writer while the provider is deliberately paused.
    await new Promise((resolve) => setImmediate(resolve));
    await sender.flush();
    await bridge.refresh();
    expect(session.isActive()).toBe(false);
    session.setLayout("single", child);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.at(-1)).toMatchObject({ busy: true, entries: expect.arrayContaining([
      expect.objectContaining({ kind: "assistant", text: "VISIBLE_BEFORE_DONE" }),
    ]) });
    expect(onMessage).not.toHaveBeenCalled();
    expect(DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), peer).readPending()).toHaveLength(0);
    release(); await running;
    await bridge.refresh();
    session.setLayout("main");
    session.setLayout("all");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const childFrame = frames.filter((frame) => frame.agent_id === child).at(-1);
    expect(childFrame.busy).toBe(false);
    expect(childFrame.entries.filter((row) => row.kind === "assistant").map((row) => row.text)).toEqual(["VISIBLE_BEFORE_DONE", "FINISHED"]);
    expect(childFrame.entries.find((row) => row.kind === "tool").detail).toContain("a.js\nb.js");
    expect(onMessage).not.toHaveBeenCalled();
    const replies = DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), peer).readPending();
    expect(replies).toHaveLength(1);
    expect(replies[0].data.message).toBe("VISIBLE_BEFORE_DONEFINISHED");
    // A new host reconstructs the same semantic history from the durable log.
    session.stop({ clearDrafts: true });
    session.setLayout("single", child);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frames.at(-1).entries).toEqual(childFrame.entries);
  } finally {
    release(); if (running) await running;
    bridge.stop(); session.stop(); await sender.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

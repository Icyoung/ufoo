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
const { createAgentSurfaceReader } = require("../../src/coordination/history/agentSurface");

async function waitFor(predicate) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Pane did not receive provider output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a group member streams peer work into an already open pane without daemon surface IPC", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-group-surface-"));
  const bus = new EventBus(root);
  await bus.init();
  const ids = [];
  for (const name of ["architect", "builder", "reviewer"]) {
    ids.push(await bus.join(name, "codex", name, { launchMode: "internal", parentPid: process.pid }));
  }
  const [architect, builder, reviewer] = ids;
  const frames = [];
  const meta = (id) => JSON.parse(fs.readFileSync(path.join(root, ".ufoo/agent/all-agents.json"), "utf8")).agents[id];
  const session = createRustMultiSession({ projectRoot: root, getActiveAgents: () => ids,
    getAgentMeta: meta, publish: () => {}, publishLossy: (name, payload) => frames.push(payload) });
  const sender = createBusSender(root, reviewer);
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let running;
  const frame = () => frames.filter((item) => item.agent_id === reviewer).at(-1);
  try {
    session.setLayout("all");
    await waitFor(() => ids.every((id) => frames.some((item) => item.agent_id === id)));
    expect(frame().entries).toEqual([]);
    running = handleEvent(root, "codex", "codex-cli", "", reviewer, "reviewer",
      { publisher: builder, data: { message: "review the coastal scene" } }, sender, [], {
        enabled: true, thread: { runStreamed: async function* () {
          yield { type: "text_delta", delta: "REVIEW_LIVE" };
          yield { type: "tool_call", toolCallId: "check", name: "bash", args: { command: "node --check main.js" } };
          await paused;
          yield { type: "tool_result", toolCallId: "check", output: "syntax valid", exitCode: 0 };
          yield { type: "text_delta", delta: "REVIEW_FINISHED" };
        } },
      });
    await waitFor(() => frame()?.entries.some((entry) => entry.text === "REVIEW_LIVE"));
    expect(frame()).toMatchObject({ busy: true, status: "Running command…" });
    expect(frame().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user", text: "review the coastal scene" }),
      expect.objectContaining({ kind: "tool", text: expect.stringContaining("node --check main.js") }),
    ]));
    expect(DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), "ufoo-agent").readPending()).toEqual([]);
    const observations = createAgentSurfaceReader(root).read([reviewer]);
    const before = frame().entries;
    for (const event of observations) session.acceptEvent(reviewer, event.data.surface, event.seq);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(frame().entries).toEqual(before);
    release(); await running;
    await waitFor(() => !frame()?.busy && frame()?.entries.some((entry) => entry.text === "REVIEW_FINISHED"));
    expect(frame().entries.find((entry) => entry.kind === "tool").detail).toContain("syntax valid");
    expect(frame().entries.find((entry) => entry.kind === "tool").detail).not.toContain("[exit 0]");
    expect(frames.filter((item) => item.agent_id === architect).at(-1).entries).toEqual([]);
    session.setLayout("main");
    session.setLayout("single", reviewer);
    await waitFor(() => frame()?.entries.some((entry) => entry.text === "REVIEW_FINISHED"));
  } finally {
    release(); if (running) await running;
    session.stop(); await sender.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("surface tail retains split UTF-8 rows and late appends, deduplicates reads and handles replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-surface-reader-"));
  const dir = path.join(root, ".ufoo/bus/events");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "2026-10-09.jsonl");
  const reader = createAgentSurfaceReader(root);
  const row = (seq, delta, publisher = "reviewer") => Buffer.from(JSON.stringify({ seq, event: "agent_surface", publisher,
    data: { surface: { type: "text_delta", delta } } }) + "\n");
  try {
    fs.writeFileSync(file, row(10, "first"));
    expect(reader.read(["reviewer"])[0].data.surface.delta).toBe("first");
    const next = row(9, "你好🙂");
    const split = next.indexOf(Buffer.from("🙂")) + 1;
    fs.appendFileSync(file, next.subarray(0, split));
    expect(reader.read(["reviewer"])).toEqual([]);
    fs.appendFileSync(file, next.subarray(split));
    fs.appendFileSync(file, row(11, "external noise", "wrapper"));
    expect(reader.read(["reviewer"]).map((event) => event.data.surface.delta)).toEqual(["你好🙂"]);
    expect(reader.read(["reviewer"])).toEqual([]);
    fs.renameSync(file, `${file}.old`);
    fs.writeFileSync(file, row(12, "rotated"));
    expect(reader.read(["reviewer"])[0].data.surface.delta).toBe("rotated");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

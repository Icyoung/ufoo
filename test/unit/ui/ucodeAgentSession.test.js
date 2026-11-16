"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const EventBus = require("../../../src/coordination/bus");
const { DeliveryQueue } = require("../../../src/coordination/bus/deliveryQueue");
const { createUcodeAgentSession } = require("../../../src/ui/ucodeAgentSession");
const { buildUcodeAgentsSnapshot } = require("../../../src/ui/rustUcodeHost");

describe("ucode agent panes and message targets", () => {
  let root, bus, session, published, log, requestDaemon;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ucode-agent-panes-"));
    log = jest.spyOn(console, "log").mockImplementation(() => {});
    bus = new EventBus(root); await bus.init();
    await bus.join("self", "ucode", "self", { launchMode: "terminal", parentPid: process.pid });
    await bus.join("child", "codex", "child", { launchMode: "internal", parentPid: process.pid });
    await bus.join("outside", "ucode", "outside", { launchMode: "terminal", parentPid: process.pid });
    published = jest.fn();
    requestDaemon = jest.fn();
    session = createUcodeAgentSession({ projectRoot: root, getSubscriber: () => "ucode:self", publish: published, requestDaemon });
  });
  afterEach(() => { session.stop(); log.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); });
  test("close delegates the selected internal agent to its project daemon and removes its pane", async () => {
    await session.handleCommand("agent.open", { agent_id: "codex:child" });
    requestDaemon.mockImplementation(async () => {
      await bus.leave("codex:child");
      return { type: "response", opsResults: [{ action: "close", ok: true }] };
    });
    expect(await session.handleCommand("agent.close", { agent_id: "codex:child" }))
      .toEqual({ ok: true, agent_id: "codex:child" });
    expect(requestDaemon).toHaveBeenCalledWith(root, { type: "close_agent", agent_id: "codex:child" },
      expect.objectContaining({ fullResponse: true, retries: 1 }));
    expect(session.getSnapshot().panes).toEqual([]);
    expect((await session.handleCommand("agent.close", { agent_id: "codex:child" })).ok).toBe(false);
    expect(requestDaemon).toHaveBeenCalledTimes(1);
  });
  test("close rejects external, self and stale targets without contacting the daemon", async () => {
    for (const id of ["ucode:outside", "ucode:self", "missing", ""]) {
      expect((await session.handleCommand("agent.close", { agent_id: id })).ok).toBe(false);
    }
    expect(requestDaemon).not.toHaveBeenCalled();
  });
  test("close reports daemon failures and does not discard a live pane", async () => {
    await session.handleCommand("agent.open", { agent_id: "codex:child" });
    requestDaemon.mockResolvedValueOnce({ type: "response", opsResults: [{ action: "close", ok: false, error: "permission denied" }] })
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce({ type: "response", data: {} });
    expect(await session.handleCommand("agent.close", { agent_id: "codex:child" }))
      .toEqual({ ok: false, error: "permission denied" });
    expect(await session.handleCommand("agent.close", { agent_id: "codex:child" }))
      .toEqual({ ok: false, error: "daemon unavailable" });
    expect((await session.handleCommand("agent.close", { agent_id: "codex:child" })).ok).toBe(false);
    expect(session.getSnapshot().panes).toEqual([expect.objectContaining({ agent_id: "codex:child" })]);
  });
  test("external repeated activation stays message-only; text goes to the selected queue with the real sender", async () => {
    await session.handleCommand("agent.select", { agent_id: "ucode:outside" });
    for (let n = 0; n < 2; n++) {
      expect(await session.handleCommand("agent.open", { agent_id: "ucode:outside" })).toMatchObject({ ok: true, mode: "message" });
      expect(session.getSnapshot().mode).toBe("main");
    }
    expect(await session.submit({ text: "review", target_agent: "ucode:outside", has_target: true })).toMatchObject({ ok: true, routed: "agent" });
    const messages = DeliveryQueue.forSubscriber(path.join(root, ".ufoo/bus"), "ucode:outside").readPending();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ publisher: "ucode:self", data: { message: "review" } });
    expect(await session.submit({ text: "local task", input_target: "main" })).toBeNull();
  });
  test("internal activation opens one right-hand pane, excludes self/external peers and rejects stale targets", async () => {
    expect(await session.handleCommand("agent.select", { agent_id: "codex:child" })).toMatchObject({ ok: true });
    expect(session.getSnapshot().mode).toBe("main");
    expect(await session.submit({ text: "", target_agent: "codex:child", has_target: true })).toMatchObject({ ok: true, mode: "side" });
    expect(session.getSnapshot()).toMatchObject({ mode: "side", focus: { target: "agent", agent_id: "codex:child" }, panes: [{ agent_id: "codex:child" }] });
    expect(published).toHaveBeenCalledWith("prompt.set_prefix", { prefix: "› " });
    expect((await session.handleCommand("multi.raw", { agent_id: "ucode:outside", data: "bad" })).ok).toBe(false);
    expect((await session.handleCommand("agent.open", { agent_id: "ucode:self" })).ok).toBe(false);
    expect((await session.submit({ has_target: true, text: "missing" })).ok).toBe(false);
    expect((await session.handleCommand("window.set", { session_id: "old", mode: "main" })).ok).toBe(false);
    expect(await session.handleCommand("multi.focus", { target: "chat" })).toMatchObject({ ok: true });
    expect(session.getSnapshot().mode).toBe("side");
    await session.handleCommand("window.set", { mode: "main" });
    expect(session.getSnapshot().mode).toBe("main");
  });
  test("snapshot identifies pane eligibility from registry metadata instead of agent type", () => {
    const fmt = require("../../../src/ui/format");
    const spy = jest.spyOn(fmt, "loadActiveAgents").mockReturnValue([
      { fullId: "codex:child", nickname: "child" }, { fullId: "ucode:outside", nickname: "outside" },
    ]);
    try {
      expect(buildUcodeAgentsSnapshot(root, "ucode:self").agents).toEqual([
        expect.objectContaining({ id: "codex:child", internal: true }),
        expect.objectContaining({ id: "ucode:outside", internal: false }),
      ]);
    } finally { spy.mockRestore(); }
  });
});

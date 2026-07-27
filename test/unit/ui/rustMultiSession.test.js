"use strict";

const { createRustMultiSession } = require("../../../src/ui/rustMultiSession");

function collect(events, name) {
  return events.filter((e) => e.name === name).map((e) => e.payload);
}

function makeSession({
  agents = ["agent-a", "agent-b"],
  paneOptions = () => ({ mode: "internal", initialLines: ["ready"] }),
  onInternalSubmit = () => {},
} = {}) {
  const events = [];
  const publish = (name, payload) => events.push({ name, payload, lossy: false });
  const publishLossy = (name, payload) => events.push({ name, payload, lossy: true });
  const session = createRustMultiSession({
    projectRoot: "/tmp/does-not-matter",
    getActiveAgents: () => agents.slice(),
    getAgentMeta: () => ({ activity_state: "ready" }),
    getInjectSockPath: () => "",
    resolvePaneOptions: paneOptions,
    onInternalSubmit,
    publish,
    publishLossy,
    getLabel: (id) => `@${id}`,
  });
  return { session, events };
}

describe("createRustMultiSession", () => {
  test("start() publishes multi.set active with panes and rev>=1", () => {
    const { session, events } = makeSession();
    const result = session.start();
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("multi");
    expect(typeof result.session_id).toBe("string");
    const sets = collect(events, "multi.set");
    expect(sets.length).toBeGreaterThan(0);
    const first = sets[sets.length - 1];
    expect(first.active).toBe(true);
    expect(first.kind).toBe("multi");
    expect(first.panes.map((p) => p.agent_id)).toEqual(["agent-a", "agent-b"]);
    expect(first.rev).toBeGreaterThanOrEqual(1);
    session.stop();
  });

  test("start({ kind: side }) locks one agent and focuses it", () => {
    const { session, events } = makeSession({ agents: ["agent-a", "agent-b", "agent-c"] });
    const result = session.start({
      kind: "side",
      agentIds: ["agent-b"],
      focus: { target: "agent", agent_id: "agent-b" },
    });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("side");
    expect(session.isSideKind()).toBe(true);
    expect(session.isMultiKind()).toBe(false);
    expect(String(result.session_id)).toMatch(/^side-/);
    const sets = collect(events, "multi.set");
    const last = sets[sets.length - 1];
    expect(last.kind).toBe("side");
    expect(last.panes.map((p) => p.agent_id)).toEqual(["agent-b"]);
    expect(last.focus).toEqual({ target: "agent", agent_id: "agent-b" });
    // Membership sync must not pull other agents into side.
    session.syncAgents();
    expect(session.getSnapshot().panes.map((p) => p.agent_id)).toEqual(["agent-b"]);
    session.stop();
  });

  test("start({ kind: side }) without agent_id fails", () => {
    const { session } = makeSession();
    const result = session.start({ kind: "side", agentIds: [] });
    expect(result.ok).toBe(false);
    expect(session.isActive()).toBe(false);
  });

  test("stop() publishes multi.set active=false and clears session", () => {
    const { session, events } = makeSession();
    session.start();
    events.length = 0;
    session.stop();
    const sets = collect(events, "multi.set");
    expect(sets).toHaveLength(1);
    expect(sets[0].active).toBe(false);
    expect(session.isActive()).toBe(false);
    expect(session.getSessionId()).toBeNull();
  });

  test("handleViewport() bumps viewport_rev and resizes internal panes", () => {
    const { session } = makeSession();
    session.start();
    const sid = session.getSessionId();
    const res = session.handleViewport({
      session_id: sid,
      viewport_rev: 5,
      panes: [
        { agent_id: "agent-a", cols: 30, rows: 8 },
        { agent_id: "agent-b", cols: 40, rows: 10 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.viewport_rev).toBe(5);
    session.stop();
  });

  test("handleViewport() rejects wrong session_id", () => {
    const { session } = makeSession();
    session.start();
    const res = session.handleViewport({ session_id: "bogus", panes: [] });
    expect(res.ok).toBe(false);
    session.stop();
  });

  test("handleRaw() routes to matching internal pane via onInternalSubmit on Enter", () => {
    const submitted = [];
    const { session } = makeSession({
      onInternalSubmit: (agentId, message) => submitted.push({ agentId, message }),
    });
    session.start();
    const sid = session.getSessionId();
    // Send "hi" then Enter for internal pane handling.
    session.handleRaw({ session_id: sid, agent_id: "agent-a", data: "hi" });
    const enter = session.handleRaw({ session_id: sid, agent_id: "agent-a", data: "\r" });
    expect(enter.ok).toBe(true);
    expect(submitted).toEqual([{ agentId: "agent-a", message: "hi" }]);
    session.stop();
  });

  test("handleRaw() decodes base64 data_encoding", () => {
    const submitted = [];
    const { session } = makeSession({
      onInternalSubmit: (agentId, message) => submitted.push({ agentId, message }),
    });
    session.start();
    const sid = session.getSessionId();
    session.handleRaw({
      session_id: sid,
      agent_id: "agent-a",
      data: Buffer.from("hey", "utf8").toString("base64"),
      data_encoding: "base64",
    });
    session.handleRaw({ session_id: sid, agent_id: "agent-a", data: "\r" });
    expect(submitted).toEqual([{ agentId: "agent-a", message: "hey" }]);
    session.stop();
  });

  test("handleFocus() records agent focus mirror when target is agent", () => {
    const { session } = makeSession();
    session.start();
    const sid = session.getSessionId();
    const res = session.handleFocus({ session_id: sid, target: "agent", agent_id: "agent-b" });
    expect(res.ok).toBe(true);
    expect(res.focus).toEqual({ target: "agent", agent_id: "agent-b" });
    const chat = session.handleFocus({ session_id: sid, target: "chat" });
    expect(chat.focus).toEqual({ target: "chat", agent_id: "" });
    session.stop();
  });

  test("getSnapshot() reports active state with panes", () => {
    const { session } = makeSession();
    session.start();
    const snap = session.getSnapshot();
    expect(snap.active).toBe(true);
    expect(snap.kind).toBe("multi");
    expect(snap.panes.map((p) => p.agent_id)).toEqual(["agent-a", "agent-b"]);
    session.stop();
    expect(session.getSnapshot()).toEqual({ active: false, kind: "" });
  });

  test("listInternalAgentIds and writeToPane mark frames dirty", () => {
    const { session, events } = makeSession();
    session.start();
    expect(session.listInternalAgentIds()).toEqual(["agent-a", "agent-b"]);
    expect(session.writeToPane("agent-a", "hello\r\n")).toBe(true);
    // Allow coalesce timer to fire.
    return new Promise((resolve) => {
      setTimeout(() => {
        const frames = collect(events, "multi.pane.frame");
        expect(frames.length).toBeGreaterThan(0);
        expect(frames.some((f) => f.agent_id === "agent-a")).toBe(true);
        session.stop();
        resolve();
      }, 80);
    });
  });
});

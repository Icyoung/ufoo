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
    getAgentMeta: () => ({ activity_state: "ready", launch_mode: "internal" }),
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
  test("opening and polling an already running legacy child projects its actual activity", () => {
    jest.useFakeTimers();
    const events = [];
    const meta = { launch_mode: "internal", activity_state: "working", activity_detail: "thinking", activity_since: "2026-10-08T12:00:00Z" };
    const session = createRustMultiSession({ getActiveAgents: () => ["child"], getAgentMeta: () => meta,
      publish: (name, payload) => events.push({ name, payload }) });
    try {
      session.setLayout("single", "child"); jest.advanceTimersByTime(100);
      expect(collect(events, "multi.pane.frame").at(-1)).toMatchObject({ busy: true, status: "Thinking…" });
      meta.activity_detail = "tool read";
      session.syncAgents(); jest.advanceTimersByTime(100);
      expect(collect(events, "multi.pane.frame").at(-1).status).toBe("Reading file…");
      meta.activity_state = "idle"; meta.activity_detail = "";
      session.syncAgents(); jest.advanceTimersByTime(100);
      expect(collect(events, "multi.pane.frame").at(-1)).toMatchObject({ busy: false, status: "ready" });
    } finally { session.stop(); jest.useRealTimers(); }
  });
  test("only internal agents get panes, focus and watches, including membership changes", () => {
    const events = [];
    const meta = new Map([["child", { launch_mode: "internal" }], ["wrapper", { launch_mode: "terminal" }]]);
    const session = createRustMultiSession({
      getActiveAgents: () => ["wrapper", "child", "unknown"],
      getAgentMeta: (id) => meta.get(id),
      publish: (name, payload) => events.push({ name, payload }),
    });
    try {
      expect(session.setLayout("all").ok).toBe(true);
      expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["child"]);
      expect(session.focusAgent("wrapper").ok).toBe(false);
      expect(session.setLayout("single", "wrapper").ok).toBe(false);
      expect(session.listInternalAgentIds()).toEqual(["child"]);
      meta.set("child", { launch_mode: "terminal" });
      session.syncAgents();
      expect(session.getSnapshot().panes).toEqual([]);
    } finally { session.stop(); }
  });
  test("all three layouts have direct transitions and toggle preserves the original main/all behavior", () => {
    const { session } = makeSession();
    expect(session.getSnapshot().active).toBe(false);
    expect(session.setLayout("single", "agent-b").ok).toBe(true);
    expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["agent-b"]);
    expect(session.setLayout().ok).toBe(true);
    expect(session.getKind()).toBe("multi");
    expect(session.getSnapshot().focus).toEqual({ target: "agent", agent_id: "agent-b" });
    expect(session.getSnapshot().panes).toHaveLength(2);
    expect(session.setLayout("single", "agent-a").ok).toBe(true);
    expect(session.getKind()).toBe("side");
    expect(session.setLayout("main").ok).toBe(true);
    expect(session.isActive()).toBe(false);
    session.setLayout();
    expect(session.getKind()).toBe("multi");
    session.setLayout();
    expect(session.isActive()).toBe(false);
  });

  test("switching layouts keeps child drafts and their Unicode cursor positions without submitting them", () => {
    jest.useFakeTimers();
    const submitted = jest.fn();
    const { session, events } = makeSession({ onInternalSubmit: submitted });
    try {
      session.setLayout("single", "agent-a");
      session.handleRaw({ agent_id: "agent-a", data: "你好🙂abc" });
      session.handleRaw({ agent_id: "agent-a", data: "\x1b[D" });
      session.setLayout("all");
      jest.advanceTimersByTime(80);
      expect(collect(events, "multi.pane.frame").filter((frame) => frame.agent_id === "agent-a").pop())
        .toMatchObject({ input: "你好🙂abc", cursor: 6 });
      session.setLayout("single", "agent-b");
      session.setLayout("main");
      session.setLayout("single", "agent-a");
      jest.advanceTimersByTime(80);
      expect(collect(events, "multi.pane.frame").pop()).toMatchObject({ input: "你好🙂abc", cursor: 6 });
      expect(submitted).not.toHaveBeenCalled();
      session.stop({ clearDrafts: true });
      session.setLayout("single", "agent-a");
      jest.advanceTimersByTime(80);
      expect(collect(events, "multi.pane.frame").pop()).toMatchObject({ input: "", cursor: 0 });
    } finally {
      session.stop();
      jest.useRealTimers();
    }
  });

  test("a failed layout change leaves the current view intact", () => {
    const { session } = makeSession({ agents: [] });
    session.setLayout("single", "agent-a");
    const before = session.getSnapshot();
    expect(session.setLayout("all").ok).toBe(false);
    expect(session.getSnapshot()).toEqual(before);
    session.stop();
  });

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

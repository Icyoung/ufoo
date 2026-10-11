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
    getAgentMeta: () => ({ activity_state: "ready", agent_type: "codex", launch_mode: "internal" }),
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
  test("absolute drafts survive output refresh and layout changes and submit only to their explicit child", () => {
    const submit = jest.fn();
    const { session, events } = makeSession({ onInternalSubmit: submit });
    try {
      session.setLayout("multi");
      session.focusAgent("agent-a");
      const edit = { agent_id: "agent-b", input: "你好🙂\nreview", cursor: 11, input_revision: 1 };
      expect(session.handleRaw(edit).ok).toBe(true);
      session.acceptEvent("agent-b", { type: "text_delta", delta: "background output" });
      session.publishFrames();
      expect(collect(events, "multi.pane.frame").findLast(frame => frame.agent_id === "agent-b"))
        .toMatchObject({ input: edit.input, cursor: 11, input_revision: 1 });
      session.setLayout("main"); session.setLayout("side", "agent-b");
      session.publishFrames();
      expect(collect(events, "multi.pane.frame").at(-1)).toMatchObject({ input: edit.input, input_revision: 1 });
      expect(session.handleRaw({ ...edit, input: "stale", submit: true })).toMatchObject({ ok: true, stale: true });
      expect(submit).not.toHaveBeenCalled();
      expect(session.handleRaw({ ...edit, input_revision: 2, submit: true }).ok).toBe(true);
      expect(submit).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledWith("agent-b", edit.input);
      session.publishFrames();
      expect(collect(events, "multi.pane.frame").at(-1)).toMatchObject({ input: "", input_revision: 2 });
      expect(session.handleRaw({ ...edit, agent_id: "missing", input_revision: 3, submit: true }).ok).toBe(false);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally { session.stop(); }
  });

  test("resync replays every idle pane's content even without new provider events", () => {
    const agents = ["architect", "builder", "reviewer"];
    const { session, events } = makeSession({ agents });
    try {
      session.setLayout("multi");
      for (const agent of agents) session.acceptEvent(agent, { type: "text_delta", delta: `${agent} history` });
      events.length = 0;
      session.publishFrames();
      const frames = collect(events, "multi.pane.frame");
      expect(frames.map(frame => frame.agent_id)).toEqual(agents);
      for (const frame of frames) expect(frame.entries.some(entry => entry.text === `${frame.agent_id} history`)).toBe(true);
    } finally { session.stop(); }
  });
  test("recovered history retains semantic messages across window changes", () => {
    jest.useFakeTimers();
    const initialEntries = [
      { id: "history-1", kind: "user", text: "review the scene\ncheck the camera" },
      { id: "history-2", kind: "assistant", text: "Review complete\n\nThe camera is clear." },
    ];
    const { session, events } = makeSession({ agents: ["child"], paneOptions: () => ({ mode: "internal", initialEntries }) });
    try {
      session.setLayout("side", "child");
      jest.advanceTimersByTime(100);
      const history = collect(events, "multi.pane.frame").at(-1).entries;
      expect(history).toEqual(initialEntries.map((entry) => ({ detail: "", speaker: "", expanded: false, ...entry })));
      session.acceptEvent("child", { type: "task_started", task_id: "next", message: "check lighting" });
      session.acceptEvent("child", { type: "text_delta", delta: "Lighting is clear." });
      session.setLayout("main");
      session.setLayout("multi");
      jest.advanceTimersByTime(100);
      const entries = collect(events, "multi.pane.frame").at(-1).entries;
      expect(entries.slice(0, 2)).toEqual(history);
      expect(entries.slice(2).map(({ kind, text }) => ({ kind, text }))).toEqual([
        { kind: "user", text: "check lighting" }, { kind: "assistant", text: "Lighting is clear." },
      ]);
    } finally { session.stop(); jest.useRealTimers(); }
  });

  test("opening and polling an already running legacy child projects its actual activity", () => {
    jest.useFakeTimers();
    const events = [];
    const meta = { agent_type: "codex", launch_mode: "internal", activity_state: "working", activity_detail: "thinking", activity_since: "2026-10-08T12:00:00Z" };
    const session = createRustMultiSession({ getActiveAgents: () => ["child"], getAgentMeta: () => meta,
      publish: (name, payload) => events.push({ name, payload }) });
    try {
      session.setLayout("side", "child"); jest.advanceTimersByTime(100);
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
    const meta = new Map([["child", { agent_type: "codex", launch_mode: "internal" }], ["wrapper", { launch_mode: "terminal" }]]);
    const session = createRustMultiSession({
      getActiveAgents: () => ["wrapper", "child", "unknown"],
      getAgentMeta: (id) => meta.get(id),
      publish: (name, payload) => events.push({ name, payload }),
    });
    try {
      expect(session.setLayout("multi").ok).toBe(true);
      expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["child"]);
      expect(session.focusAgent("wrapper").ok).toBe(false);
      expect(session.setLayout("side", "wrapper").ok).toBe(false);
      expect(session.listInternalAgentIds()).toEqual(["child"]);
      meta.set("child", { launch_mode: "terminal" });
      session.syncAgents();
      expect(session.getSnapshot().panes).toEqual([]);
    } finally { session.stop(); }
  });
  test("cycling visits main, side and multi while preserving focus and the recent child", () => {
    const { session } = makeSession();
    expect(session.getMode()).toBe("main");
    session.setLayout();
    expect(session.getMode()).toBe("side");
    expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["agent-a"]);
    expect(session.getSnapshot().focus.target).toBe("chat");
    session.focusAgent("agent-a");
    session.setLayout();
    expect(session.getMode()).toBe("multi");
    session.focusAgent("agent-b");
    expect(session.getSnapshot().focus).toEqual({ target: "agent", agent_id: "agent-b" });
    expect(session.getSnapshot().panes).toHaveLength(2);
    session.setLayout();
    expect(session.getMode()).toBe("main");
    session.setLayout();
    expect(session.getMode()).toBe("side");
    expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["agent-b"]);
    expect(session.getSnapshot().focus.target).toBe("chat");
    session.stop();
  });

  test("switching layouts keeps child drafts and their Unicode cursor positions without submitting them", () => {
    jest.useFakeTimers();
    const submitted = jest.fn();
    const { session, events } = makeSession({ onInternalSubmit: submitted });
    try {
      session.setLayout("side", "agent-a");
      session.handleRaw({ agent_id: "agent-a", data: "你好🙂abc" });
      session.handleRaw({ agent_id: "agent-a", data: "\x1b[D" });
      session.setLayout("multi");
      jest.advanceTimersByTime(80);
      expect(collect(events, "multi.pane.frame").filter((frame) => frame.agent_id === "agent-a").pop())
        .toMatchObject({ input: "你好🙂abc", cursor: 6 });
      session.setLayout("side", "agent-b");
      session.setLayout("main");
      session.setLayout("side", "agent-a");
      jest.advanceTimersByTime(80);
      expect(collect(events, "multi.pane.frame").pop()).toMatchObject({ input: "你好🙂abc", cursor: 6 });
      expect(submitted).not.toHaveBeenCalled();
      session.stop({ clearDrafts: true });
      session.setLayout("side", "agent-a");
      jest.advanceTimersByTime(80);
      expect(collect(events, "multi.pane.frame").pop()).toMatchObject({ input: "", cursor: 0 });
    } finally {
      session.stop();
      jest.useRealTimers();
    }
  });

  test("a failed layout change leaves the current view intact", () => {
    const { session } = makeSession();
    session.setLayout("side", "agent-a");
    const before = session.getSnapshot();
    expect(session.setLayout("invalid").ok).toBe(false);
    expect(session.setLayout("side", "missing").ok).toBe(false);
    expect(session.getSnapshot()).toEqual(before);
    session.stop();
  });

  test("start() publishes window.set active with panes and rev>=1", () => {
    const { session, events } = makeSession();
    const result = session.start();
    expect(result.ok).toBe(true);
    expect(result.mode).toBe("multi");
    expect(typeof result.session_id).toBe("string");
    const sets = collect(events, "window.set");
    expect(sets.length).toBeGreaterThan(0);
    const first = sets[sets.length - 1];
    expect(first.active).toBe(true);
    expect(first.mode).toBe("multi");
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
    expect(result.mode).toBe("side");
    expect(session.isSideKind()).toBe(true);
    expect(session.isMultiKind()).toBe(false);
    expect(String(result.session_id)).toMatch(/^side-/);
    const sets = collect(events, "window.set");
    const last = sets[sets.length - 1];
    expect(last.mode).toBe("side");
    expect(last.panes.map((p) => p.agent_id)).toEqual(["agent-b"]);
    expect(last.focus).toEqual({ target: "agent", agent_id: "agent-b" });
    // Membership sync must not pull other agents into side.
    session.syncAgents();
    expect(session.getSnapshot().panes.map((p) => p.agent_id)).toEqual(["agent-b"]);
    session.stop();
  });

  test("one-child layout without an explicit child selects the first internal agent", () => {
    const { session } = makeSession();
    const result = session.start({ kind: "side", agentIds: [] });
    expect(result.ok).toBe(true);
    expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["agent-a"]);
    session.stop();
  });

  test("empty layouts keep their mode and populate when internal agents arrive", () => {
    const agents = [];
    const { session } = makeSession({ agents });
    try {
      for (const mode of ["side", "multi", "main", "side"]) {
        session.setLayout();
        expect(session.getMode()).toBe(mode);
        expect(session.getSnapshot().panes || []).toEqual([]);
      }
      agents.push("agent-a", "agent-b");
      session.syncAgents();
      expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["agent-a"]);
      session.setLayout();
      expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(agents);
      agents.splice(0);
      session.syncAgents();
      expect(session.getSnapshot()).toMatchObject({ active: true, mode: "multi", panes: [] });
    } finally { session.stop(); }
  });

  test("a removed recent child falls back to the first live child and resets focus", () => {
    const agents = ["agent-a", "agent-b", "agent-c"];
    const { session } = makeSession({ agents });
    try {
      session.setLayout("multi");
      session.focusAgent("agent-c");
      session.setLayout("main");
      session.setLayout("side");
      expect(session.getSnapshot().panes[0].agent_id).toBe("agent-c");
      session.focusAgent("agent-c");
      agents.pop();
      session.syncAgents();
      expect(session.getSnapshot().panes.map((pane) => pane.agent_id)).toEqual(["agent-a"]);
      expect(session.getSnapshot().focus.target).toBe("chat");
      agents.splice(0);
      session.syncAgents();
      expect(session.getSnapshot()).toMatchObject({ active: true, mode: "side", panes: [] });
    } finally { session.stop(); }
  });

  test("stop() publishes window.set active=false and clears session", () => {
    const { session, events } = makeSession();
    session.start();
    events.length = 0;
    session.stop();
    const sets = collect(events, "window.set");
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
    expect(snap.mode).toBe("multi");
    expect(snap.panes.map((p) => p.agent_id)).toEqual(["agent-a", "agent-b"]);
    session.stop();
    expect(session.getSnapshot()).toEqual({ active: false, mode: "main" });
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

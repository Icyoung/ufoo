"use strict";

const { reducer, createInitialState, DASHBOARD_VIEWS } = require("../../../src/ui/ink/chatReducer");

describe("chatReducer", () => {
  test("createInitialState seeds the log with the banner", () => {
    const state = createInitialState({ banner: ["a", "b"] });
    expect(state.logLines.length).toBe(3); // banner + trailing blank
    expect(state.logLines[0].text).toBe("a");
  });

  test("log entries keep structured display fields in reducer state", () => {
    let state = createInitialState({ banner: [] });
    state = reducer(state, {
      type: "log/appendMany",
      lines: [
        {
          type: "bus",
          text: "claude-code:221e94 · Handoff from Codex",
          meta: { publisher: "claude-code:221e94" },
        },
        "                    Current state:",
      ],
    });

    const entries = state.logLines.filter((entry) => entry.text);

    expect(entries[0]).toMatchObject({
      text: "claude-code:221e94 · Handoff from Codex",
      kind: "agent",
      speaker: "claude-code:221e94",
      bodyText: "Handoff from Codex",
      sourceType: "bus",
      meta: { publisher: "claude-code:221e94" },
    });
    expect(entries[1]).toMatchObject({
      text: "                    Current state:",
      kind: "plain",
      speaker: "",
      bodyText: "Current state:",
    });
  });

  test("default provider options include agy alongside codex and claude", () => {
    const state = createInitialState();
    const values = state.providerOptions.map((opt) => opt.value);
    expect(values).toEqual(expect.arrayContaining(["codex-cli", "claude-cli", "agy-cli"]));
    const agyOption = state.providerOptions.find((opt) => opt.value === "agy-cli");
    expect(agyOption.label).toBe("agy");
  });

  test("log/append freezes any active merge before adding text", () => {
    let state = createInitialState();
    state = reducer(state, { type: "merge/append", entry: { tool: "read", detail: "a.md" } });
    state = reducer(state, { type: "merge/append", entry: { tool: "bash", detail: "ls" } });
    expect(state.activeMerge.entries.length).toBe(2);
    state = reducer(state, { type: "log/append", text: "user said hi" });
    expect(state.activeMerge).toBeNull();
    // The frozen merge row should now sit above the new text.
    const last = state.logLines[state.logLines.length - 1].text;
    expect(last).toBe("user said hi");
  });

  test("log cap is 1000 lines", () => {
    let state = createInitialState({ banner: [] });
    for (let i = 0; i < 1500; i += 1) {
      state = reducer(state, { type: "log/append", text: `line ${i}` });
    }
    expect(state.logLines.length).toBe(1000);
    expect(state.logLines[0].text).toBe("line 500");
  });

  test("focus/toggle bounces between input and dashboard", () => {
    let state = createInitialState();
    expect(state.focusMode).toBe("input");
    state = reducer(state, { type: "focus/toggle" });
    expect(state.focusMode).toBe("dashboard");
    state = reducer(state, { type: "focus/toggle" });
    expect(state.focusMode).toBe("input");
  });

  test("view/cycle clamps at dashboard list edges", () => {
    let state = createInitialState({ globalMode: false });
    expect(state.dashboardView).toBe("agents");
    state = reducer(state, { type: "view/cycle", direction: "left" });
    expect(state.dashboardView).toBe("projects");
    for (let i = 0; i < DASHBOARD_VIEWS.length + 2; i += 1) {
      state = reducer(state, { type: "view/cycle", direction: "right" });
    }
    expect(state.dashboardView).toBe("cron");
    state = reducer(state, { type: "view/cycle", direction: "right" });
    expect(state.dashboardView).toBe("cron");
  });

  test("leaving agents dashboard view clears temporary target mode", () => {
    let state = createInitialState({ globalMode: false });
    state = reducer(state, { type: "focus/set", mode: "dashboard" });
    state = reducer(state, { type: "agents/set", list: [
      { type: "codex", id: "1", fullId: "codex:1" },
    ]});
    state = reducer(state, { type: "agents/select", index: 0 });
    expect(state.agentSelectionMode).toBe(true);

    state = reducer(state, { type: "view/set", view: "mode" });

    expect(state.dashboardView).toBe("mode");
    expect(state.selectedAgentIndex).toBe(0);
    expect(state.agentSelectionMode).toBe(false);
  });

  test("returning to agents dashboard view restores selected-agent mode", () => {
    let state = createInitialState({ globalMode: false });
    state = reducer(state, { type: "focus/set", mode: "dashboard" });
    state = reducer(state, { type: "agents/set", list: [
      { type: "codex", id: "1", fullId: "codex:1" },
    ]});
    state = reducer(state, { type: "agents/select", index: 0 });
    state = reducer(state, { type: "view/set", view: "mode" });
    state = reducer(state, { type: "view/set", view: "agents" });

    expect(state.dashboardView).toBe("agents");
    expect(state.selectedAgentIndex).toBe(0);
    expect(state.agentSelectionMode).toBe(true);
  });

  test("agents/set clears selection when the list shrinks past the cursor", () => {
    let state = createInitialState();
    state = reducer(state, { type: "agents/set", list: [
      { type: "claude-code", id: "abc123", fullId: "claude-code:abc123" },
      { type: "claude-code", id: "def456", fullId: "claude-code:def456" },
    ]});
    state = reducer(state, { type: "agents/select", index: 1 });
    expect(state.selectedAgentIndex).toBe(1);
    state = reducer(state, { type: "agents/set", list: [] });
    expect(state.selectedAgentIndex).toBe(-1);
    expect(state.agentSelectionMode).toBe(false);
  });

  test("agents/set returns the same state for identical dashboard payloads", () => {
    let state = createInitialState();
    const list = [
      { type: "codex", id: "1", fullId: "codex:1", nickname: "worker", activity_state: "idle" },
    ];
    state = reducer(state, { type: "agents/set", list });
    const same = reducer(state, { type: "agents/set", list: [{ ...list[0] }] });
    expect(same).toBe(state);
  });

  test("agents/patchMeta overlays transient dashboard state", () => {
    let state = createInitialState();
    state = reducer(state, { type: "agents/set", list: [
      { type: "codex", id: "1", fullId: "codex:1", nickname: "worker" },
    ]});
    state = reducer(state, {
      type: "agents/patchMeta",
      agentId: "codex:1",
      patch: { activity_state: "working", activity_detail: "running" },
    });

    expect(state.activeAgentMeta.get("codex:1")).toMatchObject({
      nickname: "worker",
      activity_state: "working",
      activity_detail: "running",
    });
  });

  test("projects/set preserves selection by project root across dynamic reordering", () => {
    let state = createInitialState({ globalMode: true });
    state = reducer(state, { type: "projects/set", list: [
      { label: "alpha", root: "/tmp/alpha" },
      { label: "beta", root: "/tmp/beta" },
      { label: "gamma", root: "/tmp/gamma" },
    ]});
    state = reducer(state, { type: "projects/select", index: 1 });
    expect(state.selectedProjectRoot).toBe("/tmp/beta");

    state = reducer(state, { type: "projects/set", list: [
      { label: "gamma", root: "/tmp/gamma" },
      { label: "alpha", root: "/tmp/alpha" },
      { label: "beta", root: "/tmp/beta" },
    ]});
    expect(state.selectedProjectRoot).toBe("/tmp/beta");
    expect(state.selectedProjectIndex).toBe(2);
  });

  test("projects/set clears selection when selected project disappears", () => {
    let state = createInitialState({ globalMode: true });
    state = reducer(state, { type: "projects/set", list: [
      { label: "alpha", root: "/tmp/alpha" },
      { label: "beta", root: "/tmp/beta" },
    ]});
    state = reducer(state, { type: "projects/select", index: 1 });
    state = reducer(state, { type: "projects/set", list: [
      { label: "alpha", root: "/tmp/alpha" },
    ]});
    expect(state.selectedProjectRoot).toBe("");
    expect(state.selectedProjectIndex).toBe(-1);
  });

  test("projects/set returns the same state for identical project payloads", () => {
    let state = createInitialState({ globalMode: true });
    const list = [
      { label: "alpha", root: "/tmp/alpha", status: "active" },
      { label: "beta", root: "/tmp/beta", status: "active" },
    ];
    state = reducer(state, { type: "projects/set", list, activeProjectRoot: "/tmp/alpha" });
    const same = reducer(state, {
      type: "projects/set",
      list: list.map((row) => ({ ...row })),
      activeProjectRoot: "/tmp/alpha",
    });
    expect(same).toBe(state);
  });

  test("projects/clearSelection clears preview project context", () => {
    let state = createInitialState({ globalMode: true });
    state = reducer(state, { type: "projects/set", list: [
      { label: "alpha", root: "/tmp/alpha" },
    ]});
    state = reducer(state, { type: "projects/select", index: 0 });
    state = reducer(state, { type: "projects/clearSelection" });
    expect(state.selectedProjectRoot).toBe("");
    expect(state.selectedProjectIndex).toBe(-1);
  });

  test("empty global projects rail absorbs first Down and allows second Down to enter agents", () => {
    let state = createInitialState({ globalMode: true });
    state = reducer(state, { type: "focus/set", mode: "dashboard" });
    expect(state.dashboardView).toBe("projects");
    expect(state.projects).toHaveLength(0);

    state = reducer(state, { type: "projects/armEmptyDown" });
    expect(state.dashboardView).toBe("projects");
    expect(state.emptyProjectsDownArmed).toBe(true);

    state = reducer(state, { type: "view/set", view: "agents" });
    expect(state.dashboardView).toBe("agents");
    expect(state.emptyProjectsDownArmed).toBe(false);
  });

  test("empty projects Down latch resets when projects become available", () => {
    let state = createInitialState({ globalMode: true });
    state = reducer(state, { type: "projects/armEmptyDown" });
    state = reducer(state, { type: "projects/set", list: [
      { label: "alpha", root: "/tmp/alpha" },
    ]});

    expect(state.emptyProjectsDownArmed).toBe(false);
  });

  test("history/push trims to 200 and resets the cursor", () => {
    let state = createInitialState();
    for (let i = 0; i < 250; i += 1) {
      state = reducer(state, { type: "history/push", value: `cmd ${i}` });
    }
    expect(state.inputHistory.length).toBe(200);
    expect(state.inputHistory[0]).toBe("cmd 50");
    expect(state.historyIndex).toBe(200);
  });

  test("merge/expand only fires once per group", () => {
    let state = createInitialState();
    state = reducer(state, { type: "merge/append", entry: { tool: "read", detail: "a.md" } });
    state = reducer(state, { type: "merge/append", entry: { tool: "bash", detail: "ls" } });
    state = reducer(state, { type: "merge/expand" });
    const firstExpand = state.logLines.length;
    state = reducer(state, { type: "merge/expand" });
    expect(state.logLines.length).toBe(firstExpand);
  });

  test("status/idle resets the status payload", () => {
    let state = createInitialState();
    state = reducer(state, { type: "status/set", payload: { message: "Thinking...", showTimer: true, startedAt: 1 } });
    expect(state.status.message).toBe("Thinking...");
    state = reducer(state, { type: "status/idle" });
    expect(state.status.message).toBe("");
    expect(state.status.showTimer).toBe(false);
  });

  test("status/set ignores repeated non-timer status updates", () => {
    let state = createInitialState();
    state = reducer(state, {
      type: "status/set",
      payload: { message: "Ready", type: "done", showTimer: false, startedAt: 1 },
    });
    const same = reducer(state, {
      type: "status/set",
      payload: { message: "Ready", type: "done", showTimer: false, startedAt: 2 },
    });
    expect(same).toBe(state);
  });

  test("status/set keeps non-timer updates when another status field changes", () => {
    let state = createInitialState();
    state = reducer(state, {
      type: "status/set",
      payload: { message: "Ready", type: "done", showTimer: false, detail: "a", startedAt: 1 },
    });
    const changed = reducer(state, {
      type: "status/set",
      payload: { message: "Ready", type: "done", showTimer: false, detail: "b", startedAt: 2 },
    });
    expect(changed).not.toBe(state);
    expect(changed.status.detail).toBe("b");
  });

  test("loop/set stores and clears controller loop summary", () => {
    let state = createInitialState();
    state = reducer(state, { type: "loop/set", summary: { rounds: 1 } });
    expect(state.loopSummary).toEqual({ rounds: 1 });
    state = reducer(state, { type: "loop/set", summary: null });
    expect(state.loopSummary).toBeNull();
  });

  test("cron/set and loop/set ignore identical payloads", () => {
    let state = createInitialState();
    state = reducer(state, { type: "cron/set", list: [{ id: "a", intervalMs: 1000 }] });
    const sameCron = reducer(state, { type: "cron/set", list: [{ intervalMs: 1000, id: "a" }] });
    expect(sameCron).toBe(state);

    state = reducer(state, { type: "loop/set", summary: { rounds: 1, tool_calls: 2 } });
    const sameLoop = reducer(state, { type: "loop/set", summary: { tool_calls: 2, rounds: 1 } });
    expect(sameLoop).toBe(state);
  });

  test("initial settings seed dashboard indices and settings", () => {
    const state = createInitialState({
      settings: { launchMode: "tmux", agentProvider: "claude-cli", autoResume: true },
    });
    expect(state.selectedModeIndex).toBe(state.modeOptions.indexOf("tmux"));
    expect(state.selectedProviderIndex).toBe(1);
    expect(state.settings).toEqual({
      launchMode: "tmux",
      agentProvider: "claude-cli",
      autoResume: true,
    });
  });

  test("settings apply actions copy selected dashboard values", () => {
    let state = createInitialState();
    state = reducer(state, { type: "modeIndex/set", index: 3 });
    state = reducer(state, { type: "settings/applyMode" });
    expect(state.settings.launchMode).toBe("tmux");

    state = reducer(state, { type: "providerIndex/set", index: 1 });
    state = reducer(state, { type: "settings/applyProvider" });
    expect(state.settings.agentProvider).toBe("claude-cli");
  });

  test("stream/begin -> delta -> end folds into the log on completion", () => {
    let state = createInitialState({ banner: [] });
    state = reducer(state, { type: "stream/begin", publisher: "claude" });
    expect(state.activeStream).toBeTruthy();
    state = reducer(state, { type: "stream/delta", delta: "Hello, " });
    state = reducer(state, { type: "stream/delta", delta: "world!" });
    expect(state.activeStream.text).toBe("Hello, world!");
    state = reducer(state, { type: "stream/end" });
    expect(state.activeStream).toBeNull();
    const last = state.logLines[state.logLines.length - 1].text;
    expect(last).toBe("claude: Hello, world!");
  });

  test("stream/delta without prior begin still seeds the active stream", () => {
    let state = createInitialState({ banner: [] });
    state = reducer(state, { type: "stream/delta", publisher: "x", delta: "hi" });
    expect(state.activeStream.text).toBe("hi");
  });
});

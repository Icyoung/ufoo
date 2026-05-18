"use strict";

const { reducer, createInitialState, DASHBOARD_VIEWS } = require("../../../src/ui/components/chatReducer");

describe("chatReducer", () => {
  test("createInitialState seeds the log with the banner", () => {
    const state = createInitialState({ banner: ["a", "b"] });
    expect(state.logLines.length).toBe(3); // banner + trailing blank
    expect(state.logLines[0].text).toBe("a");
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

  test("view/cycle wraps around the dashboard list", () => {
    let state = createInitialState({ globalMode: false });
    expect(state.dashboardView).toBe("agents");
    for (let i = 0; i < DASHBOARD_VIEWS.length; i += 1) {
      state = reducer(state, { type: "view/cycle", direction: "right" });
    }
    expect(state.dashboardView).toBe("agents");
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

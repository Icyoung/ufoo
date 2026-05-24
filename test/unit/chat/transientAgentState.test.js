const {
  DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS,
  setTransientAgentState,
  getTransientAgentStateEntry,
  getTransientAgentState,
  pruneTransientAgentStates,
} = require("../../../src/app/chat/transientAgentState");

describe("chat transientAgentState", () => {
  test("returns stored transient state before ttl expiry", () => {
    const store = new Map();
    setTransientAgentState(store, "codex:1", "working", 1000);

    expect(getTransientAgentState(store, "codex:1", { now: 1000 + DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS - 1 }))
      .toBe("working");
  });

  test("returns transient state entry with detail", () => {
    const store = new Map();
    setTransientAgentState(store, "codex:1", "working", { now: 1000, detail: "tool dispatch_message" });

    expect(getTransientAgentStateEntry(store, "codex:1", { now: 1001 })).toEqual({
      state: "working",
      updatedAt: 1000,
      detail: "tool dispatch_message",
    });
  });

  test("expires stale transient state after ttl", () => {
    const store = new Map();
    setTransientAgentState(store, "codex:1", "working", 1000);

    expect(getTransientAgentState(store, "codex:1", { now: 1000 + DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS + 1 }))
      .toBe("");
    expect(store.has("codex:1")).toBe(false);
  });

  test("prune removes inactive agents and expired entries", () => {
    const store = new Map();
    setTransientAgentState(store, "codex:1", "working", 1000);
    setTransientAgentState(store, "codex:2", "working", 1000);

    pruneTransientAgentStates(store, ["codex:1"], {
      now: 1000 + DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS + 1,
      ttlMs: DEFAULT_TRANSIENT_AGENT_STATE_TTL_MS,
    });

    expect(store.has("codex:1")).toBe(false);
    expect(store.has("codex:2")).toBe(false);
  });
});

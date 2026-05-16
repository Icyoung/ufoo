"use strict";

const { createActivityTracker } = require("../../../src/agent/activityTracker");

function createFakePublisher() {
  const calls = [];
  return {
    publish(state, extra = {}, options = {}) {
      calls.push({
        state,
        detail: typeof extra.detail === "string" ? extra.detail : "",
        previous: extra.previous || "",
        force: typeof options.force === "boolean" ? options.force : null,
      });
      return true;
    },
    calls,
  };
}

describe("activityTracker", () => {
  test("notifyStarting and notifyReady emit canonical states", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.notifyStarting("runner");
    tracker.notifyReady("codex-cli");

    expect(pub.calls.map((c) => c.state)).toEqual(["starting", "ready"]);
    expect(pub.calls[0].detail).toBe("runner");
    expect(pub.calls[1].detail).toBe("codex-cli");
  });

  test("turn_started flips to working/thinking", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "turn_started", turnId: "t1" });

    expect(pub.calls).toEqual([
      expect.objectContaining({ state: "working", detail: "thinking" }),
    ]);
  });

  test("text_delta without prior turn_started still flips to working", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "text_delta", delta: "hi" });

    expect(pub.calls[0]).toEqual(
      expect.objectContaining({ state: "working", detail: "thinking" })
    );
  });

  test("tool_call updates detail without leaving working", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "turn_started", turnId: "t1" });
    tracker.onProviderEvent({ type: "tool_call", name: "bash" });

    expect(pub.calls.map((c) => `${c.state}/${c.detail}`)).toEqual([
      "working/thinking",
      "working/tool bash",
    ]);
  });

  test("tool_result keeps current detail (no flap to thinking)", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "turn_started", turnId: "t1" });
    tracker.onProviderEvent({ type: "tool_call", name: "grep" });
    tracker.onProviderEvent({ type: "tool_result", toolCallId: "x" });

    expect(pub.calls).toHaveLength(2);
    expect(pub.calls[1].detail).toBe("tool grep");
  });

  test("multiple tool_calls in one turn each update detail", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "turn_started", turnId: "t1" });
    tracker.onProviderEvent({ type: "tool_call", name: "bash" });
    tracker.onProviderEvent({ type: "tool_result", toolCallId: "1" });
    tracker.onProviderEvent({ type: "tool_call", name: "grep" });

    expect(pub.calls.map((c) => c.detail)).toEqual([
      "thinking",
      "tool bash",
      "tool grep",
    ]);
  });

  test("turn_completed returns to idle with force=true", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "turn_started", turnId: "t1" });
    tracker.onProviderEvent({ type: "turn_completed", turnId: "t1" });

    expect(pub.calls[1]).toEqual(
      expect.objectContaining({ state: "idle", detail: "", force: true })
    );
  });

  test("turn_failed returns to idle by default", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "turn_started", turnId: "t1" });
    tracker.onProviderEvent({ type: "turn_failed", error: "boom" });

    expect(pub.calls[1].state).toBe("idle");
    expect(pub.calls[1].force).toBe(true);
  });

  test("requestUserInput / clearUserInput round-trip", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.requestUserInput("approval");
    tracker.clearUserInput();

    expect(pub.calls[0]).toEqual(
      expect.objectContaining({ state: "waiting_input", detail: "approval" })
    );
    expect(pub.calls[1]).toEqual(
      expect.objectContaining({ state: "idle", force: true })
    );
  });

  test("clearUserInput is a no-op when not in waiting_input", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.notifyReady();
    tracker.clearUserInput();

    expect(pub.calls).toHaveLength(1);
    expect(pub.calls[0].state).toBe("ready");
  });

  test("markBlocked emits blocked", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.markBlocked("network down");

    expect(pub.calls[0]).toEqual(
      expect.objectContaining({ state: "blocked", detail: "network down" })
    );
  });

  test("getState reflects last successful publish", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "turn_started", turnId: "t1" });
    tracker.onProviderEvent({ type: "tool_call", name: "bash" });

    expect(tracker.getState()).toEqual({
      state: "working",
      detail: "tool bash",
      turnId: "t1",
    });
  });

  test("ignores unknown event types", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({ type: "thread_started" });
    tracker.onProviderEvent({ type: "garbage" });
    tracker.onProviderEvent({});

    expect(pub.calls).toEqual([]);
  });

  test("compactToolName truncates very long tool names", () => {
    const pub = createFakePublisher();
    const tracker = createActivityTracker({ publisher: pub });

    tracker.onProviderEvent({
      type: "tool_call",
      name: "tool_with_a_really_long_name_that_should_be_compacted_eventually",
    });

    const detail = pub.calls[0].detail;
    expect(detail.startsWith("tool ")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual("tool ".length + 32);
    expect(detail.endsWith("...")).toBe(true);
  });

  test("requires a publisher", () => {
    expect(() => createActivityTracker({})).toThrow(/publisher/);
  });
});

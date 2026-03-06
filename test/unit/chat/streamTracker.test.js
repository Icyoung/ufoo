const { createStreamTracker } = require("../../../src/chat/streamTracker");

function createMockLogBox() {
  const lines = [];
  return {
    lines,
    pushLine(line) {
      lines.push(line);
    },
    getLines() {
      return lines;
    },
    setLine(index, line) {
      lines[index] = line;
    },
  };
}

describe("chat streamTracker", () => {
  test("tracks stream lifecycle and writes history on finalize", () => {
    const logBox = createMockLogBox();
    const history = [];
    let spacerCount = 0;
    let started = 0;

    const tracker = createStreamTracker({
      logBox,
      writeSpacer: () => { spacerCount += 1; },
      appendHistory: (entry) => history.push(entry),
      escapeBlessed: (s) => String(s),
      onStreamStart: () => { started += 1; },
      now: () => "2026-02-11T00:00:00.000Z",
    });

    const state = tracker.beginStream("codex:1", "P: ", "   ", { t: 1 });
    expect(spacerCount).toBe(1);
    expect(started).toBe(1);
    expect(tracker.hasStream("codex:1")).toBe(true);
    expect(logBox.lines[0]).toBe("P: ");

    tracker.appendStreamDelta(state, "hello\nwor");
    expect(logBox.lines[0]).toBe("P: hello");
    expect(logBox.lines[1]).toBe("   wor");

    tracker.appendStreamDelta(state, "ld");
    expect(logBox.lines[1]).toBe("   world");

    tracker.finalizeStream("codex:1", { event: "message" }, "done");
    expect(tracker.hasStream("codex:1")).toBe(false);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      ts: "2026-02-11T00:00:00.000Z",
      type: "bus",
      meta: { event: "message", stream_done: true, stream_reason: "done" },
    });
    expect(history[0].text).toContain("P: hello");
    expect(history[0].text).toContain("   world");
  });

  test("pending delivery counters are shared across id and label aliases", () => {
    const tracker = createStreamTracker({
      logBox: createMockLogBox(),
      writeSpacer: () => {},
      appendHistory: () => {},
      escapeBlessed: (s) => String(s),
    });

    tracker.markPendingDelivery("codex:1", "agent-1");
    tracker.markPendingDelivery("codex:1", "agent-1");

    expect(tracker.getPendingState("codex:1", null)).not.toBeNull();
    expect(tracker.getPendingState(null, "agent-1")).not.toBeNull();

    expect(tracker.consumePendingDelivery("codex:1", "agent-1")).toBe(true);
    expect(tracker.getPendingState("codex:1", null)).not.toBeNull();

    expect(tracker.consumePendingDelivery(null, "agent-1")).toBe(true);
    expect(tracker.getPendingState("codex:1", null)).toBeNull();
    expect(tracker.getPendingState(null, "agent-1")).toBeNull();
  });

  test("discardAll clears in-flight streams without writing history", () => {
    const history = [];
    const tracker = createStreamTracker({
      logBox: createMockLogBox(),
      writeSpacer: () => {},
      appendHistory: (entry) => history.push(entry),
      escapeBlessed: (s) => String(s),
    });

    const state = tracker.beginStream("codex:1", "P: ", "   ", {});
    tracker.appendStreamDelta(state, "partial");
    expect(tracker.hasStream("codex:1")).toBe(true);
    tracker.markPendingDelivery("codex:1", "agent-1");
    expect(tracker.getPendingState("codex:1", "agent-1")).not.toBeNull();

    tracker.discardAll();
    expect(tracker.hasStream("codex:1")).toBe(false);
    expect(tracker.getPendingState("codex:1", "agent-1")).toBeNull();

    tracker.finalizeStream("codex:1", {}, "done");
    expect(history).toEqual([]);
  });
});

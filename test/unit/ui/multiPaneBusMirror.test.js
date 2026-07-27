"use strict";

const {
  parseInternalBusPayload,
  internalStatusLabel,
  writeMultiPaneBusEvent,
} = require("../../../src/ui/multiPaneBusMirror");

describe("multiPaneBusMirror", () => {
  test("parseInternalBusPayload extracts reply and stream", () => {
    expect(parseInternalBusPayload("hello").displayMessage).toBe("hello");
    expect(parseInternalBusPayload(JSON.stringify({ reply: "hi" })).displayMessage).toBe("hi");
    const stream = parseInternalBusPayload(JSON.stringify({ stream: true, delta: "x", done: false }));
    expect(stream.streamPayload.delta).toBe("x");
  });

  test("internalStatusLabel normalizes activity states", () => {
    expect(internalStatusLabel("waiting_input")).toBe("waiting");
    expect(internalStatusLabel("working")).toBe("working");
    expect(internalStatusLabel("ready")).toBe("ready");
  });

  test("writeMultiPaneBusEvent mirrors agent messages into matching pane", () => {
    const writes = [];
    const handled = writeMultiPaneBusEvent(
      {
        publisher: "ufoo:alice",
        target: "chat",
        message: "hello from alice",
      },
      {
        agentIds: ["ufoo:alice", "ufoo:bob"],
        getMeta: (id) => (id === "ufoo:alice" ? { nickname: "alice" } : {}),
        writeToPane: (id, text) => { writes.push({ id, text }); return true; },
      }
    );
    expect(handled).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("ufoo:alice");
    expect(writes[0].text).toContain("hello from alice");
  });

  test("writeMultiPaneBusEvent ignores outbound chat echoes", () => {
    const writes = [];
    writeMultiPaneBusEvent(
      {
        publisher: "chat",
        target: "ufoo:alice",
        source: "rust-multi-window",
        message: "ping",
      },
      {
        agentIds: ["ufoo:alice"],
        writeToPane: (id, text) => { writes.push({ id, text }); return true; },
      }
    );
    expect(writes).toHaveLength(0);
  });

  test("writeMultiPaneBusEvent writes activity markers", () => {
    const writes = [];
    writeMultiPaneBusEvent(
      {
        event: "activity_state_changed",
        publisher: "ufoo:alice",
        state: "working",
        detail: "tool",
      },
      {
        agentIds: ["ufoo:alice"],
        writeToPane: (id, text) => { writes.push(text); return true; },
      }
    );
    expect(writes[0]).toContain("[working");
    expect(writes[0]).toContain("tool");
  });
});

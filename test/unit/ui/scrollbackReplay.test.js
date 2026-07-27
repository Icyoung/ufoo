"use strict";

const {
  replayScrollbackEvents,
  DEFAULT_CAP,
} = require("../../../src/ui/scrollbackReplay");

describe("scrollbackReplay", () => {
  test("replays snapshot + append + stream delta with cap eviction", () => {
    const events = [
      {
        name: "app.snapshot",
        payload: {
          entries: [
            { id: "a", kind: "user", text: "hi" },
            { id: "b", kind: "assistant", text: "yo" },
          ],
        },
      },
      { name: "transcript.append", payload: { id: "c", kind: "system", text: "note" } },
      { name: "stream.delta", payload: { id: "b", text: "!" } },
    ];
    const state = replayScrollbackEvents(events, { cap: DEFAULT_CAP });
    expect(state.entries).toHaveLength(3);
    expect(state.entries[1].text).toBe("yo!");
  });

  test("evicts oldest entries beyond cap", () => {
    const events = [];
    for (let i = 0; i < 10; i += 1) {
      events.push({
        name: "transcript.append",
        payload: { id: `e${i}`, text: `t${i}` },
      });
    }
    const state = replayScrollbackEvents(events, { cap: 3 });
    expect(state.entries).toHaveLength(3);
    expect(state.entries[0].id).toBe("e7");
    expect(state.entries[2].id).toBe("e9");
  });
});

const { parseInputMessage } = require("../../../src/agent/ptyRunner");

describe("agent ptyRunner input parsing", () => {
  test("drops stream envelopes instead of injecting them as prompts", () => {
    expect(parseInputMessage(JSON.stringify({ stream: true, delta: "Working" }))).toBeNull();
    expect(parseInputMessage(JSON.stringify({ stream: true, done: true, reason: "idle" }))).toBeNull();
  });

  test("keeps raw, text, and plain messages consumable", () => {
    expect(parseInputMessage(JSON.stringify({ raw: true, data: "\u001b[A" }))).toEqual({
      raw: true,
      text: "\u001b[A",
    });
    expect(parseInputMessage(JSON.stringify({ text: "do work" }))).toEqual({
      raw: false,
      text: "do work",
    });
    expect(parseInputMessage("plain task")).toEqual({
      raw: false,
      text: "plain task",
    });
  });
});

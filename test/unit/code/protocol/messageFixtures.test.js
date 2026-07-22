"use strict";

const fs = require("fs");
const path = require("path");
const {
  materializeFromFixtureDef,
  materializeOpenAiMessages,
  materializeAnthropicMessages,
} = require("../../../../src/code/protocol/messageFixtures");

const FIXTURES = path.join(__dirname, "../../../fixtures/protocol");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

describe("messageFixtures", () => {
  test("openai parallel tools golden", () => {
    const fixture = loadFixture("openai-parallel-tools.json");
    const messages = materializeFromFixtureDef(fixture);
    expect(messages).toEqual(fixture.expectedMessages);
  });

  test("anthropic parallel tools golden", () => {
    const fixture = loadFixture("anthropic-parallel-tools.json");
    const messages = materializeFromFixtureDef(fixture);
    expect(messages).toEqual(fixture.expectedMessages);
  });

  test("openai mixed reject materializes contiguous tool results", () => {
    const fixture = loadFixture("openai-mixed-plan-data-reject.json");
    const messages = materializeOpenAiMessages({
      calls: fixture.calls,
      results: fixture.results,
      assistantText: null,
    });
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].tool_calls).toHaveLength(2);
    expect(messages.slice(1).every((m) => m.role === "tool")).toBe(true);
    expect(messages).toHaveLength(3);
  });

  test("anthropic results flush as single user tool_result array", () => {
    const messages = materializeAnthropicMessages({
      calls: [{ callId: "t1", name: "read", args: { path: "a" } }],
      results: [{ callId: "t1", content: { ok: true }, isError: false }],
    });
    expect(messages[1].role).toBe("user");
    expect(messages[1].content[0].type).toBe("tool_result");
  });
});

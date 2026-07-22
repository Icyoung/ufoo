"use strict";

const {
  LOOP_EVENT_TYPES,
  createLoopEvent,
  createLoopEventLog,
  resolveSummaryDisplayPolicy,
} = require("../../../../src/code/protocol/loopEvents");

describe("loopEvents (R8)", () => {
  test("creates ordered events with sequence and replay", () => {
    const log = createLoopEventLog({ sessionId: "s1", runId: "r1" });
    log.push("assistant_delta", { text: "Hello" });
    log.push("tool_start", { tool: "read" });
    log.push("final_summary", { text: "done" });
    expect(log.sequence).toBe(3);
    expect(log.list().map((e) => e.type)).toEqual([
      "assistant_delta",
      "tool_start",
      "final_summary",
    ]);
    expect(log.replayFrom(1)).toHaveLength(2);
    expect(LOOP_EVENT_TYPES).toContain("final_assistant_message");
  });

  test("summary display policy skips echo when streamed visible", () => {
    expect(resolveSummaryDisplayPolicy({
      streamed: true,
      sawVisibleText: true,
    })).toEqual({ echoSummary: false, reason: "already_streamed" });
    expect(resolveSummaryDisplayPolicy({
      streamed: false,
      sawVisibleText: false,
    }).echoSummary).toBe(true);
    expect(resolveSummaryDisplayPolicy({
      streamed: true,
      sawVisibleText: true,
      finalEventType: "final_summary",
    }).echoSummary).toBe(true);
  });

  test("rejects unknown event types", () => {
    expect(() => createLoopEvent("not_a_real_event", {})).toThrow(/unknown loop event/);
  });
});

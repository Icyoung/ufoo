const { formatLoopSummary } = require("../../../src/ui/format/loopSummary");

describe("runtime loop summary", () => {
  test("renders usage and validated tool counts", () => {
    expect(formatLoopSummary({ rounds: 2, tool_calls: 1, total_tokens: 165, input_tokens: 30,
      cache_read_tokens: 10, cache_creation_tokens: 5, terminal_reason: "final_answer", tools: [{ name: "dispatch_message", count: 1 }] }))
      .toBe("r2 tc1 tok165 cache10/5(25%) dispatch_messagex1 final_answer");
    expect(formatLoopSummary({ rounds: 1, total_tokens: 50, cache_creation_tokens: 5 })).toBe("r1 tc0 tok50 cache0/5");
    expect(formatLoopSummary(null)).toBe("");
  });
});

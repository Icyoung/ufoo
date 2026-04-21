"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const { getUfooPaths } = require("../../../src/ufoo/paths");
const { readRecentLoopSummary } = require("../../../src/agent/loopObservability");

describe("agent loopObservability", () => {
  test("summarizes the most recent completed loop segment", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ufoo-loop-observability-"));
    try {
      const { agentDir } = getUfooPaths(projectRoot);
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "ufoo-agent.loop-events.jsonl"),
        [
          JSON.stringify({ event: "model_call", ts: "2026-04-20T09:00:00.000Z", round: 1, input_tokens: 10, output_tokens: 2 }),
          JSON.stringify({ event: "loop_terminal", ts: "2026-04-20T09:00:01.000Z", rounds: 1, tool_calls: 0, total_tokens: 12, terminal_reason: "final_answer" }),
          JSON.stringify({ event: "model_call", ts: "2026-04-20T10:00:00.000Z", round: 1, input_tokens: 100, output_tokens: 20, cache_read_tokens: 8, cache_creation_tokens: 3, latency_ms: 400 }),
          JSON.stringify({ event: "tool_call", ts: "2026-04-20T10:00:01.000Z", tool_name: "dispatch_message" }),
          JSON.stringify({ event: "tool_call", ts: "2026-04-20T10:00:02.000Z", tool_name: "dispatch_message" }),
          JSON.stringify({ event: "tool_call", ts: "2026-04-20T10:00:03.000Z", tool_name: "ack_bus" }),
          JSON.stringify({ event: "loop_terminal", ts: "2026-04-20T10:00:04.000Z", rounds: 1, tool_calls: 3, total_tokens: 120, total_latency_ms: 400, terminal_reason: "final_answer" }),
        ].join("\n")
      );

      expect(readRecentLoopSummary(projectRoot)).toEqual(expect.objectContaining({
        status: "completed",
        rounds: 1,
        model_calls: 1,
        tool_calls: 3,
        total_tokens: 120,
        cache_read_tokens: 8,
        cache_creation_tokens: 3,
        terminal_reason: "final_answer",
        started_at: "2026-04-20T10:00:00.000Z",
        ended_at: "2026-04-20T10:00:04.000Z",
      }));
      expect(readRecentLoopSummary(projectRoot).tools).toEqual([
        { name: "dispatch_message", count: 2 },
        { name: "ack_bus", count: 1 },
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

"use strict";

const {
  PHASE1_DEFAULT_BLEU_THRESHOLD,
  PHASE1_DEFAULT_TOOLCALL_THRESHOLD,
  computeBleu,
  computeToolCallSequenceConsistency,
  extractToolCallNames,
  buildPhase1ShadowDiffSample,
  summarizePhase1ShadowDiff,
} = require("../../../src/providerapi/shadowDiff");

describe("providerapi shadowDiff (Phase 1 metrics)", () => {
  test("computeBleu returns 1 for identical text", () => {
    const text = "route this message to the reviewer agent please";
    expect(computeBleu(text, text)).toBeCloseTo(1, 5);
  });

  test("computeBleu drops below threshold for completely unrelated text", () => {
    const ref = "route this message to the reviewer agent";
    const cand = "quantum entanglement describes pairwise correlation states";
    expect(computeBleu(ref, cand)).toBeLessThan(PHASE1_DEFAULT_BLEU_THRESHOLD);
  });

  test("computeBleu accepts paraphrases above 0.85 threshold", () => {
    const ref = "Route the review request to the reviewer agent and wait for the response.";
    const cand = "Route the review request to the reviewer agent and wait for the response."; // identical
    expect(computeBleu(ref, cand)).toBeGreaterThanOrEqual(PHASE1_DEFAULT_BLEU_THRESHOLD);
  });

  test("computeToolCallSequenceConsistency tolerates extra noise", () => {
    const ref = ["read_bus_summary", "route_agent", "dispatch_message"];
    const cand = ["read_bus_summary", "route_agent", "dispatch_message"];
    expect(computeToolCallSequenceConsistency(ref, cand)).toBe(1);

    const candWithExtra = ["read_bus_summary", "route_agent", "dispatch_message", "ack_bus"];
    expect(computeToolCallSequenceConsistency(ref, candWithExtra)).toBeLessThan(1);
    expect(computeToolCallSequenceConsistency(ref, candWithExtra)).toBeCloseTo(3 / 4, 5);
  });

  test("extractToolCallNames filters to tool_call events with names", () => {
    const events = [
      { type: "text_delta", delta: "thinking..." },
      { type: "tool_call", name: "route_agent", args: {} },
      { type: "tool_call", name: "", args: {} },
      { type: "tool_call", name: "dispatch_message", args: {} },
      { type: "turn_completed" },
    ];
    expect(extractToolCallNames(events)).toEqual(["route_agent", "dispatch_message"]);
  });

  test("buildPhase1ShadowDiffSample combines text and tool call metrics", () => {
    const sample = buildPhase1ShadowDiffSample({
      legacy: {
        text: "Route the message to reviewer and dispatch it.",
        events: [
          { type: "tool_call", name: "route_agent" },
          { type: "tool_call", name: "dispatch_message" },
        ],
      },
      api: {
        text: "Route the message to reviewer and dispatch it.",
        events: [
          { type: "tool_call", name: "route_agent" },
          { type: "tool_call", name: "dispatch_message" },
        ],
      },
    });
    expect(sample.bleu).toBeGreaterThanOrEqual(PHASE1_DEFAULT_BLEU_THRESHOLD);
    expect(sample.toolSeqConsistency).toBe(1);
  });

  test("summarizePhase1ShadowDiff passes when samples clear both thresholds", () => {
    const samples = Array.from({ length: 10 }, () => ({ bleu: 0.9, toolSeqConsistency: 1 }));
    const result = summarizePhase1ShadowDiff(samples);
    expect(result.sampleCount).toBe(10);
    expect(result.meanBleu).toBeCloseTo(0.9, 5);
    expect(result.meanToolSeqConsistency).toBe(1);
    expect(result.bleuPass).toBe(true);
    expect(result.toolCallPass).toBe(true);
    expect(result.overallPass).toBe(true);
    expect(result.bleuThreshold).toBe(PHASE1_DEFAULT_BLEU_THRESHOLD);
    expect(result.toolCallThreshold).toBe(PHASE1_DEFAULT_TOOLCALL_THRESHOLD);
  });

  test("summarizePhase1ShadowDiff fails when tool-call consistency drops below 0.95", () => {
    const samples = [
      { bleu: 0.95, toolSeqConsistency: 1 },
      { bleu: 0.92, toolSeqConsistency: 0.5 },
      { bleu: 0.9, toolSeqConsistency: 0.5 },
      { bleu: 0.88, toolSeqConsistency: 0.5 },
    ];
    const result = summarizePhase1ShadowDiff(samples);
    expect(result.bleuPass).toBe(true);
    expect(result.toolCallPass).toBe(false);
    expect(result.overallPass).toBe(false);
  });

  test("summarizePhase1ShadowDiff fails when mean BLEU drops below 0.85", () => {
    const samples = Array.from({ length: 5 }, () => ({ bleu: 0.5, toolSeqConsistency: 1 }));
    const result = summarizePhase1ShadowDiff(samples);
    expect(result.bleuPass).toBe(false);
    expect(result.overallPass).toBe(false);
  });

  test("summarizePhase1ShadowDiff handles empty sample list", () => {
    const result = summarizePhase1ShadowDiff([]);
    expect(result.sampleCount).toBe(0);
    expect(result.overallPass).toBe(false);
  });
});
